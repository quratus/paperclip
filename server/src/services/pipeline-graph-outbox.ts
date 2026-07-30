import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  issues,
  pipelineCaseIssueLinks,
  pipelineGraphRuns,
  pipelineGraphVersions,
  pipelineGraphWakeOutbox,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function pipelineGraphOutboxService(db: Db) {
  return {
    async claim(input: {
      companyId: string;
      workerId: string;
      limit?: number;
      leaseMs?: number;
      now?: Date;
      dispatchableOnly?: boolean;
    }) {
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
      const leaseMs = Math.min(Math.max(input.leaseMs ?? 30_000, 1_000), 300_000);
      const now = input.now ?? new Date();
      const expiresAt = new Date(now.getTime() + leaseMs);
      const claimToken = randomUUID();

      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: pipelineGraphWakeOutbox.id })
          .from(pipelineGraphWakeOutbox)
          .where(and(
            eq(pipelineGraphWakeOutbox.companyId, input.companyId),
            input.dispatchableOnly
              ? sql`${pipelineGraphWakeOutbox.payload} ->> 'dispatchEnabled' = 'true'`
              : undefined,
            or(
              and(
                eq(pipelineGraphWakeOutbox.status, "pending"),
                lte(pipelineGraphWakeOutbox.availableAt, now),
              ),
              and(
                eq(pipelineGraphWakeOutbox.status, "claimed"),
                lte(pipelineGraphWakeOutbox.claimExpiresAt, now),
              ),
            ),
          ))
          .orderBy(asc(pipelineGraphWakeOutbox.availableAt), asc(pipelineGraphWakeOutbox.createdAt))
          .limit(limit)
          .for("update", { skipLocked: true });
        if (rows.length === 0) return [];

        return tx
          .update(pipelineGraphWakeOutbox)
          .set({
            status: "claimed",
            claimToken,
            claimedBy: input.workerId,
            claimedAt: now,
            claimExpiresAt: expiresAt,
            attemptCount: sql`${pipelineGraphWakeOutbox.attemptCount} + 1`,
            lastError: null,
            updatedAt: now,
          })
          .where(and(
            eq(pipelineGraphWakeOutbox.companyId, input.companyId),
            inArray(pipelineGraphWakeOutbox.id, rows.map((row) => row.id)),
          ))
          .returning();
      });
    },

    async acknowledge(input: {
      companyId: string;
      outboxId: string;
      claimToken: string;
      receipt: Record<string, unknown>;
      now?: Date;
    }) {
      const now = input.now ?? new Date();
      const [row] = await db
        .update(pipelineGraphWakeOutbox)
        .set({
          status: "dispatched",
          claimToken: null,
          claimedBy: null,
          claimExpiresAt: null,
          dispatchedAt: now,
          dispatchReceipt: input.receipt,
          updatedAt: now,
        })
        .where(and(
          eq(pipelineGraphWakeOutbox.companyId, input.companyId),
          eq(pipelineGraphWakeOutbox.id, input.outboxId),
          eq(pipelineGraphWakeOutbox.status, "claimed"),
          eq(pipelineGraphWakeOutbox.claimToken, input.claimToken),
        ))
        .returning();
      if (row) return row;

      const existing = await db
        .select()
        .from(pipelineGraphWakeOutbox)
        .where(and(
          eq(pipelineGraphWakeOutbox.companyId, input.companyId),
          eq(pipelineGraphWakeOutbox.id, input.outboxId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Graph wake outbox item not found");
      if (existing.status === "dispatched" && existing.claimToken === null) {
        if (stableStringify(existing.dispatchReceipt) === stableStringify(input.receipt)) return existing;
        throw conflict("Graph wake receipt differs from the committed receipt", {
          code: "graph_wake_receipt_conflict",
        });
      }
      if (existing.status === "cancelled") return existing;
      throw conflict("Graph wake claim is stale", {
        code: "graph_wake_claim_stale",
        status: existing.status,
      });
    },

    async dispatchPending(input: {
      companyId: string;
      workerId: string;
      enabled?: boolean;
      limit?: number;
      leaseMs?: number;
      now?: Date;
      retryDelayMs?: number;
      wakeup: (agentId: string, opts: {
        source: "automation";
        triggerDetail: "system";
        reason: string;
        payload: Record<string, unknown>;
        contextSnapshot: Record<string, unknown>;
        idempotencyKey: string;
        requestedByActorType: "system";
        requestedByActorId: string;
      }) => Promise<{ id: string; wakeupRequestId?: string | null } | null>;
    }) {
      if (!input.enabled) return { claimed: 0, dispatched: 0, retried: 0 };
      const rows = await this.claim({ ...input, dispatchableOnly: true });
      let dispatched = 0;
      let retried = 0;
      const retryDelayMs = Math.max(input.retryDelayMs ?? 5_000, 0);
      for (const row of rows) {
        const payload = row.payload ?? {};
        const expectedRevision = typeof payload.runRevision === "number"
          ? payload.runRevision
          : null;
        const graphRun = await db
          .select({
            status: pipelineGraphRuns.status,
            revision: pipelineGraphRuns.revision,
            graphVersionId: pipelineGraphRuns.graphVersionId,
          })
          .from(pipelineGraphRuns)
          .where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.id, row.runId),
          ))
          .then((runRows) => runRows[0] ?? null);
        if (
          !graphRun ||
          !["running", "paused"].includes(graphRun.status) ||
          expectedRevision === null ||
          graphRun.revision !== expectedRevision
        ) {
          await this.cancelClaim({
            companyId: input.companyId,
            outboxId: row.id,
            claimToken: row.claimToken!,
            reason: "Graph wake superseded by graph run status or revision",
            now: input.now,
          });
          continue;
        }
        const targetAgentId = typeof payload.targetAgentId === "string" ? payload.targetAgentId : null;
        if (payload.dispatchEnabled !== true || !targetAgentId) {
          await this.release({
            companyId: input.companyId,
            outboxId: row.id,
            claimToken: row.claimToken!,
            error: "Graph wake dispatch requires dispatchEnabled=true and payload.targetAgentId",
            terminal: true,
            now: input.now,
          });
          continue;
        }
        const [targetAgent] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(
            eq(agents.companyId, input.companyId),
            eq(agents.id, targetAgentId),
          ))
          .limit(1);
        if (!targetAgent) {
          await this.release({
            companyId: input.companyId,
            outboxId: row.id,
            claimToken: row.claimToken!,
            error: "Graph wake target agent does not belong to the outbox company",
            terminal: true,
            now: input.now,
          });
          continue;
        }
        const linkedIssue = await db
          .select({ id: issues.id })
          .from(pipelineCaseIssueLinks)
          .innerJoin(issues, eq(pipelineCaseIssueLinks.issueId, issues.id))
          .where(and(
            eq(pipelineCaseIssueLinks.companyId, input.companyId),
            eq(pipelineCaseIssueLinks.caseId, row.caseId),
            inArray(pipelineCaseIssueLinks.role, ["work", "origin"]),
            isNull(pipelineCaseIssueLinks.retiredAt),
            eq(issues.companyId, input.companyId),
          ))
          .orderBy(
            sql`case when ${pipelineCaseIssueLinks.role} = 'work' then 0 else 1 end`,
            desc(pipelineCaseIssueLinks.createdAt),
          )
          .limit(1)
          .then((issueRows) => issueRows[0] ?? null);
        try {
          let rawGraphAssignment =
            payload.graphAssignment
            && typeof payload.graphAssignment === "object"
            && !Array.isArray(payload.graphAssignment)
              ? payload.graphAssignment as Record<string, unknown>
              : null;
          if (!rawGraphAssignment) {
            const graphVersion = await db
              .select({ definition: pipelineGraphVersions.definition })
              .from(pipelineGraphVersions)
              .where(and(
                eq(pipelineGraphVersions.companyId, input.companyId),
                eq(pipelineGraphVersions.id, graphRun.graphVersionId),
              ))
              .then((versionRows) => versionRows[0] ?? null);
            const node = graphVersion?.definition.nodes.find(
              (candidate) => candidate.key === row.targetNodeKey,
            );
            if (!node) {
              throw new Error("Pinned graph node is unavailable for legacy wake assignment upgrade");
            }
            const responsibilityOwner =
              typeof payload.responsibilityOwner === "string" && payload.responsibilityOwner.trim()
                ? payload.responsibilityOwner.trim()
                : typeof node.config.responsibilityOwner === "string"
                    && node.config.responsibilityOwner.trim()
                  ? node.config.responsibilityOwner.trim()
                  : node.key;
            const instruction =
              typeof payload.responsibilityInstruction === "string"
                && payload.responsibilityInstruction.trim()
                ? payload.responsibilityInstruction.trim()
                : typeof node.config.responsibilityInstruction === "string"
                    && node.config.responsibilityInstruction.trim()
                  ? node.config.responsibilityInstruction.trim()
                  : null;
            rawGraphAssignment = {
              schemaVersion: 1,
              id: `${row.runId}:${expectedRevision}:${row.targetNodeKey}`,
              graphVersionId: graphRun.graphVersionId,
              runId: row.runId,
              runRevision: expectedRevision,
              caseId: row.caseId,
              nodeKey: row.targetNodeKey,
              nodeKind: node.kind,
              responsibilityOwner,
              targetAgentId,
              instruction,
              acceptanceCriteria: Array.isArray(node.config.acceptanceCriteria)
                ? node.config.acceptanceCriteria.filter(
                    (criterion): criterion is string =>
                      typeof criterion === "string" && criterion.trim().length > 0,
                  )
                : [],
              allowedOutcomes: graphVersion.definition.edges
                .filter((edge) => edge.fromNodeKey === row.targetNodeKey)
                .map((edge) => edge.outcome)
                .sort(),
              completion: {
                method: "POST",
                path: `/api/graph-runs/${row.runId}/transitions`,
                requiredFields: ["expectedRevision", "idempotencyKey", "outcome", "checkpoint"],
              },
            };
          }
          const graphAssignment = {
            ...rawGraphAssignment,
            targetAgentId,
            ...(linkedIssue ? { issueId: linkedIssue.id } : {}),
          };
          const run = await input.wakeup(targetAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "pipeline_graph_wake",
            idempotencyKey: row.idempotencyKey,
            requestedByActorType: "system",
            requestedByActorId: "pipeline_graph_outbox",
            payload: {
              ...payload,
              graphRunId: row.runId,
              graphEventId: row.eventId,
              pipelineCaseId: row.caseId,
              targetNodeKey: row.targetNodeKey,
              ...(linkedIssue ? { issueId: linkedIssue.id, taskId: linkedIssue.id } : {}),
            },
            contextSnapshot: {
              pipelineGraphWake: true,
              graphRunId: row.runId,
              graphRunRevision: payload.runRevision,
              graphEventId: row.eventId,
              pipelineCaseId: row.caseId,
              targetNodeKey: row.targetNodeKey,
              responsibilityOwner: payload.responsibilityOwner ?? row.targetNodeKey,
              graphAssignment,
              ...(linkedIssue
                ? { issueId: linkedIssue.id, taskId: linkedIssue.id }
                : {}),
            },
          });
          if (!run) throw new Error("Heartbeat wake was not accepted");
          const acknowledged = await this.acknowledge({
            companyId: input.companyId,
            outboxId: row.id,
            claimToken: row.claimToken!,
            receipt: {
              accepted: true,
              heartbeatRunId: run.id,
              wakeupRequestId: run.wakeupRequestId ?? null,
              issueId: linkedIssue?.id ?? null,
            },
            now: input.now,
          });
          if (acknowledged.status === "dispatched") dispatched += 1;
        } catch (error) {
          const current = await db
            .select({ status: pipelineGraphWakeOutbox.status })
            .from(pipelineGraphWakeOutbox)
            .where(and(
              eq(pipelineGraphWakeOutbox.companyId, input.companyId),
              eq(pipelineGraphWakeOutbox.id, row.id),
            ))
            .then((outboxRows) => outboxRows[0] ?? null);
          if (current?.status !== "cancelled") {
            await this.release({
              companyId: input.companyId,
              outboxId: row.id,
              claimToken: row.claimToken!,
              error: error instanceof Error ? error.message : "Graph wake dispatch failed",
              retryAt: new Date((input.now ?? new Date()).getTime() + retryDelayMs),
              now: input.now,
            });
            retried += 1;
          }
        }
      }
      return { claimed: rows.length, dispatched, retried };
    },

    async cancelClaim(input: {
      companyId: string;
      outboxId: string;
      claimToken: string;
      reason: string;
      now?: Date;
    }) {
      const now = input.now ?? new Date();
      const [row] = await db
        .update(pipelineGraphWakeOutbox)
        .set({
          status: "cancelled",
          claimToken: null,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastError: input.reason,
          updatedAt: now,
        })
        .where(and(
          eq(pipelineGraphWakeOutbox.companyId, input.companyId),
          eq(pipelineGraphWakeOutbox.id, input.outboxId),
          eq(pipelineGraphWakeOutbox.status, "claimed"),
          eq(pipelineGraphWakeOutbox.claimToken, input.claimToken),
        ))
        .returning();
      if (row) return row;
      const existing = await db
        .select()
        .from(pipelineGraphWakeOutbox)
        .where(and(
          eq(pipelineGraphWakeOutbox.companyId, input.companyId),
          eq(pipelineGraphWakeOutbox.id, input.outboxId),
        ))
        .then((existingRows) => existingRows[0] ?? null);
      if (!existing) throw notFound("Graph wake outbox item not found");
      if (existing.status === "cancelled") return existing;
      throw conflict("Graph wake claim is stale", {
        code: "graph_wake_claim_stale",
        status: existing.status,
      });
    },

    async release(input: {
      companyId: string;
      outboxId: string;
      claimToken: string;
      error: string;
      retryAt?: Date;
      terminal?: boolean;
      now?: Date;
    }) {
      const now = input.now ?? new Date();
      const [row] = await db
        .update(pipelineGraphWakeOutbox)
        .set({
          status: input.terminal ? "failed" : "pending",
          claimToken: null,
          claimedBy: null,
          claimExpiresAt: null,
          claimedAt: null,
          availableAt: input.retryAt ?? now,
          lastError: input.error,
          updatedAt: now,
        })
        .where(and(
          eq(pipelineGraphWakeOutbox.companyId, input.companyId),
          eq(pipelineGraphWakeOutbox.id, input.outboxId),
          eq(pipelineGraphWakeOutbox.status, "claimed"),
          eq(pipelineGraphWakeOutbox.claimToken, input.claimToken),
        ))
        .returning();
      if (!row) {
        const existing = await db
          .select()
          .from(pipelineGraphWakeOutbox)
          .where(and(
            eq(pipelineGraphWakeOutbox.companyId, input.companyId),
            eq(pipelineGraphWakeOutbox.id, input.outboxId),
          ))
          .then((rows) => rows[0] ?? null);
        if (existing?.status === "cancelled") return existing;
        throw unprocessable("Graph wake claim cannot be released", {
          code: "graph_wake_claim_stale",
        });
      }
      return row;
    },
  };
}
