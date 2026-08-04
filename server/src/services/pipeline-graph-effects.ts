import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  heartbeatRuns,
  pipelineGraphEffectAttempts,
  pipelineGraphRoleBindings,
  pipelineGraphRuns,
  pipelineGraphVersions,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { PipelineGraphVersionActor } from "./pipeline-graph-versions.js";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function hash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function actorId(actor: PipelineGraphVersionActor) {
  return actor.type === "user" ? actor.userId : actor.agentId;
}

type ExecutorAttestation = {
  keyId: string;
  controllerBuildId: string;
  subjectHash: string;
  action: "request" | "claim" | "complete" | "fail";
  actionHash: string;
  signature: string;
};

function verifyExecutorAttestation(input: {
  attestation: ExecutorAttestation;
  requiredKeyId: string;
  subjectHash: string;
  action: ExecutorAttestation["action"];
  actionHash: string;
}) {
  const attestation = input.attestation;
  if (
    attestation.keyId !== input.requiredKeyId
    || attestation.subjectHash !== input.subjectHash
    || attestation.action !== input.action
    || attestation.actionHash !== input.actionHash
  ) {
    throw forbidden("Executor attestation is not bound to the exact effect action", {
      code: "effect_executor_attestation_mismatch",
    });
  }
  let keys: Record<string, { publicKey: string; controllerBuildIds: string[] }>;
  try {
    keys = JSON.parse(process.env.PAPERCLIP_EFFECT_EXECUTOR_KEYS_JSON ?? "{}") as Record<
      string,
      { publicKey: string; controllerBuildIds: string[] }
    >;
  } catch {
    throw forbidden("Effect executor key registry is invalid", {
      code: "effect_executor_key_registry_invalid",
    });
  }
  const message = pipelineGraphExecutorAttestationMessage({
    keyId: attestation.keyId,
    controllerBuildId: attestation.controllerBuildId,
    subjectHash: attestation.subjectHash,
    action: attestation.action,
    actionHash: attestation.actionHash,
  });
  let valid = false;
  try {
    const key = keys[attestation.keyId];
    valid = Boolean(key?.publicKey)
      && Array.isArray(key.controllerBuildIds)
      && key.controllerBuildIds.includes(attestation.controllerBuildId)
      && verify(
      null,
      Buffer.from(message),
      createPublicKey(key.publicKey),
      Buffer.from(attestation.signature, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw forbidden("Executor attestation signature is invalid", {
      code: "effect_executor_attestation_invalid",
      keyId: attestation.keyId,
    });
  }
}

export function pipelineGraphEffectSubjectHash(input: {
  effectType: string;
  targetRef: Record<string, unknown>;
  payloadHash: string;
}) {
  return hash({
    effectType: input.effectType,
    targetRef: input.targetRef,
    payloadHash: input.payloadHash,
  });
}

export function pipelineGraphEffectTargetRefHash(targetRef: Record<string, unknown>) {
  return hash(targetRef);
}

export function pipelineGraphEffectActionHash(value: unknown) {
  return hash(value);
}

export function pipelineGraphExecutorAttestationMessage(
  attestation: Omit<ExecutorAttestation, "signature">,
) {
  return stableStringify(attestation);
}

export function pipelineGraphEffectService(db: Db) {
  async function requiredExecutorKeyId(attempt: typeof pipelineGraphEffectAttempts.$inferSelect) {
    const policy = await db
      .select({ definition: pipelineGraphVersions.definition })
      .from(pipelineGraphRuns)
      .innerJoin(
        pipelineGraphVersions,
        and(
          eq(pipelineGraphVersions.companyId, pipelineGraphRuns.companyId),
          eq(pipelineGraphVersions.id, pipelineGraphRuns.graphVersionId),
        ),
      )
      .where(and(
        eq(pipelineGraphRuns.companyId, attempt.companyId),
        eq(pipelineGraphRuns.id, attempt.runId),
      ))
      .then((rows) => rows[0] ?? null);
    const node = policy?.definition.nodes.find((candidate) => candidate.key === attempt.nodeKey);
    return typeof node?.config.effectExecutorKeyId === "string"
      ? node.config.effectExecutorKeyId.trim()
      : "";
  }

  async function verifyAuthority(input: {
    companyId: string;
    authorityClass: string;
    subjectHash: string;
    authorityReceipt: Record<string, unknown>;
    actor: PipelineGraphVersionActor;
  }) {
    if (input.authorityReceipt.subjectHash !== input.subjectHash) {
      throw unprocessable("Authority receipt is not bound to the exact effect subject", {
        code: "effect_authority_subject_mismatch",
        subjectHash: input.subjectHash,
      });
    }
    const kind = input.authorityReceipt.kind;
    if (input.authorityClass === "none" && kind === "none") return;
    if (
      kind === "actor"
      && input.actor.type === "user"
      && input.authorityReceipt.decidedByUserId === input.actor.userId
    ) return;
    if (kind === "approval" && typeof input.authorityReceipt.approvalId === "string") {
      const approval = await db
        .select({
          status: approvals.status,
          payload: approvals.payload,
          decidedByUserId: approvals.decidedByUserId,
        })
        .from(approvals)
        .where(and(
          eq(approvals.companyId, input.companyId),
          eq(approvals.id, input.authorityReceipt.approvalId),
        ))
        .then((rows) => rows[0] ?? null);
      if (
        approval?.status === "approved"
        && approval.decidedByUserId
        && approval.payload.subjectHash === input.subjectHash
        && approval.payload.authorityClass === input.authorityClass
      ) return;
    }
    throw forbidden("No valid exact-subject authority receipt permits this effect", {
      code: "effect_authority_receipt_invalid",
      authorityClass: input.authorityClass,
      subjectHash: input.subjectHash,
    });
  }

  return {
    async request(input: {
      companyId: string;
      runId: string;
      expectedRevision: number;
      effectType: string;
      targetRef: Record<string, unknown>;
      payloadHash: string;
      authorityReceipt: Record<string, unknown>;
      executorAttestation: ExecutorAttestation & { action: "request" };
      idempotencyKey: string;
      retryPolicy: { maxAttempts: number };
      actor: PipelineGraphVersionActor;
    }) {
      const subjectHash = pipelineGraphEffectSubjectHash(input);
      const policy = await db
        .select({
          currentNodeKey: pipelineGraphRuns.currentNodeKey,
          definition: pipelineGraphVersions.definition,
        })
        .from(pipelineGraphRuns)
        .innerJoin(
          pipelineGraphVersions,
          and(
            eq(pipelineGraphVersions.companyId, pipelineGraphRuns.companyId),
            eq(pipelineGraphVersions.id, pipelineGraphRuns.graphVersionId),
          ),
        )
        .where(and(
          eq(pipelineGraphRuns.companyId, input.companyId),
          eq(pipelineGraphRuns.id, input.runId),
        ))
        .then((rows) => rows[0] ?? null);
      const policyNode = policy?.definition.nodes.find(
        (candidate) => candidate.key === policy.currentNodeKey,
      );
      const requiredEffectType = typeof policyNode?.config.requiredEffectType === "string"
        ? policyNode.config.requiredEffectType.trim()
        : "";
      const authorityClass = typeof policyNode?.config.requiredAuthorityClass === "string"
        ? policyNode.config.requiredAuthorityClass.trim()
        : "";
      const effectExecutorType = typeof policyNode?.config.effectExecutorType === "string"
        ? policyNode.config.effectExecutorType.trim()
        : "";
      const effectExecutorId = typeof policyNode?.config.effectExecutorId === "string"
        ? policyNode.config.effectExecutorId.trim()
        : "";
      const effectExecutorKeyId = typeof policyNode?.config.effectExecutorKeyId === "string"
        ? policyNode.config.effectExecutorKeyId.trim()
        : "";
      if (
        !requiredEffectType
        || requiredEffectType !== input.effectType
        || !authorityClass
        || !["user", "agent", "system"].includes(effectExecutorType)
        || !effectExecutorId
        || !effectExecutorKeyId
      ) {
        throw forbidden("Graph policy does not authorize this effect boundary", {
          code: "effect_policy_mismatch",
          requiredEffectType,
          requestedEffectType: input.effectType,
        });
      }
      const requestHash = hash({
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        effectType: input.effectType,
        authorityClass,
        targetRef: input.targetRef,
        payloadHash: input.payloadHash,
        subjectHash,
        authorityReceipt: input.authorityReceipt,
        executorAttestation: input.executorAttestation,
        retryPolicy: input.retryPolicy,
        actor: { type: input.actor.type, id: actorId(input.actor) },
      });
      await verifyAuthority({
        companyId: input.companyId,
        authorityClass,
        subjectHash,
        authorityReceipt: input.authorityReceipt,
        actor: input.actor,
      });
      verifyExecutorAttestation({
        attestation: input.executorAttestation,
        requiredKeyId: effectExecutorKeyId,
        subjectHash,
        action: "request",
        actionHash: hash({ subjectHash }),
      });

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${
            `pipeline-graph-effect:${input.companyId}:${input.idempotencyKey}`
          }, 0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${
            `pipeline-graph-effect-subject:${input.companyId}:${subjectHash}`
          }, 0))`,
        );
        const replay = await tx
          .select()
          .from(pipelineGraphEffectAttempts)
          .where(and(
            eq(pipelineGraphEffectAttempts.companyId, input.companyId),
            eq(pipelineGraphEffectAttempts.idempotencyKey, input.idempotencyKey),
          ))
          .then((rows) => rows[0] ?? null);
        if (replay) {
          if (replay.requestHash !== requestHash) {
            throw conflict("Effect idempotency key was already used for another request", {
              code: "effect_idempotency_conflict",
              effectAttemptId: replay.id,
            });
          }
          return { effectAttempt: replay, created: false };
        }

        const sameSubject = await tx
          .select()
          .from(pipelineGraphEffectAttempts)
          .where(and(
            eq(pipelineGraphEffectAttempts.companyId, input.companyId),
            eq(pipelineGraphEffectAttempts.subjectHash, subjectHash),
          ))
          .then((rows) => rows[0] ?? null);
        if (sameSubject) {
          if (
            sameSubject.runId !== input.runId
            || sameSubject.nodeKey !== policy?.currentNodeKey
            || sameSubject.runRevision !== input.expectedRevision
          ) {
            throw conflict("Effect subject is already bound to another graph boundary", {
              code: "effect_subject_boundary_conflict",
              effectAttemptId: sameSubject.id,
            });
          }
          return { effectAttempt: sameSubject, created: false };
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
        if (run.status !== "running" || run.revision !== input.expectedRevision) {
          throw conflict("Graph run is not at the requested effect boundary", {
            code: "effect_graph_revision_conflict",
            expectedRevision: input.expectedRevision,
            currentRevision: run.revision,
            status: run.status,
          });
        }

        if (input.actor.type === "agent") {
          const nativeRun = await tx
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
          const context = objectValue(nativeRun?.contextSnapshot);
          const assignment = objectValue(context.graphAssignment);
          if (
            assignment.targetAgentId !== input.actor.agentId
            || nativeRun?.agentId !== input.actor.agentId
            || context.graphRunId !== run.id
            || context.graphRunRevision !== run.revision
            || context.targetNodeKey !== run.currentNodeKey
          ) {
            throw forbidden("Agent effect request is not bound to the current graph assignment", {
              code: "effect_assignment_attempt_mismatch",
            });
          }
        }

        const effectAttempt = await tx
          .insert(pipelineGraphEffectAttempts)
          .values({
            companyId: input.companyId,
            runId: run.id,
            nodeKey: run.currentNodeKey,
            runRevision: run.revision,
            effectType: input.effectType,
            authorityClass,
            targetRef: input.targetRef,
            payloadHash: input.payloadHash,
            subjectHash,
            authorityReceipt: input.authorityReceipt,
            executorAttestation: input.executorAttestation,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            retryPolicy: input.retryPolicy,
            requestedByType: input.actor.type,
            requestedById: actorId(input.actor),
            requestedByRunId: input.actor.type === "agent" ? input.actor.runId : null,
          })
          .returning()
          .then((rows) => rows[0]!);
        return { effectAttempt, created: true };
      });
    },

    async get(input: { companyId: string; effectAttemptId: string }) {
      const row = await db
        .select()
        .from(pipelineGraphEffectAttempts)
        .where(and(
          eq(pipelineGraphEffectAttempts.companyId, input.companyId),
          eq(pipelineGraphEffectAttempts.id, input.effectAttemptId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Effect attempt not found");
      return row;
    },

    async claim(input: {
      companyId: string;
      effectAttemptId: string;
      executorType: "user" | "agent" | "system";
      executorId: string;
      leaseSeconds: number;
      retryReconciliation?: {
        subjectHash: string;
        outcome: "not_applied" | "applied";
        checkedAt: string;
      };
      executorAttestation: ExecutorAttestation & { action: "claim" };
    }) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select id from pipeline_graph_effect_attempts
          where company_id = ${input.companyId} and id = ${input.effectAttemptId} for update`);
        const attempt = await tx
          .select()
          .from(pipelineGraphEffectAttempts)
          .where(and(
            eq(pipelineGraphEffectAttempts.companyId, input.companyId),
            eq(pipelineGraphEffectAttempts.id, input.effectAttemptId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!attempt) throw notFound("Effect attempt not found");
        const boundary = await tx
          .select({
            status: pipelineGraphRuns.status,
            currentNodeKey: pipelineGraphRuns.currentNodeKey,
            revision: pipelineGraphRuns.revision,
            definition: pipelineGraphVersions.definition,
          })
          .from(pipelineGraphRuns)
          .innerJoin(
            pipelineGraphVersions,
            and(
              eq(pipelineGraphVersions.companyId, pipelineGraphRuns.companyId),
              eq(pipelineGraphVersions.id, pipelineGraphRuns.graphVersionId),
            ),
          )
          .where(and(
            eq(pipelineGraphRuns.companyId, input.companyId),
            eq(pipelineGraphRuns.id, attempt.runId),
          ))
          .then((rows) => rows[0] ?? null);
        if (
          !boundary
          || boundary.status !== "running"
          || boundary.currentNodeKey !== attempt.nodeKey
          || boundary.revision !== attempt.runRevision
        ) {
          throw conflict("Effect attempt belongs to a stale graph boundary", {
            code: "effect_graph_boundary_stale",
          });
        }
        const policyNode = boundary.definition.nodes.find(
          (candidate) => candidate.key === attempt.nodeKey,
        );
        const requiredExecutorType = typeof policyNode?.config.effectExecutorType === "string"
          ? policyNode.config.effectExecutorType.trim()
          : "";
        let requiredExecutorId = typeof policyNode?.config.effectExecutorId === "string"
          ? policyNode.config.effectExecutorId.trim()
          : "";
        if (requiredExecutorId === "$roleBinding") {
          requiredExecutorId = await tx.select({ agentId: pipelineGraphRoleBindings.agentId })
            .from(pipelineGraphRoleBindings)
            .where(and(
              eq(pipelineGraphRoleBindings.companyId, input.companyId),
              eq(pipelineGraphRoleBindings.runId, attempt.runId),
              eq(pipelineGraphRoleBindings.runRevision, attempt.runRevision),
              eq(pipelineGraphRoleBindings.nodeKey, attempt.nodeKey),
            ))
            .then((rows) => rows[0]?.agentId ?? "");
        }
        const requiredExecutorKeyId = typeof policyNode?.config.effectExecutorKeyId === "string"
          ? policyNode.config.effectExecutorKeyId.trim()
          : "";
        if (
          input.executorType !== requiredExecutorType
          || input.executorId !== requiredExecutorId
        ) {
          throw forbidden("Only the graph policy's trusted executor may claim this effect", {
            code: "effect_executor_mismatch",
          });
        }
        verifyExecutorAttestation({
          attestation: input.executorAttestation,
          requiredKeyId: requiredExecutorKeyId,
          subjectHash: attempt.subjectHash,
          action: "claim",
          actionHash: hash({
            leaseSeconds: input.leaseSeconds,
            retryReconciliation: input.retryReconciliation ?? null,
          }),
        });
        const maxAttempts = attempt.retryPolicy.maxAttempts;
        const expired = attempt.status === "executing"
          && attempt.claimExpiresAt !== null
          && attempt.claimExpiresAt <= new Date();
        if (attempt.status !== "pending" && attempt.status !== "failed" && !expired) {
          throw conflict("Effect attempt is not claimable", {
            code: "effect_not_claimable",
            status: attempt.status,
          });
        }
        if (attempt.attemptCount >= maxAttempts) {
          throw conflict("Effect retry budget is exhausted", {
            code: "effect_retry_exhausted",
            attemptCount: attempt.attemptCount,
            maxAttempts,
          });
        }
        if (attempt.attemptCount > 0) {
          const checkedAt = input.retryReconciliation
            ? new Date(input.retryReconciliation.checkedAt)
            : null;
          if (
            !input.retryReconciliation
            || input.retryReconciliation.subjectHash !== attempt.subjectHash
            || !checkedAt
            || Number.isNaN(checkedAt.getTime())
            || Math.abs(Date.now() - checkedAt.getTime()) > 5 * 60_000
          ) {
            throw conflict("Retry requires fresh provider reconciliation for the exact subject", {
              code: "effect_retry_reconciliation_required",
              subjectHash: attempt.subjectHash,
            });
          }
        }
        const now = new Date();
        const leaseToken = randomUUID();
        return tx
          .update(pipelineGraphEffectAttempts)
          .set({
            status: "executing",
            attemptCount: attempt.attemptCount + 1,
            executorType: input.executorType,
            executorId: input.executorId,
            leaseToken,
            claimedAt: now,
            claimExpiresAt: new Date(now.getTime() + input.leaseSeconds * 1_000),
            reconciliationEvidence: input.retryReconciliation ?? null,
            failureEvidence: null,
            finishedAt: null,
            updatedAt: now,
          })
          .where(eq(pipelineGraphEffectAttempts.id, attempt.id))
          .returning()
          .then((rows) => rows[0]!);
      });
    },

    async complete(input: {
      companyId: string;
      effectAttemptId: string;
      leaseToken: string;
      executorType: "user" | "agent" | "system";
      executorId: string;
      providerReceipt: Record<string, unknown>;
      executorAttestation: ExecutorAttestation & { action: "complete" };
    }) {
      const attempt = await db
        .select()
        .from(pipelineGraphEffectAttempts)
        .where(and(
          eq(pipelineGraphEffectAttempts.companyId, input.companyId),
          eq(pipelineGraphEffectAttempts.id, input.effectAttemptId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!attempt) throw notFound("Effect attempt not found");
      if (
        input.providerReceipt.subjectHash !== attempt.subjectHash
        || input.providerReceipt.effectType !== attempt.effectType
        || input.providerReceipt.payloadHash !== attempt.payloadHash
        || input.providerReceipt.targetRefHash !== pipelineGraphEffectTargetRefHash(attempt.targetRef)
        || typeof input.providerReceipt.providerOperationId !== "string"
        || input.providerReceipt.providerOperationId.trim() === ""
      ) {
        throw unprocessable("Provider receipt is not bound to the exact effect subject", {
          code: "effect_provider_receipt_invalid",
          subjectHash: attempt.subjectHash,
        });
      }
      verifyExecutorAttestation({
        attestation: input.executorAttestation,
        requiredKeyId: await requiredExecutorKeyId(attempt),
        subjectHash: attempt.subjectHash,
        action: "complete",
        actionHash: hash(input.providerReceipt),
      });
      const now = new Date();
      const row = await db
        .update(pipelineGraphEffectAttempts)
        .set({
          status: "succeeded",
          leaseToken: null,
          claimExpiresAt: null,
          providerReceipt: input.providerReceipt,
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(pipelineGraphEffectAttempts.companyId, input.companyId),
          eq(pipelineGraphEffectAttempts.id, input.effectAttemptId),
          eq(pipelineGraphEffectAttempts.status, "executing"),
          eq(pipelineGraphEffectAttempts.leaseToken, input.leaseToken),
          eq(pipelineGraphEffectAttempts.executorType, input.executorType),
          eq(pipelineGraphEffectAttempts.executorId, input.executorId),
          gte(pipelineGraphEffectAttempts.claimExpiresAt, now),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw conflict("Effect lease is stale or does not own the attempt", {
        code: "effect_lease_fenced",
      });
      return row;
    },

    async fail(input: {
      companyId: string;
      effectAttemptId: string;
      leaseToken: string;
      executorType: "user" | "agent" | "system";
      executorId: string;
      failureEvidence: Record<string, unknown>;
      executorAttestation: ExecutorAttestation & { action: "fail" };
    }) {
      const attempt = await db
        .select()
        .from(pipelineGraphEffectAttempts)
        .where(and(
          eq(pipelineGraphEffectAttempts.companyId, input.companyId),
          eq(pipelineGraphEffectAttempts.id, input.effectAttemptId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!attempt) throw notFound("Effect attempt not found");
      verifyExecutorAttestation({
        attestation: input.executorAttestation,
        requiredKeyId: await requiredExecutorKeyId(attempt),
        subjectHash: attempt.subjectHash,
        action: "fail",
        actionHash: hash(input.failureEvidence),
      });
      const now = new Date();
      const row = await db
        .update(pipelineGraphEffectAttempts)
        .set({
          status: "failed",
          leaseToken: null,
          claimExpiresAt: null,
          failureEvidence: input.failureEvidence,
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(pipelineGraphEffectAttempts.companyId, input.companyId),
          eq(pipelineGraphEffectAttempts.id, input.effectAttemptId),
          eq(pipelineGraphEffectAttempts.status, "executing"),
          eq(pipelineGraphEffectAttempts.leaseToken, input.leaseToken),
          eq(pipelineGraphEffectAttempts.executorType, input.executorType),
          eq(pipelineGraphEffectAttempts.executorId, input.executorId),
          gte(pipelineGraphEffectAttempts.claimExpiresAt, now),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw conflict("Effect lease is stale or does not own the attempt", {
        code: "effect_lease_fenced",
      });
      return row;
    },
  };
}
