import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issues,
  pipelineCases,
  pipelineGraphEffectAttempts,
  pipelineAutomationExecutions,
  pipelineCaseIssueLinks,
  pipelineGraphRunEvents,
  pipelineGraphRuns,
  pipelineGraphVersions,
  pipelineGraphWakeOutbox,
  pipelineStages,
} from "@paperclipai/db";
import {
  PIPELINE_GRAPH_ASSIGNMENT_SCHEMA_VERSION,
  type PipelineGraphAssignmentV1,
  type PipelineGraphDefinitionV1,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { PipelineGraphVersionActor } from "./pipeline-graph-versions.js";
import { graphCaseLockKey, graphRecoveryOwnershipLockKey } from "./pipeline-graph-ownership.js";
import { pipelineService } from "./pipelines.js";

class GraphRecoveryOwnershipBusy extends Error {}

const GRAPH_RECOVERY_OWNERSHIP_RETRY_ATTEMPTS = 80;
const GRAPH_RECOVERY_OWNERSHIP_RETRY_DELAY_MS = 25;

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

export function graphReconciliationIssueStateHash(issue: {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: unknown;
  blockedByApprovalId: string | null;
  blockedByExternal: unknown;
  updatedAt: Date | string;
}) {
  return requestHash({
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    executionState: issue.executionState,
    blockedByApprovalId: issue.blockedByApprovalId,
    blockedByExternal: issue.blockedByExternal,
    updatedAt: issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : issue.updatedAt,
  });
}

export type PipelineGraphRunCursor = {
  id: string;
};

export function encodePipelineGraphRunCursor(cursor: PipelineGraphRunCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePipelineGraphRunCursor(raw: string): PipelineGraphRunCursor {
  const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<PipelineGraphRunCursor>;
  if (
    typeof parsed.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
  ) {
    throw new Error("invalid graph run cursor");
  }
  return { id: parsed.id };
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function graphWakeRouting(input: {
  definition: PipelineGraphDefinitionV1;
  node: PipelineGraphDefinitionV1["nodes"][number];
  graphVersionId: string;
  runId: string;
  runRevision: number;
  caseId: string;
}) {
  const { definition, node } = input;
  const config = node.config;
  const responsibilityOwner =
    typeof config.responsibilityOwner === "string" && config.responsibilityOwner.trim()
      ? config.responsibilityOwner.trim()
      : node.key;
  const targetAgentId =
    typeof config.targetAgentId === "string" && config.targetAgentId.trim()
      ? config.targetAgentId.trim()
      : null;
  const responsibilityInstruction =
    typeof config.responsibilityInstruction === "string" && config.responsibilityInstruction.trim()
      ? config.responsibilityInstruction.trim()
      : null;
  const assignment: PipelineGraphAssignmentV1 = {
    schemaVersion: PIPELINE_GRAPH_ASSIGNMENT_SCHEMA_VERSION,
    id: `${input.runId}:${input.runRevision}:${node.key}`,
    graphVersionId: input.graphVersionId,
    runId: input.runId,
    runRevision: input.runRevision,
    caseId: input.caseId,
    nodeKey: node.key,
    nodeKind: node.kind,
    responsibilityOwner,
    targetAgentId,
    instruction: responsibilityInstruction,
    acceptanceCriteria: stringList(config.acceptanceCriteria),
    allowedOutcomes: definition.edges
      .filter((edge) => edge.fromNodeKey === node.key)
      .map((edge) => edge.outcome)
      .sort(),
    completion: {
      method: "POST",
      path: `/api/graph-runs/${input.runId}/transitions`,
      requiredFields: ["expectedRevision", "idempotencyKey", "outcome", "checkpoint"],
    },
  };
  return {
    responsibilityOwner,
    dispatchEnabled: config.dispatchEnabled === true,
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(responsibilityInstruction ? { responsibilityInstruction } : {}),
    graphAssignment: assignment,
  };
}

/** Heartbeat run statuses that still represent a live, in-progress attempt. */
const ACTIVE_HEARTBEAT_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);

export type GraphAssignmentAuthorizationDecision =
  | { authorized: true }
  | { authorized: false; code: string };

/**
 * `assignment_authorized`: narrow, fail-closed authority for an agent to submit
 * ONE transition for its EXACT current graph assignment, derived only from
 * durably persisted graph run / heartbeat state — never from caller-supplied
 * `targetAgentId`, node, or outcome. Used by the transitions route to decide
 * whether broad `pipelines:write` may be bypassed; it never itself commits a
 * mutation. The transactional CAS inside `transition()` remains the sole
 * authoritative enforcement of every one of these bindings.
 */
export async function resolveGraphTransitionAssignmentAuthorization(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    expectedRevision: number;
    idempotencyKey: string;
    outcome: string;
    checkpoint: Record<string, unknown>;
    leaseToken?: string | null;
    effectAttemptId?: string | null;
    reason?: string | null;
    actor: PipelineGraphVersionActor;
  },
): Promise<GraphAssignmentAuthorizationDecision> {
  if (input.actor.type !== "agent") {
    return { authorized: false, code: "graph_assignment_actor_not_agent" };
  }
  // A prior commit or in-flight replay of this exact request is always
  // safe to admit: the persisted request hash binds the actor envelope, so
  // a hash match proves this is the same agent replaying its own committed
  // (or in-flight) transition, independent of current run/node state.
  const hash = requestHash({
    operation: "transition",
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    outcome: input.outcome,
    checkpoint: input.checkpoint,
    leaseToken: input.leaseToken ?? null,
    effectAttemptId: input.effectAttemptId ?? null,
    reason: input.reason ?? null,
    actor: actorEnvelope(input.actor),
  });
  const replay = await db
    .select({ requestHash: pipelineGraphRunEvents.requestHash })
    .from(pipelineGraphRunEvents)
    .where(and(
      eq(pipelineGraphRunEvents.companyId, input.companyId),
      eq(pipelineGraphRunEvents.runId, input.runId),
      eq(pipelineGraphRunEvents.idempotencyKey, input.idempotencyKey),
    ))
    .then((rows) => rows[0] ?? null);
  if (replay) {
    return replay.requestHash === hash
      ? { authorized: true }
      : { authorized: false, code: "graph_event_idempotency_conflict" };
  }

  const row = await db
    .select({ run: pipelineGraphRuns, graphVersion: pipelineGraphVersions })
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
  if (!row) return { authorized: false, code: "graph_run_not_found" };
  const { run, graphVersion } = row;
  if (run.status !== "running") return { authorized: false, code: "graph_run_not_running" };
  if (run.revision !== input.expectedRevision) {
    return { authorized: false, code: "graph_run_revision_conflict" };
  }
  const currentNode = graphVersion.definition.nodes.find((node) => node.key === run.currentNodeKey);
  if (!currentNode) return { authorized: false, code: "graph_run_node_missing" };
  const assignedAgentId = typeof currentNode.config.targetAgentId === "string"
    ? currentNode.config.targetAgentId.trim()
    : "";
  if (currentNode.config.dispatchEnabled !== true || !assignedAgentId) {
    return { authorized: false, code: "graph_assignment_not_dispatchable" };
  }
  if (input.actor.agentId !== assignedAgentId) {
    return { authorized: false, code: "graph_assignment_agent_mismatch" };
  }
  const attempt = await db
    .select({
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, input.actor.runId),
    ))
    .then((rows) => rows[0] ?? null);
  const attemptContext = objectValue(attempt?.contextSnapshot);
  const assignment = objectValue(attemptContext.graphAssignment);
  if (
    !attempt
    || !ACTIVE_HEARTBEAT_RUN_STATUSES.has(attempt.status)
    || attempt.agentId !== input.actor.agentId
    || attemptContext.graphRunId !== run.id
    || attemptContext.targetNodeKey !== run.currentNodeKey
    || attemptContext.graphRunRevision !== input.expectedRevision
    || assignment.id !== `${run.id}:${input.expectedRevision}:${run.currentNodeKey}`
  ) {
    return { authorized: false, code: "graph_assignment_attempt_mismatch" };
  }
  const edge = graphVersion.definition.edges.find((candidate) =>
    candidate.fromNodeKey === run.currentNodeKey && candidate.outcome === input.outcome);
  if (!edge) return { authorized: false, code: "graph_transition_not_allowed" };
  return { authorized: true };
}

