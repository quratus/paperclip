import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  pipelineGraphAdoptions,
  pipelineGraphVersions,
  pipelines,
  pipelineStages,
  pipelineTransitions,
} from "@paperclipai/db";
import {
  compilePipelineGraph,
  PIPELINE_GRAPH_ASSIGNMENT_SCHEMA_VERSION,
  type PipelineGraphCycleContractInput,
  type PipelineGraphDefinitionInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

type PipelineGraphDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PipelineGraphVersionActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string; runId: string };

export type PipelineGraphCompileInput = {
  companyId: string;
  pipelineId: string;
  entryNodeKey: string;
  cycleContracts?: PipelineGraphCycleContractInput[];
};

export function decodePipelineGraphVersionCursor(cursor: string) {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return null;
    if (!/^[1-9]\d{0,9}$/.test(decoded)) return null;
    const version = Number(decoded);
    return Number.isInteger(version) && version <= 2_147_483_647 ? version : null;
  } catch {
    return null;
  }
}

function encodePipelineGraphVersionCursor(version: number) {
  return Buffer.from(String(version), "utf8").toString("base64url");
}

function definitionHash(canonicalJson: string) {
  return createHash("sha256").update(canonicalJson).digest("hex");
}

function adoptionRequestHash(input: {
  canonicalJson: string;
  expectedActiveVersionId: string | null;
  expectedActiveDefinitionHash: string | null;
  requiredAssignmentSchemaVersion?: number;
}) {
  return definitionHash(JSON.stringify({
    definition: JSON.parse(input.canonicalJson),
    expectedActiveVersionId: input.expectedActiveVersionId,
    expectedActiveDefinitionHash: input.expectedActiveDefinitionHash,
    requiredAssignmentSchemaVersion: input.requiredAssignmentSchemaVersion ?? null,
  }));
}

async function assertPipeline(
  dbOrTx: PipelineGraphDb,
  companyId: string,
  pipelineId: string,
) {
  const pipeline = await dbOrTx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!pipeline) throw notFound("Pipeline not found");
}

async function assertDefinitionTargets(
  dbOrTx: PipelineGraphDb,
  companyId: string,
  definition: PipelineGraphDefinitionInput,
  actor: PipelineGraphVersionActor,
) {
  for (const node of definition.nodes) {
    const effectType = typeof node.config?.requiredEffectType === "string"
      ? node.config.requiredEffectType.trim()
      : "";
    if (!effectType) continue;
    if (
      actor.type !== "user"
      || effectType !== "github.merge"
      || node.config?.requiredAuthorityClass !== "merge.exact_sha"
      || node.config?.effectExecutorType !== "agent"
      || node.config?.effectExecutorId !== node.config?.targetAgentId
      || node.config?.effectExecutorKeyId !== "botinsky.github-merge.v1"
      || !Array.isArray(node.config?.requiredEffectOutcomes)
      || node.config.requiredEffectOutcomes.length !== 1
      || node.config.requiredEffectOutcomes[0] !== "merged"
    ) {
      throw unprocessable("Pipeline graph effect policy is not kernel-authorized", {
        code: "pipeline_graph_effect_policy_invalid",
        nodeKey: node.key,
        effectType,
      });
    }
  }
  const targetAgentIds = [...new Set(definition.nodes.flatMap((node) => {
    const targetAgentId = node.config?.targetAgentId;
    if (targetAgentId === undefined) return [];
    if (
      typeof targetAgentId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetAgentId)
    ) {
      throw unprocessable("Pipeline graph target agent is invalid", {
        code: "pipeline_graph_target_agent_invalid",
        nodeKey: node.key,
      });
    }
    return [targetAgentId];
  }))];
  if (targetAgentIds.length === 0) return;
  const companyAgents = await dbOrTx
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, targetAgentIds)))
    .for("update");
  const found = new Set(companyAgents.map((agent) => agent.id));
  const missingAgentIds = targetAgentIds.filter((agentId) => !found.has(agentId));
  if (missingAgentIds.length > 0) {
    throw unprocessable("Pipeline graph target agent is outside the target company", {
      code: "pipeline_graph_target_agent_company_mismatch",
      targetAgentIds: missingAgentIds,
    });
  }
  const eligibleStatuses = new Set(["active", "idle", "running", "error", "at_capacity"]);
  const ineligible = companyAgents
    .filter((agent) => !eligibleStatuses.has(agent.status))
    .map((agent) => ({ id: agent.id, status: agent.status }));
  if (ineligible.length > 0) {
    throw unprocessable("Pipeline graph target agent is not eligible for dispatch", {
      code: "pipeline_graph_target_agent_ineligible",
      agents: ineligible,
    });
  }
}

