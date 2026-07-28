import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  pipelineCases,
  pipelineGraphRunEvents,
  pipelineGraphRuns,
  pipelineGraphVersions,
  pipelineStages,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { PipelineGraphVersionActor } from "./pipeline-graph-versions.js";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function requestHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function actorId(actor: PipelineGraphVersionActor) {
  return actor.type === "user" ? actor.userId : actor.agentId;
}

export function pipelineGraphRunService(db: Db) {
  return {
    async start(input: {
      companyId: string;
      caseId: string;
      idempotencyKey: string;
      checkpoint?: Record<string, unknown>;
      actor: PipelineGraphVersionActor;
    }) {
      const hash = requestHash({
        operation: "start",
        caseId: input.caseId,
        checkpoint: input.checkpoint ?? {},
      });
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${
            "pipeline-graph-run:start-key:" + input.companyId + ":" + input.idempotencyKey
          }, 0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"pipeline-graph-run:case:" + input.caseId}, 0))`,
        );
        const replay = await tx
          .select()
          .from(pipelineGraphRuns)
          .where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.startIdempotencyKey, input.idempotencyKey),
          ))
          .then((rows) => rows[0] ?? null);
        if (replay) {
          const event = await tx
            .select()
            .from(pipelineGraphRunEvents)
            .where(and(
              eq(pipelineGraphRunEvents.runId, replay.id),
              eq(pipelineGraphRunEvents.sequence, 1),
            ))
            .then((rows) => rows[0] ?? null);
          if (!event || event.requestHash !== hash) {
            throw conflict("Graph run idempotency key was reused with a different request", {
              code: "graph_run_idempotency_conflict",
            });
          }
          return { created: false as const, run: replay, event };
        }

        const row = await tx
          .select({
            case: pipelineCases,
            stageKey: pipelineStages.key,
            graphVersion: pipelineGraphVersions,
          })
          .from(pipelineCases)
          .innerJoin(
            pipelineStages,
            and(
              eq(pipelineStages.pipelineId, pipelineCases.pipelineId),
              eq(pipelineStages.id, pipelineCases.stageId),
            ),
          )
          .innerJoin(
            pipelineGraphVersions,
            and(
              eq(pipelineGraphVersions.companyId, pipelineCases.companyId),
              eq(pipelineGraphVersions.pipelineId, pipelineCases.pipelineId),
              eq(pipelineGraphVersions.id, pipelineCases.graphVersionId),
            ),
          )
          .where(and(
            eq(pipelineCases.companyId, input.companyId),
            eq(pipelineCases.id, input.caseId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Pinned pipeline case not found");
        if (row.case.terminalKind) {
          throw unprocessable("Terminal pipeline cases cannot start graph runs", {
            code: "graph_run_case_terminal",
          });
        }
        if (!row.graphVersion.definition.nodes.some((node) => node.key === row.stageKey)) {
          throw unprocessable("Case stage is not present in its pinned graph version", {
            code: "graph_run_stage_not_pinned",
          });
        }
        const active = await tx
          .select({ id: pipelineGraphRuns.id })
          .from(pipelineGraphRuns)
          .where(and(
            eq(pipelineGraphRuns.caseId, input.caseId),
            sql`${pipelineGraphRuns.status} in ('running', 'paused')`,
          ))
          .then((rows) => rows[0] ?? null);
        if (active) {
          throw conflict("Pipeline case already has an active graph run", {
            code: "graph_run_already_active",
            runId: active.id,
          });
        }

        const [run] = await tx
          .insert(pipelineGraphRuns)
          .values({
            companyId: input.companyId,
            pipelineId: row.case.pipelineId,
            graphVersionId: row.graphVersion.id,
            caseId: row.case.id,
            startIdempotencyKey: input.idempotencyKey,
            currentNodeKey: row.stageKey,
            checkpoint: input.checkpoint ?? {},
            startedByType: input.actor.type,
            startedById: actorId(input.actor),
          })
          .returning();
        const [event] = await tx
          .insert(pipelineGraphRunEvents)
          .values({
            companyId: input.companyId,
            runId: run!.id,
            sequence: 1,
            type: "run_started",
            nodeKey: row.stageKey,
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            payload: {
              graphVersionId: row.graphVersion.id,
              graphVersion: row.graphVersion.version,
              caseVersion: row.case.version,
            },
          })
          .returning();
        return { created: true as const, run: run!, event: event! };
      });
    },

    async checkpoint(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      idempotencyKey: string;
      checkpoint: Record<string, unknown>;
    }) {
      const hash = requestHash({
        operation: "checkpoint",
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        checkpoint: input.checkpoint,
      });
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"pipeline-graph-run:" + input.runId}, 0))`,
        );
        const replay = await tx
          .select()
          .from(pipelineGraphRunEvents)
          .where(and(
            eq(pipelineGraphRunEvents.companyId, input.companyId),
            eq(pipelineGraphRunEvents.runId, input.runId),
            eq(pipelineGraphRunEvents.idempotencyKey, input.idempotencyKey),
          ))
          .then((rows) => rows[0] ?? null);
        if (replay) {
          if (replay.requestHash !== hash) {
            throw conflict("Graph event idempotency key was reused with a different request", {
              code: "graph_event_idempotency_conflict",
            });
          }
          const run = await tx
            .select()
            .from(pipelineGraphRuns)
            .where(and(
              eq(pipelineGraphRuns.companyId, input.companyId),
              eq(pipelineGraphRuns.id, input.runId),
            ))
            .then((rows) => rows[0] ?? null);
          if (!run) throw notFound("Graph run not found");
          return {
            changed: false as const,
            run,
            event: replay,
            committed: {
              revision: replay.payload.revision as number,
              checkpoint: replay.payload.checkpoint as Record<string, unknown>,
            },
          };
        }

        const run = await tx
          .select()
          .from(pipelineGraphRuns)
          .where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.id, input.runId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!run) throw notFound("Graph run not found");
        if (run.status !== "running") {
          throw unprocessable("Only running graph runs accept checkpoints", {
            code: "graph_run_not_running",
            status: run.status,
          });
        }
        if (run.revision !== input.expectedRevision) {
          throw conflict("Graph run changed", {
            code: "graph_run_revision_conflict",
            expectedRevision: input.expectedRevision,
            currentRevision: run.revision,
          });
        }
        const now = new Date();
        const [updated] = await tx
          .update(pipelineGraphRuns)
          .set({
            checkpoint: input.checkpoint,
            revision: run.revision + 1,
            nextEventSequence: run.nextEventSequence + 1,
            updatedAt: now,
          })
          .where(and(
            eq(pipelineGraphRuns.id, run.id),
            eq(pipelineGraphRuns.revision, input.expectedRevision),
          ))
          .returning();
        if (!updated) {
          throw conflict("Graph run changed", {
            code: "graph_run_revision_conflict",
            expectedRevision: input.expectedRevision,
          });
        }
        const [event] = await tx
          .insert(pipelineGraphRunEvents)
          .values({
            companyId: input.companyId,
            runId: run.id,
            sequence: run.nextEventSequence,
            type: "checkpoint_saved",
            nodeKey: run.currentNodeKey,
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            payload: {
              revision: updated!.revision,
              checkpoint: input.checkpoint,
            },
          })
          .returning();
        return {
          changed: true as const,
          run: updated!,
          event: event!,
          committed: {
            revision: updated!.revision,
            checkpoint: input.checkpoint,
          },
        };
      });
    },

    async get(input: { companyId: string; runId: string }) {
      const run = await db
        .select()
        .from(pipelineGraphRuns)
        .where(and(
          eq(pipelineGraphRuns.companyId, input.companyId),
          eq(pipelineGraphRuns.id, input.runId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!run) throw notFound("Graph run not found");
      return run;
    },

    async listEvents(input: { companyId: string; runId: string }) {
      await this.get(input);
      return db
        .select()
        .from(pipelineGraphRunEvents)
        .where(and(
          eq(pipelineGraphRunEvents.companyId, input.companyId),
          eq(pipelineGraphRunEvents.runId, input.runId),
        ))
        .orderBy(asc(pipelineGraphRunEvents.sequence));
    },
  };
}
