/**
 * Agent product analytics events.
 *
 * These are stored in heartbeat_run_events with event_type = "analytics.*".
 * The shared base fields (runId, agentId, companyId, timestamp, seq) come from
 * the heartbeat_run_events table; only event-specific payload lives here.
 */

export type AgentAnalyticsEventName =
  | "analytics.agent_run_started"
  | "analytics.task_completed"
  | "analytics.user_correction_submitted";

export interface AgentAnalyticsBasePayload {
  /** Workflow identifier — in Phase 1 this is the project name. */
  workflowType: string;
  /** Human-readable summary of what the user asked for. */
  intentSummary?: string;
  /** Where the run was triggered from. */
  triggerSource: string;
}

export interface AgentRunStartedPayload extends AgentAnalyticsBasePayload {
  /** Trace ID from the engineering trace, when available. */
  traceId?: string;
}

export interface TaskCompletedPayload extends AgentAnalyticsBasePayload {
  status: "completed" | "partial" | "failed" | "cancelled";
  durationMs: number;
  toolCallsTotal?: number;
  toolCallsFailed?: number;
  costUsd?: number;
  outputSummary?: string;
}

export interface UserCorrectionSubmittedPayload extends AgentAnalyticsBasePayload {
  correctionType: "output_edit" | "plan_change" | "tool_override" | "context_clarification" | "task_reopened";
  targetTool?: string;
  severity: "minor" | "major" | "critical";
  description: string;
}

export type AgentAnalyticsEventPayload =
  | AgentRunStartedPayload
  | TaskCompletedPayload
  | UserCorrectionSubmittedPayload;