async function compileCurrentPipeline(
  dbOrTx: PipelineGraphDb,
  input: PipelineGraphCompileInput,
) {
  await assertPipeline(dbOrTx, input.companyId, input.pipelineId);
  const [stages, transitions] = await Promise.all([
    dbOrTx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, input.pipelineId)),
    dbOrTx
      .select()
      .from(pipelineTransitions)
      .where(eq(pipelineTransitions.pipelineId, input.pipelineId)),
  ]);
  const stageKeyById = new Map(stages.map((stage) => [stage.id, stage.key]));
  const result = compilePipelineGraph({
    entryNodeKey: input.entryNodeKey,
    nodes: stages.map((stage) => ({
      key: stage.key,
      name: stage.name,
      kind: stage.kind as "working" | "review" | "done" | "cancelled",
      position: stage.position,
      config: stage.config,
    })),
    edges: transitions.map((transition) => ({
      fromNodeKey: stageKeyById.get(transition.fromStageId) ?? transition.fromStageId,
      toNodeKey: stageKeyById.get(transition.toStageId) ?? transition.toStageId,
      outcome: transition.label,
    })),
    cycleContracts: input.cycleContracts,
  });
  return result.ok
    ? { ...result, definitionHash: definitionHash(result.canonicalJson) }
    : { ...result, definitionHash: null };
}

