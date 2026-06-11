import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type {
  AgentAnalyticsEventName,
  AgentAnalyticsEventPayload,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export interface EmitAnalyticsEventInput {
  db: Db;
  run: typeof heartbeatRuns.$inferSelect;
  seq: number;
  eventName: AgentAnalyticsEventName;
  payload: AgentAnalyticsEventPayload;
}

/**
 * Persist a product analytics event into the run timeline.
 *
 * Stored in heartbeat_run_events with event_type = "analytics.*" so the run
 * transcript remains the single source of truth. Failures are logged and
 * swallowed — analytics must never break a run.
 */
export async function emitAnalyticsEvent(input: EmitAnalyticsEventInput): Promise<void> {
  try {
    await input.db.insert(heartbeatRunEvents).values({
      companyId: input.run.companyId,
      runId: input.run.id,
      agentId: input.run.agentId,
      seq: input.seq,
      eventType: input.eventName,
      stream: "system",
      level: "info",
      payload: input.payload as unknown as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn(
      { err, runId: input.run.id, eventName: input.eventName },
      "agent analytics event emission failed; continuing run",
    );
  }
}
