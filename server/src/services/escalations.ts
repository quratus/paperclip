import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import { classifyGate, type ClassifyGateInput, type GateDecision } from "@paperclipai/shared";

export interface CreateEscalationInput extends ClassifyGateInput {
  companyId: string;
  requestedByAgentId?: string | null;
  actionKind: string;
}

export interface EscalationResult {
  gateState: GateDecision;
  approvalId: string | null;
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
  const gateState = classifyGate(input);

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
      payload: {
        actionKind: input.actionKind,
        gateState,
        ...(input.waitCondition ? { waitCondition: input.waitCondition } : {}),
      },
    })
    .returning({ id: approvals.id });

  return { gateState, approvalId: row.id };
}
