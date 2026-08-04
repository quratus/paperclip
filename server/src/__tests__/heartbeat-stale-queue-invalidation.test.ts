import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineGraphRuns,
  pipelineGraphVersions,
  pipelineGraphWakeOutbox,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { pipelineGraphRunService } from "../services/pipeline-graph-runs.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_block_promoted_run ON "heartbeat_runs";
        DROP FUNCTION IF EXISTS paperclip_test_block_promoted_run();
        DROP TRIGGER IF EXISTS paperclip_test_reassign_after_claim ON "heartbeat_runs";
        DROP FUNCTION IF EXISTS paperclip_test_reassign_after_claim();
        TRUNCATE TABLE
          "company_skills",
          "issue_comments",
          "issue_documents",
          "document_revisions",
          "documents",
          "issue_relations",
          "issue_tree_holds",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const isLateCommentRace =
        error instanceof Error &&
        error.message.includes("issue_comments_issue_id_issues_id_fk");
      if (!isLateCommentRace || attempt === 9) {
        throw error;
      }

      // Heartbeat completion can write issue-thread comments shortly after the
      // run leaves queued/running. Retry the dependent deletes once those land.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatConfig?: Record<string, unknown>;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupHeartbeatInvalidationFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 20_000);

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          ...(opts.heartbeatConfig ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  it.each(["issue_assigned", "issue_commented"] as const)(
    "cancels a %s run reassigned after pre-claim validation but before execution-lock acquisition",
    async (wakeReason) => {
    const { companyId, agentId: formerOwnerId } = await seedCompanyAndAgent({ agentName: "Former Owner" });
    const currentOwnerId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: currentOwnerId,
      companyId,
      name: "Current Owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned between validation and lock",
      status: "todo",
      priority: "high",
      assigneeAgentId: formerOwnerId,
    });
    const wakeCommentId = randomUUID();
    const stale = await seedQueuedRun({
      companyId,
      agentId: formerOwnerId,
      issueId,
      wakeReason,
      contextExtras: wakeReason === "issue_commented"
        ? { commentId: wakeCommentId, wakeCommentId }
        : undefined,
    });
    await db.execute(sql.raw(`
      CREATE FUNCTION paperclip_test_reassign_after_claim() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${stale.runId}' AND OLD."status" = 'queued' AND NEW."status" = 'running' THEN
          UPDATE "issues" SET "assignee_agent_id" = '${currentOwnerId}' WHERE "id" = '${issueId}';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER paperclip_test_reassign_after_claim
        AFTER UPDATE ON "heartbeat_runs"
        FOR EACH ROW EXECUTE FUNCTION paperclip_test_reassign_after_claim();
    `));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () =>
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, stale.runId))
        .then((rows) => rows[0]?.status === "cancelled"));

    const [run, issue] = await Promise.all([
      db.select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.id, stale.runId)).then((rows) => rows[0]),
      db.select({
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
      }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
    ]);
    expect(countExecuteCallsForRun(stale.runId)).toBe(0);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "issue_execution_lock_changed",
      resultJson: { stopReason: "issue_execution_lock_changed" },
    });
    expect(issue).toEqual({ assigneeAgentId: currentOwnerId, executionRunId: null });
    },
  );

  it("cancels a former owner's queued assignment run after reassignment before the current owner proceeds", async () => {
    const { companyId, agentId: formerOwnerId } = await seedCompanyAndAgent({ agentName: "Former Owner" });
    const currentOwnerId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: currentOwnerId,
      companyId,
      name: "Current Owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned before queued wake delivery",
      status: "todo",
      priority: "high",
      assigneeAgentId: formerOwnerId,
    });
    const stale = await seedQueuedRun({
      companyId,
      agentId: formerOwnerId,
      issueId,
      wakeReason: "issue_assigned",
      contextExtras: { taskId: issueId },
    });

    await db
      .update(issues)
      .set({ assigneeAgentId: currentOwnerId, updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, stale.runId));
      return run?.status === "cancelled";
    });

    expect(countExecuteCallsForRun(stale.runId)).toBe(0);
    const [staleRun] = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, stale.runId));
    const [staleWake] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, stale.wakeupRequestId));
    const [afterStale] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(staleRun).toMatchObject({
      status: "cancelled",
      errorCode: "issue_assignee_changed",
      resultJson: { stopReason: "issue_assignee_changed" },
    });
    expect(staleRun?.error).toContain("new owner will be woken instead");
    expect(staleWake).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("new owner will be woken instead"),
    });
    expect(afterStale).toMatchObject({
      status: "todo",
      assigneeAgentId: currentOwnerId,
      checkoutRunId: null,
      executionRunId: null,
    });

    const currentSlotHolderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: currentSlotHolderRunId,
      companyId,
      agentId: currentOwnerId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { taskKey: "slot-holder" },
    });

    const current = await heartbeat.wakeup(currentOwnerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned", skipIssueComment: true },
      requestedByActorType: "system",
      requestedByActorId: "issue_assignment",
    });
    expect(current).not.toBeNull();

    expect(countExecuteCallsForRun(current!.id)).toBe(0);
    const [currentRun] = await db
      .select({
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, current!.id));
    const [currentWake] = await db
      .select({
        status: agentWakeupRequests.status,
        agentId: agentWakeupRequests.agentId,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, current!.id));
    const [afterCurrent] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(currentRun).toMatchObject({
      status: "queued",
      agentId: currentOwnerId,
      invocationSource: "assignment",
    });
    expect(currentWake).toMatchObject({
      status: "queued",
      agentId: currentOwnerId,
      runId: current!.id,
    });
    expect(afterCurrent).toMatchObject({
      status: "todo",
      assigneeAgentId: currentOwnerId,
      checkoutRunId: null,
      executionRunId: null,
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, currentSlotHolderRunId));
  }, 10_000);

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it("skips generic timer wakes with no actionable assigned work before adapter execution", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const runRows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        reason: expect.stringContaining("No assigned todo or in_progress issue"),
      },
    });
    expect(runRows).toHaveLength(0);
  });

  it("rate-limits skipped generic timer wakes by advancing the timer baseline", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(agents.id, agentId));

    const firstTick = await heartbeat.tickTimers(now);
    const secondTick = await heartbeat.tickTimers(now);

    expect(firstTick.skipped).toBe(1);
    expect(secondTick.skipped).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.reason).toBe("heartbeat.timer.no_actionable_work");
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThan(now.getTime() - 120_000);
  });

  it("allows generic timer wakes when the agent has assigned todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);

    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows legacy generic timer wakes by default when no skip policy is set", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows explicit proactive generic timer wakes without assigned issue work", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips wakes before queueing when per-agent daily run cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("treats zero daily run cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("counts started cancelled runs toward the per-agent daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("coalesces same-issue wakes before enforcing the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(run?.id).toBe(queuedRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "coalesced",
          reason: "issue_execution_same_name",
          runId: queuedRunId,
        }),
      ]),
    );
  });

  it("skips wakes before queueing when per-agent daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 75,
        limit: 75,
      },
    });
  });

  it("treats zero daily cost cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("skips already queued runs before adapter execution when the daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_cost_limit",
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.daily_cost_limit",
      observed: 75,
      limit: 75,
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("per-day heartbeat budget cap"),
    });
  });

  it("skips already queued issue runs at the daily run cap and releases the execution lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_run_limit",
    });
    expect(wakeup).toMatchObject({ status: "skipped" });
    expect(issue?.executionRunId).toBeNull();
  });

  it("promotes deferred issue wakes when a queued holder is cancelled by the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "PeerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_mention",
        },
      },
      status: "deferred_issue_execution",
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [deferred] = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId));
      return Boolean(deferred?.runId) && deferred?.status !== "deferred_issue_execution";
    });

    const [deferred] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId));
    const [promotedRun] = deferred?.runId
      ? await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, deferred.runId))
      : [];

    expect(deferred?.status).not.toBe("deferred_issue_execution");
    expect(promotedRun?.agentId).toBe(peerAgentId);
  });

  it("serializes real deferred-wake promotion against graph activation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: { maxDailyRuns: 1 },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "DeferredPeer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred promotion race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: peerAgentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, wakeReason: "issue_mention" },
      },
      status: "deferred_issue_execution",
    });
    await db.update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: `promotion-race-${randomUUID()}`,
      name: "Promotion race",
    }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "work",
      name: "Work",
      kind: "working",
      position: 100,
    }).returning();
    const [graphVersion] = await db.insert(pipelineGraphVersions).values({
      companyId,
      pipelineId: pipeline!.id,
      version: 1,
      definitionHash: "c".repeat(64),
      schemaVersion: 1,
      definition: {
        schemaVersion: 1,
        entryNodeKey: "work",
        nodes: [{ key: "work", kind: "working", name: "Work", config: {} }],
        edges: [],
      },
      status: "active",
      createdByType: "user",
      createdById: "board-user",
      activatedByType: "user",
      activatedById: "board-user",
      activatedAt: new Date(),
    }).returning();
    const [pipelineCase] = await db.insert(pipelineCases).values({
      companyId,
      pipelineId: pipeline!.id,
      graphVersionId: graphVersion!.id,
      stageId: stage!.id,
      caseKey: `promotion-race-${randomUUID()}`,
      title: "Promotion race",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId: pipelineCase!.id,
      issueId,
      role: "work",
    });

    const barrierKey = `paperclip-test-promotion:${randomUUID()}`;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_block_promoted_run()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.wakeup_request_id::text = '${deferredWakeupId}' THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('${barrierKey}', 0));
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER paperclip_test_block_promoted_run
      BEFORE INSERT ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_block_promoted_run();
    `));

    let releaseBarrier!: () => void;
    const barrierMayRelease = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let markBarrierHeld!: () => void;
    const barrierHeld = new Promise<void>((resolve) => { markBarrierHeld = resolve; });
    const barrier = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${barrierKey}, 0))`);
      markBarrierHeld();
      await barrierMayRelease;
    });
    await barrierHeld;

    let releasePeerExecution!: () => void;
    const peerMayFinish = new Promise<void>((resolve) => { releasePeerExecution = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await peerMayFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Deferred owner completed.",
        provider: "test",
        model: "test-model",
      };
    });

    const promotion = heartbeat.resumeQueuedRuns();
    const promotionWaiting = await waitForCondition(async () => {
      const result = await db.execute(sql`
        select exists (
          select 1 from pg_locks
          where locktype = 'advisory'
            and not granted
            and classid = (((hashtextextended(${barrierKey}, 0) >> 32) & 4294967295)::oid)
            and objid = ((hashtextextended(${barrierKey}, 0) & 4294967295)::oid)
        ) as waiting
      `) as unknown as Array<{ waiting: boolean }>;
      return result[0]?.waiting === true;
    });
    expect(promotionWaiting).toBe(true);

    let activationSettled = false;
    const activation = pipelineGraphRunService(db).start({
      companyId,
      caseId: pipelineCase!.id,
      idempotencyKey: `promotion-race-${randomUUID()}`,
      actor: { type: "user", userId: "board-user" },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { activationSettled = true; });

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(activationSettled).toBe(false);
      releaseBarrier();
      await barrier;
      const activationResult = await activation;
      expect(activationResult.ok).toBe(false);
      if (activationResult.ok) throw new Error("Expected graph activation to redirect");
      expect(activationResult.error).toMatchObject({
        status: 409,
        details: expect.objectContaining({ code: "graph_run_legacy_issue_owner_active" }),
      });
      expect(await db.select().from(pipelineGraphRuns)
        .where(eq(pipelineGraphRuns.caseId, pipelineCase!.id))).toHaveLength(0);
      const [deferred] = await db.select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId));
      expect(deferred?.status).not.toBe("deferred_issue_execution");
      expect(deferred?.runId).toBeTruthy();

      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      releasePeerExecution();
      await promotion;
      const peerSettled = await waitForCondition(async () => {
        if (!deferred?.runId) return true;
        const [run] = await db.select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, deferred.runId));
        return !run || ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status);
      });
      expect(peerSettled).toBe(true);
    } finally {
      releaseBarrier();
      releasePeerExecution();
      await barrier.catch(() => undefined);
    }

    await db.execute(sql.raw(`
      DROP TRIGGER IF EXISTS paperclip_test_block_promoted_run ON heartbeat_runs;
      DROP FUNCTION IF EXISTS paperclip_test_block_promoted_run();
    `));
  }, 20_000);

  it("redirects deferred responsibility when the graph already owns the issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Graph-owned deferred wake",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: `graph-wins-${randomUUID()}`,
      name: "Graph wins",
    }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "work",
      name: "Work",
      kind: "working",
      position: 100,
    }).returning();
    const [graphVersion] = await db.insert(pipelineGraphVersions).values({
      companyId,
      pipelineId: pipeline!.id,
      version: 1,
      definitionHash: "d".repeat(64),
      schemaVersion: 1,
      definition: {
        schemaVersion: 1,
        entryNodeKey: "work",
        nodes: [{ key: "work", kind: "working", name: "Work", config: {} }],
        edges: [],
      },
      status: "active",
      createdByType: "user",
      createdById: "board-user",
      activatedByType: "user",
      activatedById: "board-user",
      activatedAt: new Date(),
    }).returning();
    const [pipelineCase] = await db.insert(pipelineCases).values({
      companyId,
      pipelineId: pipeline!.id,
      graphVersionId: graphVersion!.id,
      stageId: stage!.id,
      caseKey: `graph-wins-${randomUUID()}`,
      title: "Graph wins",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId: pipelineCase!.id,
      issueId,
      role: "work",
    });
    const graphOwner = await pipelineGraphRunService(db).start({
      companyId,
      caseId: pipelineCase!.id,
      idempotencyKey: `graph-wins-${randomUUID()}`,
      actor: { type: "user", userId: "board-user" },
    });

    const secondWakeupRequestId = randomUUID();
    const secondQueuedRunId = randomUUID();
    const secondDeferredWakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: secondWakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {
        issueId,
        pipelineGraphWake: true,
        graphRunId: graphOwner.run.id,
        graphRunRevision: graphOwner.run.revision,
      },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: secondQueuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId: secondWakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        pipelineGraphWake: true,
        graphRunId: graphOwner.run.id,
        graphRunRevision: graphOwner.run.revision,
        targetNodeKey: graphOwner.run.currentNodeKey,
      },
    });
    await db.insert(agentWakeupRequests).values({
      id: secondDeferredWakeupId,
      companyId,
      agentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: { issueId, _paperclipWakeContext: { issueId, wakeReason: "issue_mention" } },
      status: "deferred_issue_execution",
    });
    await db.update(agentWakeupRequests)
      .set({ runId: secondQueuedRunId })
      .where(eq(agentWakeupRequests.id, secondWakeupRequestId));
    await db.update(issues).set({
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: secondQueuedRunId,
      executionAgentNameKey: null,
      executionLockedAt: new Date(),
    }).where(eq(issues.id, issueId));

    await heartbeat.cancelRun(secondQueuedRunId, "Graph wake finalizer proof", {
      suppressImmediateRecovery: true,
    });
    const [redirectedDeferred] = await db.select({
      status: agentWakeupRequests.status,
      error: agentWakeupRequests.error,
      runId: agentWakeupRequests.runId,
    }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, secondDeferredWakeupId));
    expect(redirectedDeferred).toMatchObject({
      status: "cancelled",
      runId: null,
      error: expect.stringContaining(`Responsibility redirected to active pipeline graph run ${graphOwner.run.id}`),
    });
    expect(await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, secondDeferredWakeupId))).toHaveLength(0);
  }, 15_000);

  it("cancels queued runs when the issue assignee changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued runs when the issue reaches a terminal status before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when the issue is no longer in_progress before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked max-turn continuation",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_not_in_progress");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_not_in_progress" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("no longer in_progress");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued in_review runs when the current participant changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task now owned by reviewer",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_review_participant_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("in-review participant changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("runs a current graph assignment when legacy issue routing still names the reviewer", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "LegacyReviewer",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: `graph-${randomUUID()}`,
      name: "Graph-owned work",
    }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "implement",
      name: "Implement",
      kind: "working",
      position: 100,
    }).returning();
    const [graphVersion] = await db.insert(pipelineGraphVersions).values({
      companyId,
      pipelineId: pipeline!.id,
      version: 1,
      definitionHash: "a".repeat(64),
      schemaVersion: 1,
      definition: {
        schemaVersion: 1,
        entryNodeKey: "implement",
        nodes: [{
          key: "implement",
          kind: "working",
          name: "Implement",
          config: { targetAgentId: agentId },
        }],
        edges: [],
      },
      status: "active",
      createdByType: "user",
      createdById: "board-user",
      activatedByType: "user",
      activatedById: "board-user",
      activatedAt: new Date(),
    }).returning();
    const [pipelineCase] = await db.insert(pipelineCases).values({
      companyId,
      pipelineId: pipeline!.id,
      graphVersionId: graphVersion!.id,
      stageId: stage!.id,
      caseKey: `case-${randomUUID()}`,
      title: "Graph canary",
    }).returning();
    const [graphRun] = await db.insert(pipelineGraphRuns).values({
      companyId,
      pipelineId: pipeline!.id,
      graphVersionId: graphVersion!.id,
      caseId: pipelineCase!.id,
      startIdempotencyKey: `start-${randomUUID()}`,
      status: "running",
      currentNodeKey: "implement",
      revision: 3,
      startedByType: "user",
      startedById: "board-user",
    }).returning();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Legacy review projection lags the graph",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId: pipelineCase!.id,
      issueId,
      role: "work",
    });
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId,
      companyId,
      title: "Unrelated issue must not inherit graph authority",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
    });
    const { runId: unrelatedRunId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId: unrelatedIssueId,
      wakeReason: "pipeline_graph_wake",
      invocationSource: "automation",
      contextExtras: {
        pipelineGraphWake: true,
        graphRunId: graphRun!.id,
        graphRunRevision: graphRun!.revision,
        targetNodeKey: graphRun!.currentNodeKey,
      },
    });

    await heartbeat.reapOrphanedRuns();

    expect(await db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, unrelatedRunId))
      .then((rows) => rows[0]?.status)).toBe("cancelled");
    expect(await db.select({ errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, unrelatedRunId))
      .then((rows) => rows[0]?.errorCode)).toBe("pipeline_graph_superseded");
    expect(countExecuteCallsForRun(unrelatedRunId)).toBe(0);

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "pipeline_graph_wake",
      invocationSource: "automation",
      contextExtras: {
        pipelineGraphWake: true,
        graphRunId: graphRun!.id,
        graphRunRevision: graphRun!.revision,
        targetNodeKey: graphRun!.currentNodeKey,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(countExecuteCallsForRun(runId)).toBe(1);
  }, 10_000);

  it("redirects a capacity-exhausted graph assignment to its recovery owner", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const recoveryAgentId = randomUUID();
    await db.insert(agents).values({
      id: recoveryAgentId,
      companyId,
      name: "CapacityRecoveryOwner",
      role: "operations",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: `capacity-graph-${randomUUID()}`,
      name: "Capacity-aware work",
    }).returning();
    const [implementStage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "implement",
      name: "Implement",
      kind: "working",
      position: 100,
    }).returning();
    await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "capacity_recovery",
      name: "Capacity recovery",
      kind: "working",
      position: 200,
    });
    const [graphVersion] = await db.insert(pipelineGraphVersions).values({
      companyId,
      pipelineId: pipeline!.id,
      version: 1,
      definitionHash: "b".repeat(64),
      schemaVersion: 1,
      definition: {
        schemaVersion: 1,
        entryNodeKey: "implement",
        nodes: [
          {
            key: "implement",
            kind: "working",
            name: "Implement",
            config: {
              dispatchEnabled: true,
              targetAgentId: agentId,
              responsibilityOwner: "implementer",
            },
          },
          {
            key: "capacity_recovery",
            kind: "working",
            name: "Capacity recovery",
            config: {
              dispatchEnabled: true,
              targetAgentId: recoveryAgentId,
              responsibilityOwner: "capacity_recovery_owner",
            },
          },
        ],
        edges: [{
          fromNodeKey: "implement",
          toNodeKey: "capacity_recovery",
          outcome: "capacity_unavailable",
        }],
        cycleContracts: [],
      },
      status: "active",
      createdByType: "user",
      createdById: "board-user",
      activatedByType: "user",
      activatedById: "board-user",
      activatedAt: new Date(),
    }).returning();
    const [pipelineCase] = await db.insert(pipelineCases).values({
      companyId,
      pipelineId: pipeline!.id,
      graphVersionId: graphVersion!.id,
      stageId: implementStage!.id,
      caseKey: `capacity-case-${randomUUID()}`,
      title: "Capacity redirect canary",
    }).returning();
    const [graphRun] = await db.insert(pipelineGraphRuns).values({
      companyId,
      pipelineId: pipeline!.id,
      graphVersionId: graphVersion!.id,
      caseId: pipelineCase!.id,
      startIdempotencyKey: `start-${randomUUID()}`,
      status: "running",
      currentNodeKey: "implement",
      checkpoint: { review_revision: 4, evidence: "preserved" },
      revision: 5,
      startedByType: "user",
      startedById: "board-user",
    }).returning();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Redirect capacity instead of refusing",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId: pipelineCase!.id,
      issueId,
      role: "work",
    });
    const graphAssignment = {
      schemaVersion: 1,
      id: `${graphRun!.id}:${graphRun!.revision}:implement`,
      graphVersionId: graphVersion!.id,
      runId: graphRun!.id,
      runRevision: graphRun!.revision,
      caseId: pipelineCase!.id,
      nodeKey: "implement",
      nodeKind: "working",
      responsibilityOwner: "implementer",
      targetAgentId: agentId,
      instruction: null,
      acceptanceCriteria: [],
      allowedOutcomes: ["capacity_unavailable"],
      completion: {
        method: "POST",
        path: `/api/graph-runs/${graphRun!.id}/transitions`,
        requiredFields: ["expectedRevision", "idempotencyKey", "outcome", "checkpoint"],
      },
    };
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "pipeline_graph_wake",
      invocationSource: "automation",
      contextExtras: {
        pipelineGraphWake: true,
        graphRunId: graphRun!.id,
        graphRunRevision: graphRun!.revision,
        pipelineCaseId: pipelineCase!.id,
        targetNodeKey: "implement",
        graphAssignment,
      },
    });
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 75,
      signal: null,
      timedOut: false,
      errorCode: "capacity_exhausted",
      errorMessage: "Temporary capacity unavailable",
      resultJson: { stdout: "", stderr: "" },
    });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const current = await db.select({
        revision: pipelineGraphRuns.revision,
        currentNodeKey: pipelineGraphRuns.currentNodeKey,
      }).from(pipelineGraphRuns).where(eq(pipelineGraphRuns.id, graphRun!.id))
        .then((rows) => rows[0] ?? null);
      return current?.revision === 6 && current.currentNodeKey === "capacity_recovery";
    }, 5_000)).toBe(true);
    const [failedRun, redirectedGraph, recoveryWake] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null),
      db.select({ checkpoint: pipelineGraphRuns.checkpoint })
        .from(pipelineGraphRuns).where(eq(pipelineGraphRuns.id, graphRun!.id)).then((rows) => rows[0] ?? null),
      db.select({ targetNodeKey: pipelineGraphWakeOutbox.targetNodeKey, payload: pipelineGraphWakeOutbox.payload })
        .from(pipelineGraphWakeOutbox).where(eq(pipelineGraphWakeOutbox.runId, graphRun!.id))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(failedRun).toMatchObject({ status: "failed", errorCode: "capacity_exhausted" });
    expect(redirectedGraph?.checkpoint).toMatchObject({
      review_revision: 5,
      evidence: "preserved",
      capacityFailure: {
        heartbeatRunId: runId,
        failedAgentId: agentId,
        issueId,
        errorCode: "capacity_exhausted",
        responsibleOwner: "capacity_recovery_owner",
      },
    });
    expect(recoveryWake).toMatchObject({
      targetNodeKey: "capacity_recovery",
      payload: {
        targetAgentId: recoveryAgentId,
        responsibilityOwner: "capacity_recovery_owner",
      },
    });
  }, 10_000);

  it("redirects comment-driven work away from a former in_review participant", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with comment feedback",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "Review feedback comment",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("baseline: runs queued runs when the issue is in_progress with the same assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still actionable",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("cancels queued continuation recovery when the continuation summary parks executor work for review", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_continuation_waiting_on_review" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("continuation summary says the executor should wait");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("runs accepted-interaction continuation recovery despite a pre-acceptance review park", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Approved implementation resumes",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
        mutation: "interaction",
        interactionId: randomUUID(),
        interactionResolvedAt: "2026-03-19T00:05:00.000Z",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });
});
