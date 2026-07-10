import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1_000;
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked_pending_human", "blocked"] as const;
const STALE_COMMENT = "auto-closed: routine execution stale >48h, no terminal transition";

export async function closeStaleRoutineExecutionIssues(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stale = await db
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(
      and(
        eq(issues.originKind, "routine_execution"),
        inArray(issues.status, [...OPEN_STATUSES]),
        lt(issues.createdAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;

  const now = new Date();
  const ids = stale.map((r) => r.id);

  await db
    .update(issues)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(inArray(issues.id, ids));

  await db.insert(issueComments).values(
    stale.map((r) => ({
      id: randomUUID(),
      companyId: r.companyId,
      issueId: r.id,
      body: STALE_COMMENT,
    })),
  );

  logger.info({ count: stale.length }, "Auto-closed stale routine execution issues");
  return stale.length;
}

export async function clearResolvedIssueBlockers(db: Db): Promise<number> {
  const cleared = await issueService(db).clearResolvedBlockedIssues();
  if (cleared.length > 0) {
    logger.info({ count: cleared.length }, "Auto-unblocked issues with resolved blockers");
  }
  return cleared.length;
}

export function startRoutineExecutionSweep(
  db: Db,
  intervalMs: number = 60 * 60 * 1_000,
): () => void {
  const timer = setInterval(() => {
    closeStaleRoutineExecutionIssues(db).catch((err) => {
      logger.warn({ err }, "Routine execution sweep failed");
    });
    clearResolvedIssueBlockers(db).catch((err) => {
      logger.warn({ err }, "Resolved issue blocker sweep failed");
    });
  }, intervalMs);

  closeStaleRoutineExecutionIssues(db).catch((err) => {
    logger.warn({ err }, "Initial routine execution sweep failed");
  });
  clearResolvedIssueBlockers(db).catch((err) => {
    logger.warn({ err }, "Initial resolved issue blocker sweep failed");
  });

  return () => clearInterval(timer);
}