export function pipelineGraphVersionService(db: Db) {
  return {
    compilePreview(input: PipelineGraphCompileInput) {
      return compileCurrentPipeline(db, input);
    },

    async createDraft(input: PipelineGraphCompileInput & { actor: PipelineGraphVersionActor }) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"pipeline-graph-version:" + input.pipelineId}, 0))`,
        );
        const compiled = await compileCurrentPipeline(tx, input);
        if (!compiled.ok) {
          throw unprocessable("Pipeline graph is invalid", {
            code: "pipeline_graph_invalid",
            diagnostics: compiled.diagnostics,
          });
        }
        await assertDefinitionTargets(tx, input.companyId, compiled.definition, input.actor);
        const existing = await tx
          .select()
          .from(pipelineGraphVersions)
          .where(and(
            eq(pipelineGraphVersions.companyId, input.companyId),
            eq(pipelineGraphVersions.pipelineId, input.pipelineId),
            eq(pipelineGraphVersions.definitionHash, compiled.definitionHash),
          ))
          .then((rows) => rows[0] ?? null);
        if (existing) return { created: false as const, version: existing };

        const latest = await tx
          .select({ version: pipelineGraphVersions.version })
          .from(pipelineGraphVersions)
          .where(and(
            eq(pipelineGraphVersions.companyId, input.companyId),
            eq(pipelineGraphVersions.pipelineId, input.pipelineId),
          ))
          .orderBy(desc(pipelineGraphVersions.version))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const [created] = await tx
          .insert(pipelineGraphVersions)
          .values({
            companyId: input.companyId,
            pipelineId: input.pipelineId,
            version: (latest?.version ?? 0) + 1,
            definitionHash: compiled.definitionHash,
            schemaVersion: compiled.definition.schemaVersion,
            definition: compiled.definition,
            status: "draft",
            createdByType: input.actor.type,
            createdById: input.actor.type === "user" ? input.actor.userId : input.actor.agentId,
          })
          .returning();
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: input.actor.type,
          actorId: input.actor.type === "user" ? input.actor.userId : input.actor.agentId,
          agentId: input.actor.type === "agent" ? input.actor.agentId : null,
          runId: input.actor.type === "agent" ? input.actor.runId : null,
          action: "pipeline.graph_version_created",
          entityType: "pipeline",
          entityId: input.pipelineId,
          details: {
            graphVersionId: created!.id,
            version: created!.version,
            definitionHash: created!.definitionHash,
          },
        });
        return { created: true as const, version: created! };
      });
    },

    async list(input: {
      companyId: string;
      pipelineId: string;
      beforeVersion?: number;
      limit: number;
    }) {
      await assertPipeline(db, input.companyId, input.pipelineId);
      const rows = await db
        .select()
        .from(pipelineGraphVersions)
        .where(and(
          eq(pipelineGraphVersions.companyId, input.companyId),
          eq(pipelineGraphVersions.pipelineId, input.pipelineId),
          input.beforeVersion === undefined
            ? undefined
            : lt(pipelineGraphVersions.version, input.beforeVersion),
        ))
        .orderBy(desc(pipelineGraphVersions.version))
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const versions = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        versions,
        nextCursor: hasMore ? encodePipelineGraphVersionCursor(versions.at(-1)!.version) : null,
      };
    },

    async get(input: { companyId: string; pipelineId: string; versionId: string }) {
      await assertPipeline(db, input.companyId, input.pipelineId);
      const version = await db
        .select()
        .from(pipelineGraphVersions)
        .where(and(
          eq(pipelineGraphVersions.id, input.versionId),
          eq(pipelineGraphVersions.companyId, input.companyId),
          eq(pipelineGraphVersions.pipelineId, input.pipelineId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!version) throw notFound("Pipeline graph version not found");
      return version;
    },

    async activate(input: {
      companyId: string;
      pipelineId: string;
      versionId: string;
      expectedActiveVersionId: string | null;
      actor: PipelineGraphVersionActor;
    }) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"pipeline-graph-version:" + input.pipelineId}, 0))`,
        );
        await assertPipeline(tx, input.companyId, input.pipelineId);
        const selected = await tx
          .select()
          .from(pipelineGraphVersions)
          .where(and(
            eq(pipelineGraphVersions.id, input.versionId),
            eq(pipelineGraphVersions.companyId, input.companyId),
            eq(pipelineGraphVersions.pipelineId, input.pipelineId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!selected) throw notFound("Pipeline graph version not found");
        if (selected.status === "active") return { changed: false as const, version: selected };
        if (selected.status !== "draft") {
          throw unprocessable("Retired graph versions cannot be reactivated", {
            code: "pipeline_graph_version_retired",
          });
        }
        await assertDefinitionTargets(tx, input.companyId, selected.definition, input.actor);
        const currentActive = await tx
          .select({ id: pipelineGraphVersions.id })
          .from(pipelineGraphVersions)
          .where(and(
            eq(pipelineGraphVersions.companyId, input.companyId),
            eq(pipelineGraphVersions.pipelineId, input.pipelineId),
            eq(pipelineGraphVersions.status, "active"),
          ))
          .then((rows) => rows[0] ?? null);
        if ((currentActive?.id ?? null) !== input.expectedActiveVersionId) {
          throw conflict("Active graph version changed", {
            code: "pipeline_graph_activation_conflict",
            expectedActiveVersionId: input.expectedActiveVersionId,
            currentActiveVersionId: currentActive?.id ?? null,
          });
        }

        const now = new Date();
        await tx
          .update(pipelineGraphVersions)
          .set({ status: "retired", retiredAt: now, updatedAt: now })
          .where(and(
            eq(pipelineGraphVersions.companyId, input.companyId),
            eq(pipelineGraphVersions.pipelineId, input.pipelineId),
            eq(pipelineGraphVersions.status, "active"),
          ));
        const actorId = input.actor.type === "user" ? input.actor.userId : input.actor.agentId;
        const [activated] = await tx
          .update(pipelineGraphVersions)
          .set({
            status: "active",
            activatedByType: input.actor.type,
            activatedById: actorId,
            activatedAt: now,
            retiredAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(pipelineGraphVersions.id, input.versionId),
            eq(pipelineGraphVersions.status, "draft"),
          ))
          .returning();
        if (!activated) {
          throw unprocessable("Graph version is no longer activatable", {
            code: "pipeline_graph_version_not_draft",
          });
        }
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: input.actor.type,
          actorId,
          agentId: input.actor.type === "agent" ? input.actor.agentId : null,
          runId: input.actor.type === "agent" ? input.actor.runId : null,
          action: "pipeline.graph_version_activated",
          entityType: "pipeline",
          entityId: input.pipelineId,
          details: {
            graphVersionId: activated.id,
            version: activated.version,
            definitionHash: activated.definitionHash,
          },
        });
        return { changed: true as const, version: activated };
      });
    },

    async adoptDefinition(input: {
      companyId: string;
      pipelineId: string;
      definition: PipelineGraphDefinitionInput;
      expectedActiveVersionId: string | null;
      expectedActiveDefinitionHash: string | null;
      requiredAssignmentSchemaVersion?: number;
      idempotencyKey: string;
      actor: PipelineGraphVersionActor;
    }) {
      const compiled = compilePipelineGraph(input.definition);
      if (!compiled.ok) {
        throw unprocessable("Pipeline graph is invalid", {
          code: "pipeline_graph_invalid",
          diagnostics: compiled.diagnostics,
        });
      }
      if (
        input.requiredAssignmentSchemaVersion !== undefined
        && input.requiredAssignmentSchemaVersion !== PIPELINE_GRAPH_ASSIGNMENT_SCHEMA_VERSION
      ) {
        throw unprocessable("Required pipeline graph assignment schema is unsupported", {
          code: "pipeline_graph_assignment_schema_unsupported",
          requiredAssignmentSchemaVersion: input.requiredAssignmentSchemaVersion,
          supportedAssignmentSchemaVersions: [PIPELINE_GRAPH_ASSIGNMENT_SCHEMA_VERSION],
        });
      }
      const desiredDefinitionHash = definitionHash(compiled.canonicalJson);
      const requestHash = adoptionRequestHash({
        canonicalJson: compiled.canonicalJson,
        expectedActiveVersionId: input.expectedActiveVersionId,
        expectedActiveDefinitionHash: input.expectedActiveDefinitionHash,
        requiredAssignmentSchemaVersion: input.requiredAssignmentSchemaVersion,
      });

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"pipeline-graph-version:" + input.pipelineId}, 0))`,
        );
        await assertPipeline(tx, input.companyId, input.pipelineId);
        await assertDefinitionTargets(tx, input.companyId, input.definition, input.actor);

        const replay = await tx
          .select()
          .from(pipelineGraphAdoptions)
          .where(and(
            eq(pipelineGraphAdoptions.companyId, input.companyId),
            eq(pipelineGraphAdoptions.pipelineId, input.pipelineId),
            eq(pipelineGraphAdoptions.idempotencyKey, input.idempotencyKey),
          ))
          .then((rows) => rows[0] ?? null);
        if (replay) {
          if (replay.requestHash !== requestHash) {
            throw conflict("Idempotency key was already used for a different graph adoption", {
              code: "pipeline_graph_adoption_idempotency_conflict",
              adoptionId: replay.id,
            });
          }
          const version = await tx
            .select()
            .from(pipelineGraphVersions)
            .where(and(
              eq(pipelineGraphVersions.companyId, input.companyId),
              eq(pipelineGraphVersions.pipelineId, input.pipelineId),
              eq(pipelineGraphVersions.id, replay.resultVersionId),
            ))
            .then((rows) => rows[0] ?? null);
          if (!version) throw notFound("Adopted pipeline graph version not found");
          return {
            adoptionId: replay.id,
            changed: replay.changed,
            restored: replay.restored,
            replayed: true as const,
            wakeBehavior: "none" as const,
            version,
          };
        }

        const currentActive = await tx
          .select()
          .from(pipelineGraphVersions)
          .where(and(
            eq(pipelineGraphVersions.companyId, input.companyId),
            eq(pipelineGraphVersions.pipelineId, input.pipelineId),
            eq(pipelineGraphVersions.status, "active"),
          ))
          .then((rows) => rows[0] ?? null);
        const currentActiveVersionId = currentActive?.id ?? null;
        const currentActiveDefinitionHash = currentActive?.definitionHash ?? null;
        if (
          currentActiveVersionId !== input.expectedActiveVersionId ||
          currentActiveDefinitionHash !== input.expectedActiveDefinitionHash
        ) {
          throw conflict("Active graph version changed", {
            code: "pipeline_graph_adoption_conflict",
            expectedActiveVersionId: input.expectedActiveVersionId,
            currentActiveVersionId,
            expectedActiveDefinitionHash: input.expectedActiveDefinitionHash,
            currentActiveDefinitionHash,
          });
        }

        let changed = currentActiveDefinitionHash !== desiredDefinitionHash;
        let restored = false;
        let resultVersion = currentActive;
        const actorId = input.actor.type === "user" ? input.actor.userId : input.actor.agentId;
        const now = new Date();

        if (changed) {
          const existing = await tx
            .select()
            .from(pipelineGraphVersions)
            .where(and(
              eq(pipelineGraphVersions.companyId, input.companyId),
              eq(pipelineGraphVersions.pipelineId, input.pipelineId),
              eq(pipelineGraphVersions.definitionHash, desiredDefinitionHash),
            ))
            .then((rows) => rows[0] ?? null);

          await tx
            .update(pipelineGraphVersions)
            .set({ status: "retired", retiredAt: now, updatedAt: now })
            .where(and(
              eq(pipelineGraphVersions.companyId, input.companyId),
              eq(pipelineGraphVersions.pipelineId, input.pipelineId),
              eq(pipelineGraphVersions.status, "active"),
            ));

          if (existing) {
            restored = existing.status === "retired";
            const [activated] = await tx
              .update(pipelineGraphVersions)
              .set({
                status: "active",
                activatedByType: input.actor.type,
                activatedById: actorId,
                activatedAt: now,
                retiredAt: null,
                updatedAt: now,
              })
              .where(and(
                eq(pipelineGraphVersions.companyId, input.companyId),
                eq(pipelineGraphVersions.pipelineId, input.pipelineId),
                eq(pipelineGraphVersions.id, existing.id),
                eq(pipelineGraphVersions.status, existing.status),
              ))
              .returning();
            resultVersion = activated ?? null;
          } else {
            const latest = await tx
              .select({ version: pipelineGraphVersions.version })
              .from(pipelineGraphVersions)
              .where(and(
                eq(pipelineGraphVersions.companyId, input.companyId),
                eq(pipelineGraphVersions.pipelineId, input.pipelineId),
              ))
              .orderBy(desc(pipelineGraphVersions.version))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            const [created] = await tx
              .insert(pipelineGraphVersions)
              .values({
                companyId: input.companyId,
                pipelineId: input.pipelineId,
                version: (latest?.version ?? 0) + 1,
                definitionHash: desiredDefinitionHash,
                schemaVersion: compiled.definition.schemaVersion,
                definition: compiled.definition,
                status: "active",
                createdByType: input.actor.type,
                createdById: actorId,
                activatedByType: input.actor.type,
                activatedById: actorId,
                activatedAt: now,
              })
              .returning();
            resultVersion = created ?? null;
          }
          if (!resultVersion) {
            throw conflict("Graph version changed during adoption", {
              code: "pipeline_graph_adoption_race",
            });
          }
        }

        if (!resultVersion) {
          throw conflict("No active graph version matched the adoption fence", {
            code: "pipeline_graph_adoption_missing_active",
          });
        }

        const [adoption] = await tx
          .insert(pipelineGraphAdoptions)
          .values({
            companyId: input.companyId,
            pipelineId: input.pipelineId,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            expectedActiveVersionId: input.expectedActiveVersionId,
            expectedActiveDefinitionHash: input.expectedActiveDefinitionHash,
            resultVersionId: resultVersion.id,
            resultDefinitionHash: resultVersion.definitionHash,
            changed,
            restored,
          })
          .returning();
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: input.actor.type,
          actorId,
          agentId: input.actor.type === "agent" ? input.actor.agentId : null,
          runId: input.actor.type === "agent" ? input.actor.runId : null,
          action: "pipeline.graph_definition_adopted",
          entityType: "pipeline",
          entityId: input.pipelineId,
          details: {
            adoptionId: adoption!.id,
            idempotencyKey: input.idempotencyKey,
            graphVersionId: resultVersion.id,
            version: resultVersion.version,
            definitionHash: resultVersion.definitionHash,
            changed,
            restored,
            wakeBehavior: "none",
          },
        });
        return {
          adoptionId: adoption!.id,
          changed,
          restored,
          replayed: false as const,
          wakeBehavior: "none" as const,
          version: resultVersion,
        };
      });
    },
  };
}
