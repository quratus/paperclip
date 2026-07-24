export function itemsOf(body) {
  if (Array.isArray(body)) return body;
  for (const key of ["issues", "items", "data", "approvals"]) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

export function hasTypedExternalBlocker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof value.type === "string" && value.type.trim().length > 0 &&
    typeof value.owner === "string" && value.owner.trim().length > 0 &&
    typeof value.recheckDate === "string" && !Number.isNaN(Date.parse(value.recheckDate));
}

export function findBlockedStateRegressions(issues, approvalsById = new Map()) {
  const findings = [];
  for (const issue of issues) {
    if (issue?.status !== "blocked") continue;
    const issueId = issue.id;
    const blockerApproval = issue.blockedByApprovalId
      ? approvalsById.get(issue.blockedByApprovalId) ?? null
      : null;
    const hasIssueBlockers = Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0;
    // A referenced approval is machine-readable even when it is already
    // decided. That is reported separately as a stale blocker, rather than
    // incorrectly doubling it as an untyped row.
    const hasApprovalBlocker = Boolean(issue.blockedByApprovalId);
    const hasExternalBlocker = hasTypedExternalBlocker(issue.blockedByExternal);

    if (!hasIssueBlockers && !hasApprovalBlocker && !hasExternalBlocker) {
      findings.push({
        kind: "untyped_blocked_issue",
        issueId,
        identifier: issue.identifier ?? null,
        title: issue.title ?? null,
      });
    }
    if (blockerApproval?.status === "approved" || blockerApproval?.status === "rejected") {
      findings.push({
        kind: "decided_approval_blocker",
        issueId,
        identifier: issue.identifier ?? null,
        approvalId: blockerApproval.id,
        approvalStatus: blockerApproval.status,
      });
    }
  }
  return findings;
}

function apiBase() {
  const raw = process.env.PAPERCLIP_API_URL;
  if (!raw) throw new Error("PAPERCLIP_API_URL is required");
  return raw.replace(/\/$/, "").replace(/\/api$/, "");
}

async function fetchPaperclip(path) {
  const token = process.env.PAPERCLIP_API_KEY;
  const res = await fetch(`${apiBase()}${path}`, {
    // Local trusted control planes deliberately do not require a token. Hosted
    // environments still send one when PAPERCLIP_API_KEY is configured.
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}: ${text}`);
  return body;
}

export async function runBlockedStateWatchdog(companyId = process.env.PAPERCLIP_COMPANY_ID) {
  if (!companyId) throw new Error("PAPERCLIP_COMPANY_ID is required");
  const blocked = itemsOf(await fetchPaperclip(
    `/api/companies/${encodeURIComponent(companyId)}/issues?status=blocked&includeBlockedBy=true`,
  ));
  const approvalsById = new Map();
  await Promise.all(blocked.map(async (issue) => {
    if (!issue.blockedByApprovalId) return;
    approvalsById.set(
      issue.blockedByApprovalId,
      await fetchPaperclip(`/api/approvals/${encodeURIComponent(issue.blockedByApprovalId)}`),
    );
  }));
  return findBlockedStateRegressions(blocked, approvalsById);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const findings = await runBlockedStateWatchdog();
    if (findings.length === 0) {
      console.log("blocked-state-watchdog: PASS — no untyped blocked rows or decided approval blockers");
      process.exit(0);
    }
    console.error("blocked-state-watchdog: FAIL");
    for (const finding of findings) console.error(JSON.stringify(finding));
    process.exit(1);
  } catch (err) {
    console.error(`blocked-state-watchdog: ERROR — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
import { pathToFileURL } from "node:url";
