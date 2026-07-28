import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { invites } from "@paperclipai/db";
import { createShowroomSchema, showroomFeedbackSchema } from "@paperclipai/shared";
import { badRequest, notFound, tooManyRequests } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { issueService, logActivity } from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { redactSensitiveText } from "../redaction.js";

const SHOWROOM_INVITE_TYPE = "showroom_review";
const SHOWROOM_TOKEN_PREFIX = "pcp_showroom_";
const MAX_SCREENSHOT_BYTES = 640 * 1024;
const MAX_SUBMISSIONS_PER_MINUTE = 12;

type ShowroomPayload = {
  title: string;
  targetUrl: string;
  projectId: string | null;
};

type ShowroomInvite = {
  id: string;
  companyId: string | null;
  defaultsPayload: Record<string, unknown> | null;
  expiresAt: Date;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createShowroomToken() {
  return `${SHOWROOM_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function requestBaseUrl(req: { header(name: string): string | undefined; protocol: string }) {
  const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  return host ? `${proto}://${host}` : "";
}

function showroomPayload(value: Record<string, unknown> | null): ShowroomPayload | null {
  if (!value || typeof value.title !== "string" || typeof value.targetUrl !== "string") return null;
  return {
    title: value.title,
    targetUrl: value.targetUrl,
    projectId: typeof value.projectId === "string" ? value.projectId : null,
  };
}

function safeRoute(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`.slice(0, 2_000);
  } catch {
    return value.slice(0, 2_000);
  }
}

function decodePng(dataUrl: string | undefined) {
  if (!dataUrl) return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw badRequest("Screenshot must be a PNG data URL");
  const image = Buffer.from(match[1], "base64");
  if (image.length === 0 || image.length > MAX_SCREENSHOT_BYTES) {
    throw badRequest(`Screenshot must be at most ${MAX_SCREENSHOT_BYTES} bytes`);
  }
  return image;
}

function feedbackBody(input: {
  text: string;
  reporterName?: string;
  viewport: { width: number; height: number };
  context?: { screen?: string; section?: string; sourceIssueId?: string };
}, payload: ShowroomPayload, route: string | null, hasScreenshot: boolean) {
  return [
    "## Showroom feedback",
    "",
    redactSensitiveText(input.text).trim(),
    "",
    "## Context",
    `- Showroom: ${payload.title}`,
    `- Target: ${payload.targetUrl}`,
    `- Route: ${route ?? "not supplied"}`,
    `- Screen: ${input.context?.screen ?? "not supplied"}`,
    `- Section: ${input.context?.section ?? "not supplied"}`,
    `- Suggested work item: ${input.context?.sourceIssueId ?? "not supplied"}`,
    `- Viewport: ${input.viewport.width}×${input.viewport.height}`,
    `- Reviewer: ${input.reporterName ? redactSensitiveText(input.reporterName).trim() : "anonymous collaborator"}`,
    `- Screenshot: ${hasScreenshot ? "attached" : "not requested"}`,
  ].join("\n");
}

/** Small per-process abuse brake for public review links. Durable token and issue
 * idempotency are DB-backed; this only prevents a single browser from flooding a link. */
const submissionWindows = new Map<string, { startedAt: number; count: number }>();
function assertSubmissionRate(tokenHash: string, ip: string | undefined) {
  const key = `${tokenHash}:${ip ?? "unknown"}`;
  const now = Date.now();
  const current = submissionWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    submissionWindows.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= MAX_SUBMISSIONS_PER_MINUTE) throw tooManyRequests("Too many showroom feedback submissions");
  current.count += 1;
}

async function resolveShowroom(db: Db, token: string): Promise<ShowroomInvite> {
  const row = await db
    .select({ id: invites.id, companyId: invites.companyId, defaultsPayload: invites.defaultsPayload, expiresAt: invites.expiresAt })
    .from(invites)
    .where(and(
      eq(invites.inviteType, SHOWROOM_INVITE_TYPE),
      eq(invites.tokenHash, hashToken(token)),
      isNull(invites.revokedAt),
      gt(invites.expiresAt, new Date()),
    ))
    .then((rows) => rows[0] ?? null);
  if (!row || !row.companyId || !showroomPayload(row.defaultsPayload)) throw notFound("Showroom link not found");
  return row;
}

export function showroomRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const issues = issueService(db);

  router.post("/companies/:companyId/showrooms", validate(createShowroomSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = req.body;
    const token = createShowroomToken();
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1_000);
    const [showroom] = await db.insert(invites).values({
      companyId,
      inviteType: SHOWROOM_INVITE_TYPE,
      tokenHash: hashToken(token),
      expiresAt,
      invitedByUserId: req.actor?.type === "user" ? req.actor.userId ?? null : null,
      defaultsPayload: { title: input.title, targetUrl: input.targetUrl, projectId: input.projectId ?? null },
    }).returning({ id: invites.id, expiresAt: invites.expiresAt });
    const baseUrl = requestBaseUrl(req);
    res.status(201).location(`/api/showrooms/${token}`).json({
      id: showroom.id,
      expiresAt: showroom.expiresAt,
      url: `${baseUrl}/showroom/${encodeURIComponent(token)}`,
    });
  });

  router.get("/showrooms/:token", async (req, res) => {
    const showroom = await resolveShowroom(db, req.params.token as string);
    const payload = showroomPayload(showroom.defaultsPayload)!;
    res.json({ title: payload.title, targetUrl: payload.targetUrl, expiresAt: showroom.expiresAt });
  });

  router.post("/showrooms/:token/feedback", validate(showroomFeedbackSchema), async (req, res) => {
    const token = req.params.token as string;
    const tokenHash = hashToken(token);
    assertSubmissionRate(tokenHash, req.ip);
    const showroom = await resolveShowroom(db, token);
    const payload = showroomPayload(showroom.defaultsPayload)!;
    const input = req.body;
    const screenshot = decodePng(input.screenshotDataUrl);
    const cleanedText = redactSensitiveText(input.text).trim();
    const route = safeRoute(input.route);
    const originId = `${showroom.id}:${input.submissionId}`;
    const context = input.context;
    const candidate = context?.sourceIssueId ? await issues.getById(context.sourceIssueId) : null;
    const routedIssue = candidate?.companyId === showroom.companyId ? candidate : null;
    const body = feedbackBody(input, payload, route, Boolean(screenshot));
    let issue;
    let routed = false;
    let reopened = false;
    let issueCommentId: string | null = null;

    if (routedIssue) {
      issue = routedIssue;
      routed = true;
      if (routedIssue.status === "done" || routedIssue.status === "cancelled") {
        issue = await issues.update(routedIssue.id, { status: "todo" }) ?? routedIssue;
        reopened = issue.status === "todo";
      }
      const comment = await issues.addComment(issue.id, body, {}, {
        authorType: "system",
        metadata: { source: "showroom_feedback", sourceIssueId: originId },
      });
      issueCommentId = comment.id;
    } else {
      issue = await issues.create(showroom.companyId!, {
        title: `Showroom feedback: ${cleanedText.replace(/\s+/g, " ").slice(0, 96)}`,
        description: body,
        status: "backlog",
        priority: "medium",
        projectId: payload.projectId,
        originKind: "external:showroom:feedback",
        externalSource: {
          originKind: "external:showroom:feedback",
          originId,
          fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
          payloadFingerprint: null,
          sourceRef: { namespace: "showroom", kind: "feedback", id: originId },
        },
      });
    }

    if (screenshot) {
      const stored = await storage.putFile({
        companyId: showroom.companyId!,
        namespace: `issues/${issue.id}/showroom-feedback`,
        originalFilename: "showroom-feedback.png",
        contentType: "image/png",
        body: screenshot,
      });
      await issues.createAttachment({
        issueId: issue.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        issueCommentId,
      });
    }

    await logActivity(db, {
      companyId: showroom.companyId!,
      actorType: "system",
      actorId: `showroom:${showroom.id}`,
      action: routed ? "showroom.feedback_routed" : "showroom.feedback_triage_created",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: { route, hasScreenshot: Boolean(screenshot), showroomTitle: payload.title, routed, reopened, screen: context?.screen ?? null, section: context?.section ?? null },
    });
    res.status(201).location(`/api/issues/${issue.id}`).json({ id: issue.id, identifier: issue.identifier, routed, reopened });
  });

  return router;
}
