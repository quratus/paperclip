import { createHash } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  agents,
  issueRelations,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { getAgentWorkEligibility } from "@paperclipai/shared";
import {
  evaluateIssueAdmission,
  type IssueAdmissionDisposition,
} from "./issue-admission.js";

const ACTIVE_RECOVERY_STATUSES = ["active", "escalated"] as const;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

type RedirectDisposition = Extract<IssueAdmissionDisposition, { kind: "redirect" }>;

export type AdmissionRedirectResult =
  | {
      kind: "retry";
      issue: typeof issues.$inferSelect;
      reason: "admission_state_changed";
    }
  | {
      kind: "redirected";
      disposition: RedirectDisposition;
      issue: typeof issues.$inferSelect;
      ownerAgentId: string;
      recoveryActionId: string;
      wakeIdempotencyKey: string;
    }
  | {
      kind: "external_intervention";
      disposition: RedirectDisposition;
      issue: typeof issues.$inferSelect;
      recoveryActionId: string;
      reason: "no_eligible_refinement_owner";
    };

function fingerprint(disposition: RedirectDisposition, returnOwnerAgentId: string | null) {
  return createHash("sha256")
    .update(JSON.stringify({
      code: disposition.code,
      missing: [...disposition.missing].sort(),
      resolverVersion: disposition.resolverVersion,
      returnOwnerAgentId,
    }))
    .digest("hex");
}

export function resolveAdmissionRedirectOwner(
  deniedAgentId: string,
  companyAgents: Array<typeof agents.$inferSelect>,
) {
  const byId = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const denied = byId.get(deniedAgentId);
  const seen = new Set<string>([deniedAgentId]);
  let candidateId = denied?.reportsTo ?? null;

  while (candidateId && !seen.has(candidateId)) {
    seen.add(candidateId);
    const candidate = byId.get(candidateId);
    if (!candidate) return null;
    const eligibility = getAgentWorkEligibility({
      agent: candidate,
      agents: companyAgents,
    });
    if (eligibility.assignable && eligibility.invokable) return candidate;
    candidateId = candidate.reportsTo ?? null;
  }
  return null;
}