export function pipelineGraphRunService(
  db: Db,
  deps: {
    cancelHeartbeatRun?: (runId: string, reason: string) => Promise<unknown>;
  } = {},
) {
  async function cancelSupersededHeartbeatRuns(input: {
    companyId: string;
    graphRunId: string;
    currentRevision: number;
    actorRunId?: string | null;
    reason: string;
  }) {
    if (!deps.cancelHeartbeatRun) return;
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'pipelineGraphWake' = 'true'`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'graphRunId' = ${input.graphRunId}`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'graphRunRevision' is distinct from ${String(input.currentRevision)}`,
        input.actorRunId ? sql`${heartbeatRuns.id} <> ${input.actorRunId}` : undefined,
      ))
      .then((rows) => rows.map((row) => row.id));
    await Promise.all(runIds.map((runId) =>
      deps.cancelHeartbeatRun!(runId, input.reason)
    ));
  }

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
      const attemptStart = () => db.transaction(async (tx) => {
        const startKeyLock = await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${
            "pipeline-graph-run:start-key:" + input.companyId + ":" + input.idempotencyKey
          }, 0)) as acquired`,
        );
        if (!(startKeyLock as unknown as Array<{ acquired: boolean }>)[0]?.acquired) {
          throw new GraphRecoveryOwnershipBusy();
        }
        const caseLock = await tx.execute(
          sql`select pg_try_advisory_xact_lock(
            hashtextextended(${graphCaseLockKey(input.caseId)}, 0)
          ) as acquired`,
        );
        if (!(caseLock as unknown as Array<{ acquired: boolean }>)[0]?.acquired) {
          throw new GraphRecoveryOwnershipBusy();
        }
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
        const ownershipIssueIds = await tx
          .select({ issueId: pipelineCaseIssueLinks.issueId })
          .from(pipelineCaseIssueLinks)
          .where(and(
            eq(pipelineCaseIssueLinks.companyId, input.companyId),
            eq(pipelineCaseIssueLinks.caseId, input.caseId),
            inArray(pipelineCaseIssueLinks.role, ["origin", "work"]),
            isNull(pipelineCaseIssueLinks.retiredAt),
          ))
          .then((links) => [...new Set(links.map((link) => link.issueId))].sort());
        for (const issueId of ownershipIssueIds) {
          const lockResult = await tx.execute(sql`
            select pg_try_advisory_xact_lock(
              hashtextextended(${graphRecoveryOwnershipLockKey(input.companyId, issueId)}, 0)
            ) as acquired
          `);
          const lockRows = lockResult as unknown as Array<{ acquired: boolean }>;
          if (!lockRows[0]?.acquired) throw new GraphRecoveryOwnershipBusy();
        }
        if (ownershipIssueIds.length > 0) {
          const [activeCompanyRuns, linkedIssueRuns] = await Promise.all([
            tx
              .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
              .from(heartbeatRuns)
              .where(and(
                eq(heartbeatRuns.companyId, input.companyId),
                inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
              )),
            tx
              .select({
                issueId: issues.id,
                executionRunId: issues.executionRunId,
                checkoutRunId: issues.checkoutRunId,
              })
              .from(issues)
              .where(and(
                eq(issues.companyId, input.companyId),
                inArray(issues.id, ownershipIssueIds),
              )),
          ]);
          const ownershipIssueIdSet = new Set(ownershipIssueIds);
          const linkedLegacyRunIds = new Set(
            linkedIssueRuns
              .flatMap((issue) => [issue.executionRunId, issue.checkoutRunId])
              .filter((runId): runId is string => Boolean(runId)),
          );
          const legacyRun = activeCompanyRuns.find((run) => {
            const context = run.contextSnapshot && typeof run.contextSnapshot === "object"
              ? run.contextSnapshot as Record<string, unknown>
              : {};
            if (context.pipelineGraphWake === true) return false;
            const issueId = typeof context.issueId === "string" ? context.issueId : null;
            const taskId = typeof context.taskId === "string" ? context.taskId : null;
            return linkedLegacyRunIds.has(run.id)
              || (issueId !== null && ownershipIssueIdSet.has(issueId))
              || (taskId !== null && ownershipIssueIdSet.has(taskId));
          });
          if (legacyRun) {
            throw conflict("Graph activation is waiting for the issue's existing execution owner", {
              code: "graph_run_legacy_issue_owner_active",
              retryable: true,
              legacyRunId: legacyRun.id,
              issueIds: ownershipIssueIds,
            });
          }
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

        const [createdRun] = await tx
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
        let run = createdRun!;
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
              revision: run.revision,
              checkpoint: input.checkpoint ?? {},
              graphVersionId: row.graphVersion.id,
              graphVersion: row.graphVersion.version,
              caseVersion: row.case.version,
            },
          })
          .returning();
        const entryNode = row.graphVersion.definition.nodes.find(
          (node) => node.key === row.stageKey,
        )!;
        const targetAgentId =
          typeof entryNode.config.targetAgentId === "string"
            ? entryNode.config.targetAgentId.trim()
            : "";
        if (entryNode.config.dispatchEnabled === true && targetAgentId) {
          const wakeRouting = graphWakeRouting({
            definition: row.graphVersion.definition,
            node: entryNode,
            graphVersionId: run.graphVersionId,
            runId: run.id,
            runRevision: run.revision,
            caseId: run.caseId,
          });
          const [wakeEvent] = await tx
            .insert(pipelineGraphRunEvents)
            .values({
              companyId: input.companyId,
              runId: run.id,
              sequence: run.nextEventSequence,
              type: "wake_requested",
              nodeKey: entryNode.key,
              actorType: "system",
              actorId: null,
              actorRunId: null,
              idempotencyKey: `${input.idempotencyKey}:wake_requested`,
              requestHash: hash,
              payload: {
                runRevision: run.revision,
                targetNodeKey: entryNode.key,
                reason: "run_started",
              },
            })
            .returning();
          const [sequencedRun] = await tx
            .update(pipelineGraphRuns)
            .set({
              nextEventSequence: run.nextEventSequence + 1,
              updatedAt: new Date(),
            })
            .where(and(
              eq(pipelineGraphRuns.id, run.id),
              eq(pipelineGraphRuns.revision, run.revision),
            ))
            .returning();
          if (!sequencedRun) {
            throw conflict("Graph run changed", { code: "graph_run_revision_conflict" });
          }
          run = sequencedRun;
          await tx.insert(pipelineGraphWakeOutbox).values({
            companyId: input.companyId,
            runId: run.id,
            eventId: wakeEvent!.id,
            caseId: run.caseId,
            targetNodeKey: entryNode.key,
            idempotencyKey: `${run.id}:${run.revision}:${entryNode.key}`,
            payload: {
              runRevision: run.revision,
              graphVersionId: run.graphVersionId,
              targetNodeKey: entryNode.key,
              ...wakeRouting,
              reason: "run_started",
            },
          });
        }
        return {
          created: true as const,
          run,
          event: event!,
          committed: {
            revision: run.revision,
            checkpoint: input.checkpoint ?? {},
          },
        };
      });
      for (let attempt = 0; attempt < GRAPH_RECOVERY_OWNERSHIP_RETRY_ATTEMPTS; attempt += 1) {
        try {
          return await attemptStart();
        } catch (error) {
          if (!(error instanceof GraphRecoveryOwnershipBusy)) throw error;
          await new Promise((resolve) => setTimeout(resolve, GRAPH_RECOVERY_OWNERSHIP_RETRY_DELAY_MS));
        }
      }
      throw conflict("Graph ownership is temporarily busy; retry the idempotent start request", {
        code: "graph_run_recovery_ownership_busy",
        retryable: true,
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
      await cancelSupersededHeartbeatRuns({
        companyId: input.companyId,
        graphRunId: input.runId,
        currentRevision: result.run.revision,
        actorRunId: input.actor.type === "agent" ? input.actor.runId : null,
        reason: `Cancelled because graph run ${input.runId} advanced to revision ${result.run.revision}`,
      });
      return result;
    },

    async transition(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      idempotencyKey: string;
      outcome: string;
      checkpoint: Record<string, unknown>;
      leaseToken?: string | null;
      effectAttemptId?: string | null;
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
        effectAttemptId: input.effectAttemptId ?? null,
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
        const currentNode = graphVersion.definition.nodes.find(
          (node) => node.key === run.currentNodeKey,
        );
        if (!currentNode) {
          throw unprocessable("Pinned graph current node is missing", {
            code: "graph_run_node_missing",
            currentNodeKey: run.currentNodeKey,
          });
        }
        const requiredEffectType =
          typeof currentNode.config.requiredEffectType === "string"
            ? currentNode.config.requiredEffectType.trim()
            : "";
        const requiredEffectOutcomes = Array.isArray(currentNode.config.requiredEffectOutcomes)
          ? currentNode.config.requiredEffectOutcomes.filter(
              (outcome): outcome is string => typeof outcome === "string" && outcome.trim() !== "",
            )
          : [];
        const effectRequiredForOutcome = Boolean(requiredEffectType)
          && (
            requiredEffectOutcomes.length === 0
            || requiredEffectOutcomes.includes(input.outcome)
          );
        let effectReceipt: {
          effectAttemptId: string;
          effectType: string;
          subjectHash: string;
          providerReceipt: Record<string, unknown>;
        } | null = null;
        if (input.effectAttemptId || effectRequiredForOutcome) {
          if (!input.effectAttemptId) {
            throw unprocessable("This graph node requires a durable effect receipt before transition", {
              code: "graph_effect_receipt_required",
              requiredEffectType,
            });
          }
          const effect = await tx
            .select()
            .from(pipelineGraphEffectAttempts)
            .where(and(
              eq(pipelineGraphEffectAttempts.companyId, input.companyId),
              eq(pipelineGraphEffectAttempts.id, input.effectAttemptId),
            ))
            .then((rows) => rows[0] ?? null);
          if (
            !effect
            || effect.runId !== run.id
            || effect.nodeKey !== run.currentNodeKey
            || effect.runRevision !== run.revision
          ) {
            throw forbidden("Effect receipt is not bound to the current graph node revision", {
              code: "graph_effect_binding_mismatch",
              effectAttemptId: input.effectAttemptId,
            });
          }
          if (requiredEffectType && effect.effectType !== requiredEffectType) {
            throw unprocessable("Effect receipt has the wrong effect type", {
              code: "graph_effect_type_mismatch",
              requiredEffectType,
              effectType: effect.effectType,
            });
          }
          if (effect.status !== "succeeded" || !effect.providerReceipt) {
            throw conflict("Effect has not committed a durable provider receipt", {
              code: "graph_effect_not_succeeded",
              effectAttemptId: effect.id,
              status: effect.status,
            });
          }
          effectReceipt = {
            effectAttemptId: effect.id,
            effectType: effect.effectType,
            subjectHash: effect.subjectHash,
            providerReceipt: effect.providerReceipt,
          };
        }
        const assignedAgentId =
          typeof currentNode.config.targetAgentId === "string"
            ? currentNode.config.targetAgentId.trim()
            : "";
        if (
          input.actor.type === "agent"
          && currentNode.config.dispatchEnabled === true
          && assignedAgentId
        ) {
          if (input.actor.agentId !== assignedAgentId) {
            throw forbidden("Only the agent assigned to this graph node can submit its outcome", {
              code: "graph_assignment_agent_mismatch",
              assignedAgentId,
              actorAgentId: input.actor.agentId,
              currentNodeKey: run.currentNodeKey,
            });
          }
          const attempt = await tx
            .select({
              agentId: heartbeatRuns.agentId,
              contextSnapshot: heartbeatRuns.contextSnapshot,
            })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.companyId, input.companyId),
              eq(heartbeatRuns.id, input.actor.runId),
            ))
            .then((rows) => rows[0] ?? null);
          const attemptContext = objectValue(attempt?.contextSnapshot);
          const assignment = objectValue(attemptContext.graphAssignment);
          if (
            !attempt
            || attempt.agentId !== input.actor.agentId
            || attemptContext.graphRunId !== run.id
            || attemptContext.targetNodeKey !== run.currentNodeKey
            || attemptContext.graphRunRevision !== input.expectedRevision
            || assignment.id !== `${run.id}:${input.expectedRevision}:${run.currentNodeKey}`
          ) {
            throw forbidden("Agent outcome is not bound to the current graph assignment", {
              code: "graph_assignment_attempt_mismatch",
              currentNodeKey: run.currentNodeKey,
              expectedRevision: input.expectedRevision,
              actorRunId: input.actor.runId,
            });
          }
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
              ...(effectReceipt ? { effectReceipt } : {}),
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
          const wakeRouting = graphWakeRouting({
            definition: row.graphVersion.definition,
            node: targetNode,
            graphVersionId: run.graphVersionId,
            runId: run.id,
            runRevision: updated!.revision,
            caseId: run.caseId,
          });
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
              ...wakeRouting,
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
      await cancelSupersededHeartbeatRuns({
        companyId: input.companyId,
        graphRunId: input.runId,
        currentRevision: result.run.revision,
        actorRunId: null,
        reason: `Cancelled because graph run ${input.runId} advanced to revision ${result.run.revision}`,
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
          const graphVersion = await tx
            .select({ definition: pipelineGraphVersions.definition })
            .from(pipelineGraphVersions)
            .where(and(
              eq(pipelineGraphVersions.companyId, input.companyId),
              eq(pipelineGraphVersions.id, run.graphVersionId),
            ))
            .then((rows) => rows[0] ?? null);
          const currentNode = graphVersion?.definition.nodes.find(
            (node) => node.key === run.currentNodeKey,
          );
          if (!graphVersion || !currentNode) {
            throw conflict("Pinned graph node is missing", {
              code: "graph_run_node_missing",
              currentNodeKey: run.currentNodeKey,
            });
          }
          const wakeRouting = graphWakeRouting({
            definition: graphVersion.definition,
            node: currentNode,
            graphVersionId: run.graphVersionId,
            runId: run.id,
            runRevision: updated!.revision,
            caseId: run.caseId,
          });
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
              ...wakeRouting,
              reason: "run_resumed",
            },
          });
        }
        return { changed: true as const, run: updated!, event: event! };
      });
      await cancelSupersededHeartbeatRuns({
        companyId: input.companyId,
        graphRunId: input.runId,
        currentRevision: result.run.revision,
        actorRunId: null,
        reason: `Cancelled because graph run ${input.runId} ${operation}d at revision ${result.run.revision}`,
      });
      return result;
    },

    async cancel(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      idempotencyKey: string;
      reason: string;
      actor: PipelineGraphVersionActor;
    }) {
      const hash = requestHash({
        operation: "cancel",
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actor: actorEnvelope(input.actor),
      });
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
        if (replay && replay.requestHash !== hash) {
          throw conflict("Graph event idempotency key was reused with a different request", {
            code: "graph_event_idempotency_conflict",
          });
        }
        const run = await tx.select().from(pipelineGraphRuns).where(and(
          eq(pipelineGraphRuns.companyId, input.companyId),
          eq(pipelineGraphRuns.id, input.runId),
        )).then((rows) => rows[0] ?? null);
        if (!run) throw notFound("Graph run not found");
        if (!replay) {
          if (run.status !== "running" && run.status !== "paused") {
            throw unprocessable("Only active graph runs can be cancelled", {
              code: "graph_run_cannot_cancel",
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
        }
        const now = new Date();
        const updated = replay
          ? run
          : await tx.update(pipelineGraphRuns).set({
              status: "cancelled",
              pausedAt: null,
              finishedAt: now,
              revision: run.revision + 1,
              nextEventSequence: run.nextEventSequence + 1,
              updatedAt: now,
            }).where(and(
              eq(pipelineGraphRuns.id, run.id),
              eq(pipelineGraphRuns.revision, input.expectedRevision),
            )).returning().then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Graph run changed", { code: "graph_run_revision_conflict" });
        }
        const event = replay ?? await tx.insert(pipelineGraphRunEvents).values({
          companyId: input.companyId,
          runId: run.id,
          sequence: run.nextEventSequence,
          type: "run_cancelled",
          nodeKey: run.currentNodeKey,
          ...actorEnvelope(input.actor),
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          payload: {
            revision: updated.revision,
            reason: input.reason,
            status: updated.status,
          },
        }).returning().then((rows) => rows[0]!);
        if (!replay) {
          await tx.update(pipelineGraphWakeOutbox).set({
            status: "cancelled",
            claimToken: null,
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
            lastError: input.reason,
            updatedAt: now,
          }).where(and(
            eq(pipelineGraphWakeOutbox.companyId, input.companyId),
            eq(pipelineGraphWakeOutbox.runId, input.runId),
            inArray(pipelineGraphWakeOutbox.status, ["pending", "claimed"]),
          ));
        }
        const heartbeatRunIds = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, input.companyId),
            inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'graphRunId' = ${input.runId}`,
          ))
          .then((rows) => rows.map((row) => row.id));
        return {
          changed: !replay,
          run: updated,
          event,
          heartbeatRunIds,
        };
      });
      if (deps.cancelHeartbeatRun) {
        await Promise.all(result.heartbeatRunIds.map((heartbeatRunId) =>
          deps.cancelHeartbeatRun!(
            heartbeatRunId,
            `Cancelled because graph run ${input.runId} was cancelled: ${input.reason}`,
          ),
        ));
      }
      return {
        changed: result.changed,
        run: result.run,
        event: result.event,
        cancelledHeartbeatRunCount: result.heartbeatRunIds.length,
      };
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

    async listForPipeline(input: {
      companyId: string;
      pipelineId: string;
      statuses: Array<"running" | "paused" | "succeeded" | "failed" | "cancelled">;
      limit: number;
      cursor?: PipelineGraphRunCursor | null;
    }) {
      const rows = await db
        .select()
        .from(pipelineGraphRuns)
        .where(and(
          eq(pipelineGraphRuns.companyId, input.companyId),
          eq(pipelineGraphRuns.pipelineId, input.pipelineId),
          inArray(pipelineGraphRuns.status, input.statuses),
          input.cursor
            ? lt(pipelineGraphRuns.id, input.cursor.id)
            : undefined,
        ))
        .orderBy(desc(pipelineGraphRuns.id))
        .limit(input.limit + 1);
      const items = rows.slice(0, input.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > input.limit && last
          ? encodePipelineGraphRunCursor({ id: last.id })
          : null,
      };
    },

    async catchUp(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      expectedCaseVersion: number;
      linkedIssueId: string;
      expectedIssueStateHash: string;
      idempotencyKey: string;
      outcomes: string[];
      checkpoint: Record<string, unknown>;
      reason: string;
      actor: PipelineGraphVersionActor;
    }) {
      const hash = requestHash({
        operation: "catch_up",
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        expectedCaseVersion: input.expectedCaseVersion,
        linkedIssueId: input.linkedIssueId,
        expectedIssueStateHash: input.expectedIssueStateHash,
        idempotencyKey: input.idempotencyKey,
        outcomes: input.outcomes,
        checkpoint: input.checkpoint,
        reason: input.reason,
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
            run,
            event: replay,
            committed: replay.payload,
            traversedOutcomes: input.outcomes,
            wakeBehavior: run.status === "running" ? "final_only" as const : "none" as const,
          };
        }

        const row = await tx
          .select({
            run: pipelineGraphRuns,
            graphVersion: pipelineGraphVersions,
            caseVersion: pipelineCases.version,
            caseStageKey: pipelineStages.key,
            issue: issues,
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
          .innerJoin(
            pipelineCaseIssueLinks,
            and(
              eq(pipelineCaseIssueLinks.companyId, pipelineGraphRuns.companyId),
              eq(pipelineCaseIssueLinks.caseId, pipelineGraphRuns.caseId),
              eq(pipelineCaseIssueLinks.issueId, input.linkedIssueId),
              eq(pipelineCaseIssueLinks.role, "work"),
              isNull(pipelineCaseIssueLinks.retiredAt),
            ),
          )
          .innerJoin(
            issues,
            and(
              eq(issues.companyId, pipelineGraphRuns.companyId),
              eq(issues.id, pipelineCaseIssueLinks.issueId),
            ),
          )
          .where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.id, input.runId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Graph run or active linked work issue not found");
        if (row.run.status !== "running") {
          throw unprocessable("Only running graph runs can catch up", {
            code: "graph_run_not_running",
            status: row.run.status,
          });
        }
        if (row.run.revision !== input.expectedRevision) {
          throw conflict("Graph run changed", {
            code: "graph_run_revision_conflict",
            expectedRevision: input.expectedRevision,
            currentRevision: row.run.revision,
          });
        }
        if (row.caseVersion !== input.expectedCaseVersion) {
          throw conflict("Pipeline case changed", {
            code: "pipeline_case_version_conflict",
            expectedVersion: input.expectedCaseVersion,
            currentVersion: row.caseVersion,
          });
        }
        if (row.caseStageKey !== row.run.currentNodeKey) {
          throw conflict("Pipeline case and graph run nodes diverged", {
            code: "graph_run_case_node_conflict",
            runNodeKey: row.run.currentNodeKey,
            caseNodeKey: row.caseStageKey,
          });
        }
        const currentIssueStateHash = graphReconciliationIssueStateHash(row.issue);
        if (currentIssueStateHash !== input.expectedIssueStateHash) {
          throw conflict("Linked issue changed", {
            code: "graph_reconciliation_issue_conflict",
            expectedIssueStateHash: input.expectedIssueStateHash,
            currentIssueStateHash,
          });
        }

        let run = row.run;
        let caseVersion = row.caseVersion;
        let cycleState = row.run.cycleState;
        let currentNodeKey = row.run.currentNodeKey;
        let lastEvent: typeof pipelineGraphRunEvents.$inferSelect | null = null;

        for (const [index, outcome] of input.outcomes.entries()) {
          const edge = row.graphVersion.definition.edges.find((candidate) =>
            candidate.fromNodeKey === currentNodeKey && candidate.outcome === outcome);
          if (!edge) {
            throw unprocessable("Catch-up outcome is not available from the pinned graph node", {
              code: "graph_catch_up_transition_not_allowed",
              currentNodeKey,
              outcome,
              graphVersionId: run.graphVersionId,
            });
          }
          const targetNode = row.graphVersion.definition.nodes.find((node) => node.key === edge.toNodeKey);
          if (!targetNode) {
            throw unprocessable("Pinned graph catch-up target is missing", {
              code: "graph_transition_target_missing",
              targetNodeKey: edge.toNodeKey,
            });
          }
          const cycle = evolveCycleState({
            definition: row.graphVersion.definition,
            currentNodeKey,
            targetNodeKey: targetNode.key,
            checkpoint: input.checkpoint,
            previous: cycleState,
          });
          if (cycle.interruption) {
            throw unprocessable("Catch-up cannot bypass a graph cycle interruption", {
              code: "graph_catch_up_cycle_interruption",
              interruption: cycle.interruption,
            });
          }
          const caseTransition = await pipelineService(db).transitionCaseWithinTransaction(tx, {
            companyId: input.companyId,
            caseId: run.caseId,
            toStageKey: targetNode.key,
            expectedVersion: caseVersion,
            actor: input.actor,
            transitionClass: "manual",
            reason: input.reason,
            graphRunId: run.id,
            automationLedgers,
          });
          caseVersion = caseTransition.case.version;
          cycleState = cycle.state;
          const terminalStatus = targetNode.kind === "done"
            ? "succeeded"
            : targetNode.kind === "cancelled"
              ? "cancelled"
              : null;
          const [updated] = await tx
            .update(pipelineGraphRuns)
            .set({
              status: terminalStatus ?? "running",
              currentNodeKey: targetNode.key,
              checkpoint: input.checkpoint,
              cycleState,
              revision: run.revision + 1,
              nextEventSequence: run.nextEventSequence + 1,
              pausedAt: null,
              finishedAt: terminalStatus ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(pipelineGraphRuns.id, run.id),
              eq(pipelineGraphRuns.revision, run.revision),
            ))
            .returning();
          if (!updated) {
            throw conflict("Graph run changed", { code: "graph_run_revision_conflict" });
          }
          const eventIdempotencyKey = index === 0
            ? input.idempotencyKey
            : `${input.idempotencyKey}:step:${index + 1}`;
          const [event] = await tx
            .insert(pipelineGraphRunEvents)
            .values({
              companyId: input.companyId,
              runId: run.id,
              sequence: run.nextEventSequence,
              type: "transition_committed",
              nodeKey: targetNode.key,
              outcome,
              ...actorEnvelope(input.actor),
              idempotencyKey: eventIdempotencyKey,
              requestHash: hash,
              payload: {
                revision: updated!.revision,
                checkpoint: input.checkpoint,
                cycleState,
                fromNodeKey: currentNodeKey,
                toNodeKey: targetNode.key,
                status: updated!.status,
                caseVersion,
                catchUp: {
                  step: index + 1,
                  totalSteps: input.outcomes.length,
                  linkedIssueId: input.linkedIssueId,
                  expectedIssueStateHash: input.expectedIssueStateHash,
                  intermediateWakeSuppressed: index < input.outcomes.length - 1,
                },
              },
            })
            .returning();
          run = updated!;
          lastEvent = event!;
          currentNodeKey = targetNode.key;
        }

        const finalNode = row.graphVersion.definition.nodes.find((node) => node.key === currentNodeKey)!;
        const derivedType = run.status === "succeeded"
          ? "run_succeeded"
          : run.status === "cancelled"
            ? "run_cancelled"
            : "wake_requested";
        const [derivedEvent] = await tx
          .insert(pipelineGraphRunEvents)
          .values({
            companyId: input.companyId,
            runId: run.id,
            sequence: run.nextEventSequence,
            type: derivedType,
            nodeKey: currentNodeKey,
            actorType: "system",
            actorId: null,
            actorRunId: null,
            idempotencyKey: `${input.idempotencyKey}:${derivedType}`,
            requestHash: hash,
            payload: {
              runRevision: run.revision,
              targetNodeKey: currentNodeKey,
              status: run.status,
              catchUp: true,
            },
          })
          .returning();
        const [finalRun] = await tx
          .update(pipelineGraphRuns)
          .set({
            nextEventSequence: run.nextEventSequence + 1,
            updatedAt: new Date(),
          })
          .where(and(
            eq(pipelineGraphRuns.id, run.id),
            eq(pipelineGraphRuns.revision, run.revision),
          ))
          .returning();
        if (!finalRun) {
          throw conflict("Graph run changed", { code: "graph_run_revision_conflict" });
        }
        if (derivedType === "wake_requested") {
          const wakeRouting = graphWakeRouting({
            definition: row.graphVersion.definition,
            node: finalNode,
            graphVersionId: finalRun.graphVersionId,
            runId: finalRun.id,
            runRevision: finalRun.revision,
            caseId: finalRun.caseId,
          });
          await tx.insert(pipelineGraphWakeOutbox).values({
            companyId: input.companyId,
            runId: finalRun.id,
            eventId: derivedEvent!.id,
            caseId: finalRun.caseId,
            targetNodeKey: currentNodeKey,
            idempotencyKey: `${finalRun.id}:${finalRun.revision}:${currentNodeKey}`,
            payload: {
              runRevision: finalRun.revision,
              graphVersionId: finalRun.graphVersionId,
              targetNodeKey: currentNodeKey,
              ...wakeRouting,
              reason: "graph_catch_up",
            },
          });
        }
        return {
          changed: true as const,
          run: finalRun,
          event: lastEvent!,
          committed: lastEvent!.payload,
          traversedOutcomes: input.outcomes,
          wakeBehavior: derivedType === "wake_requested" ? "final_only" as const : "none" as const,
        };
      });
      await cancelSupersededHeartbeatRuns({
        companyId: input.companyId,
        graphRunId: input.runId,
        currentRevision: result.run.revision,
        actorRunId: null,
        reason: `Cancelled because graph run ${input.runId} caught up to revision ${result.run.revision}`,
      });
      if (automationLedgers.length > 0) {
        await pipelineService(db).executeTransitionAutomationLedgers(automationLedgers);
      }
      return result;
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
