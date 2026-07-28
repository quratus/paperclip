import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pipelineGraphWakeOutbox } from "@paperclipai/db";
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
      workerId: string;
      limit?: number;
      leaseMs?: number;
      now?: Date;
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
          .where(or(
            and(
              eq(pipelineGraphWakeOutbox.status, "pending"),
              lte(pipelineGraphWakeOutbox.availableAt, now),
            ),
            and(
              eq(pipelineGraphWakeOutbox.status, "claimed"),
              lte(pipelineGraphWakeOutbox.claimExpiresAt, now),
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
          .where(inArray(pipelineGraphWakeOutbox.id, rows.map((row) => row.id)))
          .returning();
      });
    },

    async acknowledge(input: {
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
          eq(pipelineGraphWakeOutbox.id, input.outboxId),
          eq(pipelineGraphWakeOutbox.status, "claimed"),
          eq(pipelineGraphWakeOutbox.claimToken, input.claimToken),
        ))
        .returning();
      if (row) return row;

      const existing = await db
        .select()
        .from(pipelineGraphWakeOutbox)
        .where(eq(pipelineGraphWakeOutbox.id, input.outboxId))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Graph wake outbox item not found");
      if (existing.status === "dispatched" && existing.claimToken === null) {
        if (stableStringify(existing.dispatchReceipt) === stableStringify(input.receipt)) return existing;
        throw conflict("Graph wake receipt differs from the committed receipt", {
          code: "graph_wake_receipt_conflict",
        });
      }
      throw conflict("Graph wake claim is stale", {
        code: "graph_wake_claim_stale",
        status: existing.status,
      });
    },

    async release(input: {
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
          eq(pipelineGraphWakeOutbox.id, input.outboxId),
          eq(pipelineGraphWakeOutbox.status, "claimed"),
          eq(pipelineGraphWakeOutbox.claimToken, input.claimToken),
        ))
        .returning();
      if (!row) {
        throw unprocessable("Graph wake claim cannot be released", {
          code: "graph_wake_claim_stale",
        });
      }
      return row;
    },
  };
}
