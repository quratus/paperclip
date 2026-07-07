export type GateReversibility = "reversible" | "irreversible";
export type GateImpact = "low" | "high";
export type GateDecision = "ungated" | "auto_clearing" | "batched_escalate";

export type WaitCondition =
  | { kind: "schedule"; fireAt: string }
  | { kind: "internal"; blockingIssueId: string };

export interface ClassifyGateInput {
  reversibility: GateReversibility | null | undefined;
  impact: GateImpact | null | undefined;
  waitCondition?: string | null;
}

/**
 * Deterministic classification of whether a loop-engine action needs a human.
 *
 * Matrix:
 *   irreversible + high impact                    → batched_escalate (true one-way door)
 *   otherwise, if waitCondition is supplied       → auto_clearing
 *   otherwise                                     → ungated
 */
export function classifyGate(input: ClassifyGateInput): GateDecision {
  if (input.reversibility === "irreversible" && input.impact === "high") {
    return "batched_escalate";
  }
  if (input.waitCondition != null && input.waitCondition !== "") {
    return "auto_clearing";
  }
  return "ungated";
}
