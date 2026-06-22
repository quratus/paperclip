import type { Db } from "@paperclipai/db";
import { issues as issuesTable, issueComments, labels, issueLabels } from "@paperclipai/db";
import { and, eq, ilike, inArray, isNull, or } from "drizzle-orm";

export type NeedsJuliusReason = "mention" | "parked" | "blocked" | "labeled";

export type NeedsJuliusItem = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  triggerAt: string;
  reason: NeedsJuliusReason;
  commentId: string | null;
  snippet: string | null;
};

const PARKED_STATUSES = ["in_review", "blocked"] as const;
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const SNIPPET_MAX = 140;

function ownerHandle(ownerUserId: string): string {
  const at = ownerUserId.indexOf("@");
  return at > 0 ? ownerUserId.slice(0, at) : ownerUserId;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function snippetFromBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX - 1)}…` : collapsed;
}

/**
 * Deterministic v1 detection of issues waiting on the board owner (Julius).
 * Owner identity is resolved from the authenticated board user — never hardcoded.
 * Relation joins (blocks chain) are intentionally skipped for v1; branch 3 uses
 * assignee + latest-comment mention only.
 */
export async function needsJulius(
  db: Db,
  companyId: string,
  ownerUserId: string,
): Promise<NeedsJuliusItem[]> {
  const handle = ownerHandle(ownerUserId);
  const tokens = Array.from(new Set([`@${handle}`, ownerUserId])).filter(Boolean);
  if (tokens.length === 0) return [];
  const mentionFilter = or(...tokens.map((t) => ilike(issueComments.body, `%${escapeLike(t)}%`)));

  // Phase 0 — build labelAppliedAt map from the "needs-julius" label.
  const labelAppliedAt = new Map<string, Date>();
  const labelRow = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), eq(labels.name, "needs-julius")))
    .limit(1);
  const njLabelId = labelRow[0]?.id ?? null;
  if (njLabelId) {
    const labelRows = await db
      .select({ issueId: issueLabels.issueId, createdAt: issueLabels.createdAt })
      .from(issueLabels)
      .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, njLabelId)));
    for (const r of labelRows) labelAppliedAt.set(r.issueId, r.createdAt);
  }

  // Phase 1 — discover candidate issues (assignee-parked + any mention of owner).
  const assigneeRows = await db
    .select()
    .from(issuesTable)
    .where(
      and(
        eq(issuesTable.companyId, companyId),
        eq(issuesTable.assigneeUserId, ownerUserId),
        inArray(issuesTable.status, [...PARKED_STATUSES]),
        isNull(issuesTable.hiddenAt),
      ),
    );

  const mentionIssueIdRows = await db
    .selectDistinctOn([issueComments.issueId], { issueId: issueComments.issueId })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), mentionFilter));

  const candidateRows = [...assigneeRows];
  const seenIds = new Set(assigneeRows.map((r) => r.id));
  const missingMentionIds = mentionIssueIdRows.map((r) => r.issueId).filter((id) => !seenIds.has(id));
  if (missingMentionIds.length > 0) {
    const mentionRows = await db
      .select()
      .from(issuesTable)
      .where(
        and(
          eq(issuesTable.companyId, companyId),
          inArray(issuesTable.id, missingMentionIds),
          isNull(issuesTable.hiddenAt),
        ),
      );
    candidateRows.push(...mentionRows);
  }

  const labelOnlyIds = [...labelAppliedAt.keys()].filter((id) => !seenIds.has(id));
  if (labelOnlyIds.length > 0) {
    const labeledIssues = await db
      .select()
      .from(issuesTable)
      .where(and(eq(issuesTable.companyId, companyId), inArray(issuesTable.id, labelOnlyIds), isNull(issuesTable.hiddenAt)));
    candidateRows.push(...labeledIssues);
    labelOnlyIds.forEach((id) => seenIds.add(id));
  }

  if (candidateRows.length === 0) return [];
  const candidateIds = candidateRows.map((r) => r.id);

  // Phase 2 — load comments for candidates; derive latest comment + latest owner reply per issue.
  const commentRows = await db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      body: issueComments.body,
      authorUserId: issueComments.authorUserId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, candidateIds)));

  type Latest = { id: string; body: string; authorUserId: string | null; createdAt: Date };
  const latestComment = new Map<string, Latest>();
  const latestOwnerReplyAt = new Map<string, Date>();
  for (const c of commentRows) {
    const prev = latestComment.get(c.issueId);
    if (!prev || c.createdAt > prev.createdAt) {
      latestComment.set(c.issueId, { id: c.id, body: c.body, authorUserId: c.authorUserId, createdAt: c.createdAt });
    }
    if (c.authorUserId === ownerUserId) {
      const prevOwner = latestOwnerReplyAt.get(c.issueId);
      if (!prevOwner || c.createdAt > prevOwner) latestOwnerReplyAt.set(c.issueId, c.createdAt);
    }
  }

  const lowerTokens = tokens.map((t) => t.toLowerCase());
  const mentionsOwner = (body: string) => {
    const b = body.toLowerCase();
    return lowerTokens.some((t) => b.includes(t));
  };

  type Branch = { reason: NeedsJuliusReason; triggerAt: Date; commentId: string | null; snippet: string | null };
  const items: NeedsJuliusItem[] = [];
  for (const issue of candidateRows) {
    if (TERMINAL_STATUSES.has(issue.status)) continue;
    const lc = latestComment.get(issue.id) ?? null;
    const ownerMentionedLatest = !!lc && lc.authorUserId !== ownerUserId && mentionsOwner(lc.body);
    const branches: Branch[] = [];

    if (lc && ownerMentionedLatest) {
      branches.push({ reason: "mention", triggerAt: lc.createdAt, commentId: lc.id, snippet: snippetFromBody(lc.body) });
    }
    if (issue.assigneeUserId === ownerUserId && (PARKED_STATUSES as readonly string[]).includes(issue.status)) {
      branches.push({ reason: "parked", triggerAt: issue.updatedAt, commentId: null, snippet: null });
    }
    if (issue.status === "blocked" && (issue.assigneeUserId === ownerUserId || ownerMentionedLatest)) {
      branches.push({
        reason: "blocked",
        triggerAt: lc ? lc.createdAt : issue.updatedAt,
        commentId: lc ? lc.id : null,
        snippet: lc ? snippetFromBody(lc.body) : null,
      });
    }
    if (labelAppliedAt.has(issue.id)) {
      branches.push({
        reason: "labeled",
        triggerAt: labelAppliedAt.get(issue.id)!,
        commentId: null,
        snippet: null,
      });
    }
    if (branches.length === 0) continue;

    // Dedup by issue: keep the branch with the oldest (most overdue) triggerAt.
    branches.sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime());
    const chosen = branches[0];

    // Resolved filter: drop if the owner has replied at or after the trigger.
    const ownerReply = latestOwnerReplyAt.get(issue.id);
    if (ownerReply && ownerReply.getTime() >= chosen.triggerAt.getTime()) continue;

    items.push({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      triggerAt: chosen.triggerAt.toISOString(),
      reason: chosen.reason,
      commentId: chosen.commentId,
      snippet: chosen.snippet,
    });
  }

  items.sort((a, b) => new Date(a.triggerAt).getTime() - new Date(b.triggerAt).getTime());
  return items;
}
