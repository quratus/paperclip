import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { evaluateIssueAdmission } from "../services/issue-admission.js";
import {
  handBackCompletedAdmissionRedirectInTransaction,
  redirectIssueAdmission,
} from "../services/issue-admission-redirect.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

describeEmbeddedPostgres("issue admission redirect", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-admission-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("replays SQN-4702 as redirect, executable wake, repair, and hand-back", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const implementerId = randomUUID();
    const issueId = randomUUID();
    const oldActionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "SQN",
      issuePrefix: `SQ${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "The CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: implementerId,
        companyId,
        name: "Implementer Codex2",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "SQN-4702 replay",
      description: "Build the product surface.",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: implementerId,
      blockedByExternal: {
        type: "automatic_recovery",
        note: "Successful run produced no disposition.",
      },
    });
    await db.insert(issueRecoveryActions).values({
      id: oldActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: implementerId,
      previousOwnerAgentId: implementerId,
      returnOwnerAgentId: implementerId,
      cause: "successful_run_missing_state",
      fingerprint: "sqn-4702-old",
      evidence: {},
      nextAction: "Choose a disposition.",
      attemptCount: 1,
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    const disposition = evaluateIssueAdmission({
      issue,
      source: "checkout",
      actorType: "agent",
    });
    expect(disposition.kind).toBe("redirect");
    if (disposition.kind !== "redirect") throw new Error("Expected redirect");

    const redirect = await redirectIssueAdmission(db, {
      companyId,
      issueId,
      deniedAgentId: implementerId,
      disposition,
      checkoutRunId: null,
      expectedStatuses: ["blocked"],
      requestedByActorType: "agent",
      requestedByActorId: implementerId,
    });
    expect(redirect.kind).toBe("redirected");
    if (redirect.kind !== "redirected") throw new Error("Expected persisted redirect");
    expect(redirect.ownerAgentId).toBe(managerId);

    const redirectedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(redirectedIssue).toMatchObject({
      status: "backlog",
      assigneeAgentId: managerId,
      blockedByApprovalId: null,
      blockedByExternal: null,
    });
    const oldAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, oldActionId))
      .then((rows) => rows[0]!);
    expect(oldAction).toMatchObject({ status: "resolved", outcome: "delegated" });
    const admissionAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, redirect.recoveryActionId))
      .then((rows) => rows[0]!);
    expect(admissionAction.wakePolicy).toMatchObject({
      mode: "canonical",
      phase: "refinement",
      agentId: managerId,
      idempotencyKey: redirect.wakeIdempotencyKey,
    });

    const [finishedRefinementRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: managerId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date(Date.now() - 180_000),
      finishedAt: new Date(Date.now() - 120_000),
      contextSnapshot: { issueId, taskId: issueId },
    }).returning();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: managerId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_same_name",
      payload: { issueId },
      status: "coalesced",
      idempotencyKey: redirect.wakeIdempotencyKey,
      runId: finishedRefinementRun!.id,
      finishedAt: new Date(Date.now() - 120_000),
    });
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: new Date(Date.now() - 120_000) })
      .where(eq(issueRecoveryActions.id, redirect.recoveryActionId));
    const refinementEnqueue = vi.fn(async (agentId: string, options?: {
      idempotencyKey?: string | null;
      payload?: Record<string, unknown> | null;
    }) => {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_admission_redirect",
        payload: options?.payload ?? {},
        status: "deferred_issue_execution",
        requestedByActorType: "system",
        idempotencyKey: options?.idempotencyKey ?? null,
      });
      return null;
    });
    const refinementRecovery = recoveryService(db, { enqueueWakeup: refinementEnqueue });
    const coalescedTerminalRetry = await refinementRecovery.reconcileAdmissionRedirectWakes();
    expect(coalescedTerminalRetry).toMatchObject({ retried: 1, delivered: 0 });
    expect(refinementEnqueue).toHaveBeenLastCalledWith(
      managerId,
      expect.objectContaining({
        idempotencyKey: `${redirect.wakeIdempotencyKey}:retry:2`,
      }),
    );

    const [deferredRetry] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `${redirect.wakeIdempotencyKey}:retry:2`));
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, deferredRetry!.id));
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: new Date(Date.now() - 120_000) })
      .where(eq(issueRecoveryActions.id, redirect.recoveryActionId));
    const completedWithoutRepairRetry =
      await refinementRecovery.reconcileAdmissionRedirectWakes();
    expect(completedWithoutRepairRetry).toMatchObject({ retried: 1, delivered: 0 });
    expect(refinementEnqueue).toHaveBeenLastCalledWith(
      managerId,
      expect.objectContaining({
        idempotencyKey: `${redirect.wakeIdempotencyKey}:retry:2:retry:3`,
      }),
    );

    const [managerRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: managerId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId },
    }).returning();
    await db
      .update(issues)
      .set({
        description: "## Product Truth Contract\nBuild evidence-backed behavior.",
        executionPolicy: {
          workClass: "backend",
          stages: [{
            type: "review",
            participants: [{ type: "agent", agentId: managerId }],
          }],
        },
        status: "in_progress",
        checkoutRunId: managerRun!.id,
        executionRunId: managerRun!.id,
      })
      .where(eq(issues.id, issueId));
    const handoff = await db.transaction((tx) =>
      handBackCompletedAdmissionRedirectInTransaction(tx, {
        companyId,
        issueId,
        requestedByActorType: "agent",
        requestedByActorId: managerId,
        requestedByAgentId: managerId,
        actorRunId: managerRun!.id,
      }));
    expect(handoff).not.toBeNull();
    expect(handoff?.issue).toMatchObject({
      status: "todo",
      assigneeAgentId: implementerId,
      checkoutRunId: managerRun!.id,
      executionRunId: managerRun!.id,
    });
    const pendingHandoffAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, handoff!.recoveryActionId))
      .then((rows) => rows[0]!);
    expect(pendingHandoffAction).toMatchObject({
      status: "active",
      ownerAgentId: implementerId,
      attemptCount: 1,
    });
    expect(pendingHandoffAction.wakePolicy).toMatchObject({
      mode: "canonical",
      phase: "implementation",
      agentId: implementerId,
      idempotencyKey: handoff!.wakeIdempotencyKey,
    });

    // Simulate the process crashing after the atomic hand-back commit but before
    // the route can call the canonical heartbeat scheduler.
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: new Date(Date.now() - 120_000) })
      .where(eq(issueRecoveryActions.id, handoff!.recoveryActionId));
    const enqueueWakeup = vi.fn(async (agentId: string, options?: {
      idempotencyKey?: string | null;
      payload?: Record<string, unknown> | null;
    }) => {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_admission_completed",
        payload: options?.payload ?? {},
        status: "deferred_issue_execution",
        requestedByActorType: "system",
        idempotencyKey: options?.idempotencyKey ?? null,
      });
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const retry = await recovery.reconcileAdmissionRedirectWakes();
    expect(retry).toMatchObject({ retried: 1, escalated: 0 });
    expect(enqueueWakeup).toHaveBeenCalledWith(
      implementerId,
      expect.objectContaining({
        reason: "issue_admission_completed",
        idempotencyKey: `${handoff!.wakeIdempotencyKey}:retry:2`,
      }),
    );

    const delivered = await recovery.reconcileAdmissionRedirectWakes();
    expect(delivered).toMatchObject({ delivered: 1, retried: 0 });
    const resolvedAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, handoff!.recoveryActionId))
      .then((rows) => rows[0]!);
    expect(resolvedAction).toMatchObject({
      status: "resolved",
      outcome: "handed_back",
    });

    const proposedRemovalIssueId = randomUUID();
    await db.insert(issues).values({
      id: proposedRemovalIssueId,
      companyId,
      title: "Proposed contract removal",
      description: "## Product Truth Contract\nValid before patch.",
      executionPolicy: {
        workClass: "backend",
        stages: [{
          type: "review",
          participants: [{ type: "agent", agentId: managerId }],
        }],
      },
      status: "backlog",
      priority: "medium",
      assigneeAgentId: implementerId,
    });
    const proposedRemovalDisposition = evaluateIssueAdmission({
      issue: {
        id: proposedRemovalIssueId,
        description: "## Product Truth Contract\nValid before patch.",
        executionPolicy: {
          workClass: "backend",
          stages: [{
            type: "review",
            participants: [{ type: "agent", agentId: managerId }],
          }],
        },
      },
      nextDescription: null,
      source: "status_transition",
      actorType: "agent",
    });
    if (proposedRemovalDisposition.kind !== "redirect") {
      throw new Error("Expected proposed removal redirect");
    }
    const proposedRemovalRedirect = await redirectIssueAdmission(db, {
      companyId,
      issueId: proposedRemovalIssueId,
      deniedAgentId: implementerId,
      disposition: proposedRemovalDisposition,
      nextDescription: null,
      checkoutRunId: null,
      expectedStatuses: ["backlog"],
    });
    expect(proposedRemovalRedirect.kind).toBe("redirected");

    const unownedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unownedIssueId,
      companyId,
      title: "Unowned admission",
      description: "Needs refinement.",
      status: "backlog",
      priority: "medium",
    });
    const unownedDisposition = evaluateIssueAdmission({
      issue: { id: unownedIssueId, description: "Needs refinement." },
      source: "status_transition",
      actorType: "agent",
    });
    if (unownedDisposition.kind !== "redirect") throw new Error("Expected unowned redirect");
    const unownedRedirect = await redirectIssueAdmission(db, {
      companyId,
      issueId: unownedIssueId,
      deniedAgentId: null,
      returnOwnerAgentId: null,
      disposition: unownedDisposition,
      checkoutRunId: null,
      expectedStatuses: ["backlog"],
    });
    expect(unownedRedirect).toMatchObject({
      kind: "external_intervention",
      reason: "no_eligible_refinement_owner",
    });
    const unownedAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, unownedIssueId))
      .then((rows) => rows[0]!);
    expect(unownedAction).toMatchObject({
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      wakePolicy: null,
    });

    const disabledReturnIssueId = randomUUID();
    await db.insert(issues).values({
      id: disabledReturnIssueId,
      companyId,
      title: "Disabled return owner",
      description: "Needs refinement.",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: implementerId,
    });
    const disabledReturnDisposition = evaluateIssueAdmission({
      issue: { id: disabledReturnIssueId, description: "Needs refinement." },
      source: "checkout",
      actorType: "agent",
    });
    if (disabledReturnDisposition.kind !== "redirect") throw new Error("Expected redirect");
    const disabledReturnRedirect = await redirectIssueAdmission(db, {
      companyId,
      issueId: disabledReturnIssueId,
      deniedAgentId: implementerId,
      disposition: disabledReturnDisposition,
      checkoutRunId: null,
      expectedStatuses: ["backlog"],
    });
    expect(disabledReturnRedirect.kind).toBe("redirected");
    await db
      .update(issues)
      .set({
        description: "## Product Truth Contract\nRepaired.",
        executionPolicy: {
          workClass: "backend",
          stages: [{
            type: "review",
            participants: [{ type: "agent", agentId: managerId }],
          }],
        },
        status: "in_progress",
        assigneeAgentId: managerId,
      })
      .where(eq(issues.id, disabledReturnIssueId));
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "manual" })
      .where(eq(agents.id, implementerId));
    const disabledHandoff = await db.transaction((tx) =>
      handBackCompletedAdmissionRedirectInTransaction(tx, {
        companyId,
        issueId: disabledReturnIssueId,
        requestedByActorType: "agent",
        requestedByActorId: managerId,
        requestedByAgentId: managerId,
        actorRunId: null,
      }));
    expect(disabledHandoff).toBeNull();
    const escalatedAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, disabledReturnIssueId))
      .then((rows) => rows[0]!);
    expect(escalatedAction).toMatchObject({
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      wakePolicy: null,
    });
    const noBoardRetry = vi.fn(async () => null);
    await recoveryService(db, { enqueueWakeup: noBoardRetry })
      .reconcileAdmissionRedirectWakes({ now: new Date(Date.now() + 300_000) });
    expect(noBoardRetry.mock.calls.some(([, options]) =>
      options?.payload?.issueId === disabledReturnIssueId,
    )).toBe(false);
    const stillEscalated = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, disabledReturnIssueId))
      .then((rows) => rows[0]!);
    expect(stillEscalated).toMatchObject({
      status: "escalated",
      ownerType: "board",
      wakePolicy: null,
    });
  });
});
