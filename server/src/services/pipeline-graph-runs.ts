import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  pipelineCases,
  pipelineAutomationExecutions,
  pipelineGraphRunEvents,
  pipelineGraphRuns,
  pipelineGraphVersions,
  pipelineGraphWakeOutbox,
  pipelineStages,
} from "@paperclipai/db";
import type { PipelineGraphDefinitionV1 } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { PipelineGraphVersionActor } from "./pipeline-graph-versions.js";
import { pipelineService } from "./pipelines.js";

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

function actorEnvelope(actor: PipelineGraphVersionActor) {
  return {
    actorType: actor.type,
    actorId: actorId(actor),
    actorRunId: actor.type === "agent" ? actor.runId : null,
  };
}

type CycleRuntimeState = Record<string, {
  iteration: number;
  noProgressCount: number;
  lastProgressHash: string | null;
}>;

function readProgress(checkpoint: Record<string, unknown>, field: string | null): unknown {
  if (!field) return undefined;
  return field.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, checkpoint);
}

function evolveCycleState(input: {
  definition: PipelineGraphDefinitionV1;
  currentNodeKey: string;
  targetNodeKey: string;
  checkpoint: Record<string, unknown>;
  previous: Record<string, unknown>;
}) {
  const state = structuredClone(input.previous) as CycleRuntimeState;
  let interruption: {
    code: "cycle_iteration_exhausted" | "cycle_no_progress";
    contractKey: string;
    iteration: number;
    noProgressCount: number;
  } | null = null;

  for (const contract of input.definition.cycleContracts) {
    const sourceInside = contract.nodeKeys.includes(input.currentNodeKey);
    const targetInside = contract.nodeKeys.includes(input.targetNodeKey);
    if (!targetInside) continue;
    const externalEntryNodes = contract.nodeKeys.filter((nodeKey) =>
      input.definition.edges.some((edge) =>
        edge.toNodeKey === nodeKey && !contract.nodeKeys.includes(edge.fromNodeKey)));
    const anchor = contract.nodeKeys.includes(input.definition.entryNodeKey)
      ? input.definition.entryNodeKey
      : externalEntryNodes.length === 1
        ? externalEntryNodes[0]!
        : contract.nodeKeys[0]!;
    const entering = !sourceInside;
    const returningToAnchor = sourceInside && input.targetNodeKey === anchor;
    if (!entering && !returningToAnchor) continue;

    const prior = state[contract.key] ?? {
      iteration: 0,
      noProgressCount: 0,
      lastProgressHash: null,
    };
    const progress = readProgress(input.checkpoint, contract.progressField);
    const progressHash = contract.noProgressLimit === null
      ? null
      : contract.progressField === null
        ? requestHash(input.checkpoint)
        : requestHash({ missing: progress === undefined, value: progress ?? null });
    const noProgressCount = prior.iteration > 0
      && progressHash !== null
      && progressHash === prior.lastProgressHash
      ? prior.noProgressCount + 1
      : 0;
    const next = {
      iteration: prior.iteration + 1,
      noProgressCount,
      lastProgressHash: progressHash,
    };
    state[contract.key] = next;

    if (next.iteration > contract.maxIterations) {
      interruption = {
        code: "cycle_iteration_exhausted",
        contractKey: contract.key,
        iteration: next.iteration,
        noProgressCount,
      };
    } else if (
      contract.noProgressLimit !== null
      && noProgressCount >= contract.noProgressLimit
    ) {
      interruption = {
        code: "cycle_no_progress",
        contractKey: contract.key,
        iteration: next.iteration,
        noProgressCount,
      };
    }
  }
  return { state, interruption };
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
        actor: actorEnvelope(input.actor),
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
          return {
            created: false as const,
            run: replay,
            event,
            committed: {
              revision: event.payload.revision as number,
              checkpoint: event.payload.checkpoint as Record<string, unknown>,
            },
          };
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
            ...actorEnvelope(input.actor),
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            payload: {
              revision: run!.revision,
              checkpoint: input.checkpoint ?? {},
              graphVersionId: row.graphVersion.id,
              graphVersion: row.graphVersion.version,
              caseVersion: row.case.version,
            },
          })
          .returning();
        return {
          created: true as const,
          run: run!,
          event: event!,
          committed: {
            revision: run!.revision,
            checkpoint: input.checkpoint ?? {},
          },
        };
      });
    },

    async checkpoint(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      idempotencyKey: string;
      checkpoint: Record<string, unknown>;
      actor: PipelineGraphVersionActor;
    }) {
      const hash = requestHash({
        operation: "checkpoint",
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        checkpoint: input.checkpoint,
        actor: actorEnvelope(input.actor),
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
            ...actorEnvelope(input.actor),
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

    async transition(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      idempotencyKey: string;
      outcome: string;
      checkpoint: Record<string, unknown>;
      leaseToken?: string | null;
      reason?: string | null;
      actor: PipelineGraphVersionActor;
    }) {
      const hash = requestHash({
        operation: "transition",
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        outcome: input.outcome,
        checkpoint: input.checkpoint,
        leaseToken: input.leaseToken ?? null,
        reason: input.reason ?? null,
        actor: actorEnvelope(input.actor),
      });
      const automationLedgers: Array<typeof pipelineAutomationExecutions.$inferSelect> = [];
      const result = await db.transaction(async (tx) => {
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
            redirected: replay.type === "run_paused",
            run,
            event: replay,
            committed: replay.payload,
          };
        }

        const row = await tx
          .select({
            run: pipelineGraphRuns,
            graphVersion: pipelineGraphVersions,
            caseVersion: pipelineCases.version,
            caseStageKey: pipelineStages.key,
          })
          .from(pipelineGraphRuns)
          .innerJoin(
            pipelineGraphVersions,
            and(
              eq(pipelineGraphVersions.companyId, pipelineGraphRuns.companyId),
              eq(pipelineGraphVersions.pipelineId, pipelineGraphRuns.pipelineId),
              eq(pipelineGraphVersions.id, pipelineGraphRuns.graphVersionId),
            ),
          )
          .innerJoin(
            pipelineCases,
            and(
              eq(pipelineCases.companyId, pipelineGraphRuns.companyId),
              eq(pipelineCases.id, pipelineGraphRuns.caseId),
            ),
          )
          .innerJoin(
            pipelineStages,
            and(
              eq(pipelineStages.pipelineId, pipelineCases.pipelineId),
              eq(pipelineStages.id, pipelineCases.stageId),
            ),
          )
          .where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.id, input.runId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Graph run not found");
        const { run, graphVersion } = row;
        if (run.status !== "running") {
          throw unprocessable("Only running graph runs can transition", {
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
        if (row.caseStageKey !== run.currentNodeKey) {
          throw conflict("Pipeline case and graph run nodes diverged", {
            code: "graph_run_case_node_conflict",
            runNodeKey: run.currentNodeKey,
            caseNodeKey: row.caseStageKey,
          });
        }
        const edge = graphVersion.definition.edges.find((candidate) =>
          candidate.fromNodeKey === run.currentNodeKey && candidate.outcome === input.outcome);
        if (!edge) {
          throw unprocessable("Outcome is not available from the current pinned graph node", {
            code: "graph_transition_not_allowed",
            currentNodeKey: run.currentNodeKey,
            outcome: input.outcome,
            graphVersionId: run.graphVersionId,
          });
        }
        const targetNode = graphVersion.definition.nodes.find((node) => node.key === edge.toNodeKey);
        if (!targetNode) {
          throw unprocessable("Pinned graph transition target is missing", {
            code: "graph_transition_target_missing",
            targetNodeKey: edge.toNodeKey,
          });
        }
        const cycle = evolveCycleState({
          definition: graphVersion.definition,
          currentNodeKey: run.currentNodeKey,
          targetNodeKey: targetNode.key,
          checkpoint: input.checkpoint,
          previous: run.cycleState,
        });
        const now = new Date();
        const transitionSequence = run.nextEventSequence;
        const derivedSequence = transitionSequence + 1;

        if (cycle.interruption) {
          await pipelineService(db).assertGraphCaseControlWithinTransaction(tx, {
            companyId: input.companyId,
            caseId: run.caseId,
            expectedVersion: row.caseVersion,
            leaseToken: input.leaseToken,
            actor: input.actor,
            graphRunId: run.id,
          });
          const interruptionCheckpoint = {
            ...input.checkpoint,
            runtimeInterruption: {
              ...cycle.interruption,
              attemptedOutcome: input.outcome,
              responsibilityOwner: "graph_owner",
              responsibilityReason: "cycle_policy_requires_graph_adjustment",
            },
          };
          const [updated] = await tx
            .update(pipelineGraphRuns)
            .set({
              status: "paused",
              pausedAt: now,
              checkpoint: interruptionCheckpoint,
              cycleState: cycle.state,
              revision: run.revision + 1,
              nextEventSequence: run.nextEventSequence + 2,
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
              sequence: transitionSequence,
              type: "run_paused",
              nodeKey: run.currentNodeKey,
              outcome: input.outcome,
              ...actorEnvelope(input.actor),
              idempotencyKey: input.idempotencyKey,
              requestHash: hash,
              payload: {
                revision: updated!.revision,
                checkpoint: interruptionCheckpoint,
                cycleState: cycle.state,
                interruption: cycle.interruption,
                responsibilityOwner: "graph_owner",
              },
            })
            .returning();
          const [wakeEvent] = await tx
            .insert(pipelineGraphRunEvents)
            .values({
              companyId: input.companyId,
              runId: run.id,
              sequence: derivedSequence,
              type: "wake_requested",
              nodeKey: run.currentNodeKey,
              actorType: "system",
              actorId: null,
              actorRunId: null,
              idempotencyKey: `${input.idempotencyKey}:redirect`,
              requestHash: hash,
              payload: {
                runRevision: updated!.revision,
                targetNodeKey: run.currentNodeKey,
                responsibilityOwner: "graph_owner",
                reason: cycle.interruption.code,
              },
            })
            .returning();
          await tx.insert(pipelineGraphWakeOutbox).values({
            companyId: input.companyId,
            runId: run.id,
            eventId: wakeEvent!.id,
            caseId: run.caseId,
            targetNodeKey: run.currentNodeKey,
            idempotencyKey: `${run.id}:${updated!.revision}:graph-owner`,
            payload: {
              runRevision: updated!.revision,
              graphVersionId: run.graphVersionId,
              responsibilityOwner: "graph_owner",
              reason: cycle.interruption.code,
              dispatchEnabled: false,
            },
          });
          return {
            changed: true as const,
            redirected: true as const,
            run: updated!,
            event: event!,
            committed: event!.payload,
          };
        }

        const terminalStatus = targetNode.kind === "done"
          ? "succeeded"
          : targetNode.kind === "cancelled"
            ? "cancelled"
            : null;
        const caseTransition = await pipelineService(db).transitionCaseWithinTransaction(tx, {
          companyId: input.companyId,
          caseId: run.caseId,
          toStageKey: targetNode.key,
          expectedVersion: row.caseVersion,
          leaseToken: input.leaseToken,
          actor: input.actor,
          transitionClass: "manual",
          reason: input.reason ?? `graph outcome: ${input.outcome}`,
          graphRunId: run.id,
          automationLedgers,
        });
        const [updated] = await tx
          .update(pipelineGraphRuns)
          .set({
            status: terminalStatus ?? "running",
            currentNodeKey: targetNode.key,
            checkpoint: input.checkpoint,
            cycleState: cycle.state,
            revision: run.revision + 1,
            nextEventSequence: run.nextEventSequence + 2,
            pausedAt: null,
            finishedAt: terminalStatus ? now : null,
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
            sequence: transitionSequence,
            type: "transition_committed",
            nodeKey: targetNode.key,
            outcome: input.outcome,
            ...actorEnvelope(input.actor),
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            payload: {
              revision: updated!.revision,
              checkpoint: input.checkpoint,
              cycleState: cycle.state,
              fromNodeKey: run.currentNodeKey,
              toNodeKey: targetNode.key,
              status: updated!.status,
              caseVersion: caseTransition.case.version,
            },
          })
          .returning();
        const derivedType = terminalStatus === "succeeded"
          ? "run_succeeded"
          : terminalStatus === "cancelled"
            ? "run_cancelled"
            : "wake_requested";
        const [derivedEvent] = await tx
          .insert(pipelineGraphRunEvents)
          .values({
            companyId: input.companyId,
            runId: run.id,
            sequence: derivedSequence,
            type: derivedType,
            nodeKey: targetNode.key,
            outcome: input.outcome,
            actorType: "system",
            actorId: null,
            actorRunId: null,
            idempotencyKey: `${input.idempotencyKey}:${derivedType}`,
            requestHash: hash,
            payload: {
              runRevision: updated!.revision,
              targetNodeKey: targetNode.key,
              status: updated!.status,
            },
          })
          .returning();
        if (!terminalStatus) {
          await tx.insert(pipelineGraphWakeOutbox).values({
            companyId: input.companyId,
            runId: run.id,
            eventId: derivedEvent!.id,
            caseId: run.caseId,
            targetNodeKey: targetNode.key,
            idempotencyKey: `${run.id}:${updated!.revision}:${targetNode.key}`,
            payload: {
              runRevision: updated!.revision,
              graphVersionId: run.graphVersionId,
              targetNodeKey: targetNode.key,
              responsibilityOwner: targetNode.config.responsibilityOwner ?? targetNode.key,
              dispatchEnabled: false,
            },
          });
        }
        return {
          changed: true as const,
          redirected: false as const,
          run: updated!,
          event: event!,
          committed: event!.payload,
        };
      });
      if (automationLedgers.length > 0) {
        await pipelineService(db).executeTransitionAutomationLedgers(automationLedgers);
      }
      return result;
    },

    async setPaused(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      idempotencyKey: string;
      paused: boolean;
      reason: string;
      actor: PipelineGraphVersionActor;
    }) {
      const operation = input.paused ? "pause" : "resume";
      const hash = requestHash({
        operation,
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actor: actorEnvelope(input.actor),
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
          const run = await tx.select().from(pipelineGraphRuns).where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.id, input.runId),
          )).then((rows) => rows[0] ?? null);
          if (!run) throw notFound("Graph run not found");
          return { changed: false as const, run, event: replay };
        }
        const run = await tx.select().from(pipelineGraphRuns).where(and(
          eq(pipelineGraphRuns.companyId, input.companyId),
          eq(pipelineGraphRuns.id, input.runId),
        )).then((rows) => rows[0] ?? null);
        if (!run) throw notFound("Graph run not found");
        const expectedStatus = input.paused ? "running" : "paused";
        if (run.status !== expectedStatus) {
          throw unprocessable(`Only ${expectedStatus} graph runs can ${operation}`, {
            code: `graph_run_cannot_${operation}`,
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
        const [updated] = await tx.update(pipelineGraphRuns).set({
          status: input.paused ? "paused" : "running",
          pausedAt: input.paused ? now : null,
          revision: run.revision + 1,
          nextEventSequence: run.nextEventSequence + (input.paused ? 1 : 2),
          updatedAt: now,
        }).where(and(
          eq(pipelineGraphRuns.id, run.id),
          eq(pipelineGraphRuns.revision, input.expectedRevision),
        )).returning();
        if (!updated) {
          throw conflict("Graph run changed", { code: "graph_run_revision_conflict" });
        }
        const [event] = await tx.insert(pipelineGraphRunEvents).values({
          companyId: input.companyId,
          runId: run.id,
          sequence: run.nextEventSequence,
          type: input.paused ? "run_paused" : "run_resumed",
          nodeKey: run.currentNodeKey,
          ...actorEnvelope(input.actor),
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          payload: {
            revision: updated!.revision,
            reason: input.reason,
            status: updated!.status,
          },
        }).returning();
        if (!input.paused) {
          const [wakeEvent] = await tx.insert(pipelineGraphRunEvents).values({
            companyId: input.companyId,
            runId: run.id,
            sequence: run.nextEventSequence + 1,
            type: "wake_requested",
            nodeKey: run.currentNodeKey,
            actorType: "system",
            actorId: null,
            actorRunId: null,
            idempotencyKey: `${input.idempotencyKey}:wake_requested`,
            requestHash: hash,
            payload: {
              runRevision: updated!.revision,
              targetNodeKey: run.currentNodeKey,
              reason: "run_resumed",
            },
          }).returning();
          await tx.insert(pipelineGraphWakeOutbox).values({
            companyId: input.companyId,
            runId: run.id,
            eventId: wakeEvent!.id,
            caseId: run.caseId,
            targetNodeKey: run.currentNodeKey,
            idempotencyKey: `${run.id}:${updated!.revision}:${run.currentNodeKey}`,
            payload: {
              runRevision: updated!.revision,
              graphVersionId: run.graphVersionId,
              targetNodeKey: run.currentNodeKey,
              responsibilityOwner: run.currentNodeKey,
              reason: "run_resumed",
              dispatchEnabled: false,
            },
          });
        }
        return { changed: true as const, run: updated!, event: event! };
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

    async diagnostics(input: { companyId: string; runId: string; now?: Date }) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level repeatable read read only`);
        const row = await tx
          .select({
            run: pipelineGraphRuns,
            graphVersion: pipelineGraphVersions,
          })
          .from(pipelineGraphRuns)
          .innerJoin(
            pipelineGraphVersions,
            and(
              eq(pipelineGraphVersions.companyId, pipelineGraphRuns.companyId),
              eq(pipelineGraphVersions.pipelineId, pipelineGraphRuns.pipelineId),
              eq(pipelineGraphVersions.id, pipelineGraphRuns.graphVersionId),
            ),
          )
          .where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.id, input.runId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Graph run not found");

        const [events, wakeOutbox] = await Promise.all([
          tx
            .select()
            .from(pipelineGraphRunEvents)
            .where(and(
              eq(pipelineGraphRunEvents.companyId, input.companyId),
              eq(pipelineGraphRunEvents.runId, input.runId),
            ))
            .orderBy(asc(pipelineGraphRunEvents.sequence)),
          tx
            .select()
            .from(pipelineGraphWakeOutbox)
            .where(and(
              eq(pipelineGraphWakeOutbox.companyId, input.companyId),
              eq(pipelineGraphWakeOutbox.runId, input.runId),
            ))
            .orderBy(asc(pipelineGraphWakeOutbox.createdAt)),
        ]);
        const compiledNode = row.graphVersion.definition.nodes.find(
          (node) => node.key === row.run.currentNodeKey,
        ) ?? null;
        const currentNode = compiledNode
          ? { key: compiledNode.key, name: compiledNode.name, kind: compiledNode.kind }
          : null;
        const cycleContracts = row.graphVersion.definition.cycleContracts.filter(
          (contract) => contract.nodeKeys.includes(row.run.currentNodeKey),
        );
        const cycleState = Object.fromEntries(Object.entries(row.run.cycleState).map(([key, value]) => {
          const state = value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
          return [key, {
            iteration: typeof state.iteration === "number" ? state.iteration : null,
            noProgressCount: typeof state.noProgressCount === "number" ? state.noProgressCount : null,
            hasProgressBaseline: typeof state.lastProgressHash === "string",
          }];
        }));
        const budgetLimits = compiledNode?.config.budgets &&
          typeof compiledNode.config.budgets === "object" &&
          !Array.isArray(compiledNode.config.budgets)
          ? Object.fromEntries(
              Object.entries(compiledNode.config.budgets as Record<string, unknown>)
                .filter((entry): entry is [string, number] =>
                  typeof entry[1] === "number" && Number.isFinite(entry[1])),
            )
          : {};
        const wakeStatusCounts = wakeOutbox.reduce<Record<string, number>>((counts, wake) => {
          counts[wake.status] = (counts[wake.status] ?? 0) + 1;
          return counts;
        }, {});
        const deliveredWakeLatencies = wakeOutbox
          .filter((wake) => wake.dispatchedAt)
          .map((wake) => wake.dispatchedAt!.getTime() - wake.createdAt.getTime());
        const latestControlEvent = [...events].reverse().find((event) =>
          event.type === "run_paused" || event.type === "run_resumed"
        ) ?? null;
        const activeRedirect =
          row.run.status === "paused" &&
          latestControlEvent?.type === "run_paused" &&
          typeof latestControlEvent.payload.responsibilityOwner === "string"
            ? latestControlEvent
            : null;
        const redirectInterruption =
          activeRedirect?.payload.interruption &&
          typeof activeRedirect.payload.interruption === "object" &&
          !Array.isArray(activeRedirect.payload.interruption)
            ? activeRedirect.payload.interruption as Record<string, unknown>
            : null;
        const now = input.now ?? new Date();
        const finishedAt = row.run.finishedAt ?? now;
        const checkpointJson = JSON.stringify(row.run.checkpoint);
        const latestReceipt = [...wakeOutbox].reverse().find((wake) => wake.dispatchReceipt)
          ?.dispatchReceipt;

        return {
          run: {
            id: row.run.id,
            pipelineId: row.run.pipelineId,
            graphVersionId: row.run.graphVersionId,
            caseId: row.run.caseId,
            status: row.run.status,
            currentNodeKey: row.run.currentNodeKey,
            revision: row.run.revision,
            startedAt: row.run.startedAt,
            pausedAt: row.run.pausedAt,
            finishedAt: row.run.finishedAt,
            updatedAt: row.run.updatedAt,
          },
          graph: {
            versionId: row.graphVersion.id,
            version: row.graphVersion.version,
            schemaVersion: row.graphVersion.schemaVersion,
            definitionHash: row.graphVersion.definitionHash,
          },
          invariants: compiledNode
            ? []
            : [{
                code: "current_node_missing",
                message: `Current node "${row.run.currentNodeKey}" is absent from the pinned graph definition.`,
              }],
          current: {
            node: currentNode,
            responsibilityOwner:
              typeof compiledNode?.config.responsibilityOwner === "string"
                ? compiledNode.config.responsibilityOwner
                : row.run.currentNodeKey,
            targetAgentId:
              typeof compiledNode?.config.targetAgentId === "string"
                ? compiledNode.config.targetAgentId
                : null,
            budgetLimits,
            cycleContracts,
            cycleState,
            checkpoint: {
              present: Object.keys(row.run.checkpoint).length > 0,
              keys: Object.keys(row.run.checkpoint).sort(),
              bytes: Buffer.byteLength(checkpointJson),
            },
            interruption: activeRedirect
              ? {
                  code: typeof redirectInterruption?.code === "string"
                    ? redirectInterruption.code
                    : null,
                }
              : null,
            redirect: activeRedirect
              ? {
                  eventId: activeRedirect.id,
                  sequence: activeRedirect.sequence,
                  responsibilityOwner: activeRedirect.payload.responsibilityOwner,
                  reason: typeof redirectInterruption?.code === "string"
                    ? redirectInterruption.code
                    : null,
                }
              : null,
          },
          trajectory: events.map((event) => ({
            sequence: event.sequence,
            type: event.type,
            nodeKey: event.nodeKey,
            outcome: event.outcome,
            actorType: event.actorType,
            actorId: event.actorId,
            createdAt: event.createdAt,
          })),
          wakeDelivery: {
            statusCounts: wakeStatusCounts,
            pending: wakeOutbox.filter((wake) => wake.status === "pending").length,
            claimed: wakeOutbox.filter((wake) => wake.status === "claimed").length,
            dispatched: wakeOutbox.filter((wake) => wake.status === "dispatched").length,
            failed: wakeOutbox.filter((wake) => wake.status === "failed").length,
            cancelled: wakeOutbox.filter((wake) => wake.status === "cancelled").length,
            averageDispatchLatencyMs: deliveredWakeLatencies.length > 0
              ? Math.round(
                  deliveredWakeLatencies.reduce((sum, latency) => sum + latency, 0) /
                  deliveredWakeLatencies.length,
                )
              : null,
            latestReceipt: latestReceipt
              ? {
                  accepted: latestReceipt.accepted === true,
                  heartbeatRunId:
                    typeof latestReceipt.heartbeatRunId === "string"
                      ? latestReceipt.heartbeatRunId
                      : null,
                  wakeupRequestId:
                    typeof latestReceipt.wakeupRequestId === "string"
                      ? latestReceipt.wakeupRequestId
                      : null,
                }
              : null,
          },
          kpis: {
            elapsedMs: Math.max(0, finishedAt.getTime() - row.run.startedAt.getTime()),
            transitionCount: events.filter((event) => event.type === "transition_committed").length,
            checkpointCount: events.filter((event) => event.type === "checkpoint_saved").length,
            redirectCount: events.filter((event) =>
              event.type === "run_paused" &&
              typeof event.payload.responsibilityOwner === "string"
            ).length,
            wakeRequestCount: events.filter((event) => event.type === "wake_requested").length,
            lastOutcome:
              [...events].reverse().find((event) => event.outcome)?.outcome ?? null,
            terminalOutcome: ["succeeded", "failed", "cancelled"].includes(row.run.status)
              ? row.run.status
              : null,
          },
        };
      });
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