export async function redirectIssueAdmission(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    deniedAgentId: string | null;
    disposition: RedirectDisposition;
    nextDescription?: string | null;
    nextExecutionPolicy?: unknown;
    requestedByActorType?: string | null;
    requestedByActorId?: string | null;
    checkoutRunId?: string | null;
    returnOwnerAgentId?: string | null;
    expectedStatuses: string[];
  },
): Promise<AdmissionRedirectResult> {
  return db.transaction(async (tx) => {
    const lockKey = `issue-admission-redirect:${input.companyId}:${input.issueId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const issue = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!issue) throw new Error(`Issue ${input.issueId} disappeared during admission redirect`);
    const lockedDisposition = evaluateIssueAdmission({
      issue,
      nextDescription: input.nextDescription,
      nextExecutionPolicy: input.nextExecutionPolicy,
      source: input.disposition.source,
      actorType: "agent",
    });
    if (lockedDisposition.kind === "allow") {
      return {
        kind: "retry",
        issue,
        reason: "admission_state_changed",
      };
    }
    const activeRunConflict =
      Boolean(issue.checkoutRunId && issue.checkoutRunId !== input.checkoutRunId) ||
      Boolean(issue.executionRunId && issue.executionRunId !== input.checkoutRunId);
    if (
      !input.expectedStatuses.includes(issue.status) ||
      !["backlog", "todo", "in_progress", "blocked"].includes(issue.status) ||
      activeRunConflict
    ) {
      return { kind: "retry", issue, reason: "admission_state_changed" };
    }

    const companyAgents = await tx
      .select()
      .from(agents)
      .where(eq(agents.companyId, input.companyId));
    const owner = input.deniedAgentId
      ? resolveAdmissionRedirectOwner(input.deniedAgentId, companyAgents)
      : null;
    const returnOwnerAgentId =
      input.returnOwnerAgentId ??
      issue.assigneeAgentId ??
      input.deniedAgentId;
    const actionFingerprint = fingerprint(lockedDisposition, returnOwnerAgentId);
    const wakeIdempotencyKey = owner
      ? [
          "issue_admission_redirect",
          input.issueId,
          owner.id,
          actionFingerprint,
        ].join(":")
      : null;
    const now = new Date();
    const existingAction = await tx
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, input.companyId),
        eq(issueRecoveryActions.sourceIssueId, input.issueId),
        inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_STATUSES]),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    const unresolvedBlocker = await tx
      .select({ id: issueRelations.id })
      .from(issueRelations)
      .innerJoin(issues, and(
        eq(issues.companyId, issueRelations.companyId),
        eq(issues.id, issueRelations.issueId),
      ))
      .where(and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.relatedIssueId, input.issueId),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, ["done", "cancelled"]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const externalBlockerType =
      issue.blockedByExternal &&
      typeof issue.blockedByExternal === "object" &&
      typeof issue.blockedByExternal.type === "string"
        ? issue.blockedByExternal.type
        : null;
    const mayReplaceMissingDispositionRecovery =
      issue.status === "blocked" &&
      issue.blockedByApprovalId === null &&
      !unresolvedBlocker &&
      externalBlockerType === "automatic_recovery" &&
      existingAction?.kind === "missing_disposition";
    const cleanRedirectableState =
      ["backlog", "todo", "in_progress"].includes(issue.status) &&
      issue.blockedByApprovalId === null &&
      !unresolvedBlocker &&
      issue.blockedByExternal === null;
    const reusableAdmissionRedirect =
      existingAction?.kind === "admission_redirect" &&
      issue.status === "todo" &&
      issue.blockedByApprovalId === null &&
      !unresolvedBlocker &&
      issue.blockedByExternal === null;
    if (!cleanRedirectableState && !mayReplaceMissingDispositionRecovery && !reusableAdmissionRedirect) {
      return { kind: "retry", issue, reason: "admission_state_changed" };
    }
    if (
      existingAction &&
      existingAction.kind !== "missing_disposition" &&
      existingAction.kind !== "admission_redirect"
    ) {
      return { kind: "retry", issue, reason: "admission_state_changed" };
    }

    const actionValues = {
      kind: "admission_redirect",
      status: "active",
      ownerType: owner ? "agent" : "board",
      ownerAgentId: owner?.id ?? null,
      previousOwnerAgentId: issue.assigneeAgentId,
      returnOwnerAgentId,
      cause: lockedDisposition.code,
      fingerprint: actionFingerprint,
      evidence: {
        disposition: lockedDisposition,
        deniedAgentId: input.deniedAgentId,
        previousStatus: issue.status,
      },
      nextAction: owner
        ? "Add the missing Product Truth Contract and execution review chain; ownership will then return to the implementation agent."
        : "Assign an eligible Issue Refinery owner and repair the missing admission contract.",
      wakePolicy: owner ? {
        mode: "canonical",
        phase: "refinement",
        agentId: owner.id,
        idempotencyKey: wakeIdempotencyKey!,
        maxAttempts: 3,
      } : null,
      attemptCount:
        existingAction?.kind === "admission_redirect" &&
        existingAction.fingerprint === actionFingerprint
          ? existingAction.attemptCount + 1
          : 1,
      lastAttemptAt: now,
      outcome: null,
      resolutionNote: null,
      resolvedAt: null,
      updatedAt: now,
    } as const;

    const reusableAction =
      existingAction?.kind === "admission_redirect" &&
      existingAction.fingerprint === actionFingerprint
        ? existingAction
        : null;
    if (existingAction && !reusableAction) {
      await tx
        .update(issueRecoveryActions)
        .set({
          status: "resolved",
          outcome: "delegated",
          resolutionNote: "Superseded by a typed admission redirect.",
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(issueRecoveryActions.id, existingAction.id));
    }
    const action = reusableAction
      ? await tx
          .update(issueRecoveryActions)
          .set(actionValues)
          .where(eq(issueRecoveryActions.id, reusableAction.id))
          .returning()
          .then((rows) => rows[0]!)
      : await tx
          .insert(issueRecoveryActions)
          .values({
            companyId: input.companyId,
            sourceIssueId: input.issueId,
            ...actionValues,
          })
          .returning()
          .then((rows) => rows[0]!);

    const [updatedIssue] = await tx
      .update(issues)
      .set({
        status: "backlog",
        assigneeAgentId: owner?.id ?? null,
        assigneeUserId: null,
        blockedByApprovalId: null,
        blockedByExternal: owner ? null : {
          type: "admission_owner_unavailable",
          recoveryActionId: action.id,
          requiredResponsibility: lockedDisposition.requiredResponsibility,
          routingPolicy: lockedDisposition.routingPolicy,
        },
        updatedAt: now,
      })
      .where(eq(issues.id, input.issueId))
      .returning();

    if (!owner) {
      return {
        kind: "external_intervention",
        disposition: lockedDisposition,
        issue: updatedIssue!,
        recoveryActionId: action.id,
        reason: "no_eligible_refinement_owner",
      };
    }

    return {
      kind: "redirected",
      disposition: lockedDisposition,
      issue: updatedIssue!,
      ownerAgentId: owner.id,
      recoveryActionId: action.id,
      wakeIdempotencyKey: wakeIdempotencyKey!,
    };
  });
}

export async function handBackCompletedAdmissionRedirect(
  db: Db,
  input: AdmissionHandoffInput,
) {
  return db.transaction((tx) => handBackCompletedAdmissionRedirectInTransaction(tx, input));
}

type AdmissionHandoffInput = {
  companyId: string;
  issueId: string;
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
  requestedByAgentId?: string | null;
  actorRunId?: string | null;
};

export async function handBackCompletedAdmissionRedirectInTransaction(
  tx: DbOrTransaction,
  input: {
    companyId: string;
    issueId: string;
    requestedByActorType?: string | null;
    requestedByActorId?: string | null;
    requestedByAgentId?: string | null;
    actorRunId?: string | null;
  },
) {
  const lockKey = `issue-admission-redirect:${input.companyId}:${input.issueId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  const action = await tx
    .select()
    .from(issueRecoveryActions)
    .where(and(
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.kind, "admission_redirect"),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_STATUSES]),
    ))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!action?.returnOwnerAgentId) return null;

  const issue = await tx
    .select()
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!issue) return null;
  const ownedRefinementState =
    ["backlog", "todo", "in_progress"].includes(issue.status) &&
    issue.assigneeAgentId === action.ownerAgentId &&
    (!input.requestedByAgentId || input.requestedByAgentId === action.ownerAgentId) &&
    (!issue.checkoutRunId || issue.checkoutRunId === input.actorRunId) &&
    (!issue.executionRunId || issue.executionRunId === input.actorRunId);
  if (!ownedRefinementState) return null;
  if (evaluateIssueAdmission({ issue, source: "assignment", actorType: "agent" }).kind !== "allow") {
    return null;
  }

  const companyAgents = await tx
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId));
  const returnOwner = companyAgents.find((agent) => agent.id === action.returnOwnerAgentId);
  const returnEligibility = returnOwner
    ? getAgentWorkEligibility({
        agent: returnOwner,
        agents: companyAgents,
      })
    : null;
  if (!returnOwner || !returnEligibility?.assignable || !returnEligibility.invokable) {
    await tx
      .update(issueRecoveryActions)
      .set({
        status: "escalated",
        ownerType: "board",
        ownerAgentId: null,
        nextAction: "Choose an eligible implementation owner for the refined issue.",
        wakePolicy: null,
        resolutionNote: "The intended implementation owner is no longer assignable and invokable.",
        updatedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, action.id));
    return null;
  }

  const now = new Date();
  const idempotencyKey = `issue_admission_handoff:${issue.id}:${action.id}:${returnOwner.id}`;
  const [updatedIssue] = await tx
    .update(issues)
    .set({
      status: "todo",
      assigneeAgentId: returnOwner.id,
      assigneeUserId: null,
      blockedByExternal: null,
      updatedAt: now,
    })
    .where(eq(issues.id, issue.id))
    .returning();
  await tx
    .update(issueRecoveryActions)
    .set({
      status: "active",
      ownerType: "agent",
      ownerAgentId: returnOwner.id,
      outcome: null,
      resolutionNote: null,
      resolvedAt: null,
      nextAction: "Resume implementation on the refined issue.",
      wakePolicy: {
        mode: "canonical",
        phase: "implementation",
        agentId: returnOwner.id,
        idempotencyKey,
        maxAttempts: 3,
      },
      attemptCount: 1,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(issueRecoveryActions.id, action.id));

  return {
    issue: updatedIssue!,
    recoveryActionId: action.id,
    returnOwnerAgentId: returnOwner.id,
    wakeIdempotencyKey: idempotencyKey,
  };
}
