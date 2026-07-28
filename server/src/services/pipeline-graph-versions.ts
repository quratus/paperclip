import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  pipelineGraphVersions,
  pipelines,
  pipelineStages,
  pipelineTransitions,
} from "@paperclipai/db";
import {
  compilePipelineGraph,
  type PipelineGraphCycleContractInput,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
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
  };
}
