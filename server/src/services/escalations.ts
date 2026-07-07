import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issues } from "@paperclipai/db";
import { classifyGate, type ClassifyGateInput, type GateDecision, type WaitCondition } from "@paperclipai/shared";

export interface CreateEscalationInput extends Omit<ClassifyGateInput, "waitCondition"> {
  companyId: string;
  requestedByAgentId?: string | null;
  actionKind: string;
  waitCondition?: WaitCondition | null;
}

export interface EscalationResult {
  gateState: GateDecision;
  approvalId: string | null;
}

export interface SweepResult {
  cleared: number;
}

/**
 * Classify whether a loop-engine action needs human approval, and if so, insert
 * an approvals row. Returns the computed gateState and the created approvalId
 * (null when ungated — no row is created).
 */
export async function createEscalation(
  db: Db,
  input: CreateEscalationInput,
): Promise<EscalationResult> {
  const gateState = classifyGate({
    reversibility: input.reversibility,
    impact: input.impact,
    waitCondition: input.waitCondition != null ? "present" : null,
  });

  if (gateState === "ungated") {
    return { gateState, approvalId: null };
  }

  const [row] = await db
    .insert(approvals)
    .values({
      companyId: input.companyId,
      type: "loop_action",
      requestedByAgentId: input.requestedByAgentId ?? null,
      status: "pending",
      reversibility: input.reversibility ?? null,
      impact: input.impact ?? null,
      waitCondition: input.waitCondition ?? null,
      payload: {
        actionKind: input.actionKind,
        gateState,
      },
    })
    .returning({ id: approvals.id });

  return { gateState, approvalId: row.id };
}

/**
 * Clear auto_clearing escalations whose wait condition has been satisfied.
 * - schedule: fireAt is in the past (relative to nowIso)
 * - internal: the referenced issue has status='done'
 */
export async function sweepAutoClearing(
  db: Db,
  companyId: string,
  nowIso: string,
): Promise<SweepResult> {
  const pending = await db
    .select({ id: approvals.id, waitCondition: approvals.waitCondition })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.status, "pending"),
        eq(approvals.type, "loop_action"),
      ),
    );

  const toClear: string[] = [];

  const internalRows: { id: string; blockingIssueId: string }[] = [];
  for (const row of pending) {
    const wc = row.waitCondition as WaitCondition | null;
    if (!wc) continue;
    if (wc.kind === "schedule" && wc.fireAt <= nowIso) {
      toClear.push(row.id);
    } else if (wc.kind === "internal") {
      internalRows.push({ id: row.id, blockingIssueId: wc.blockingIssueId });
    }
  }

  if (internalRows.length > 0) {
    const blockingIds = internalRows.map((r) => r.blockingIssueId);
    const doneIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), inArray(issues.id, blockingIds)));
    const doneSet = new Set(doneIssues.map((i) => i.id));
    for (const row of internalRows) {
      if (doneSet.has(row.blockingIssueId)) toClear.push(row.id);
    }
  }

  if (toClear.length === 0) return { cleared: 0 };

  await db.update(approvals).set({ status: "auto_cleared" }).where(inArray(approvals.id, toClear));

  return { cleared: toClear.length };
}
