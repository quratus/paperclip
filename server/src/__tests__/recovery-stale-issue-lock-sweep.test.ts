import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineGraphRuns,
  pipelineGraphVersions,
  pipelines,
  pipelineStages,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { graphRecoveryOwnershipLockKey } from "../services/pipeline-graph-ownership.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-lock sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweepStaleIssueLocks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(pipelineGraphRuns);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineGraphVersions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, runningRunId };
  }

  it("clears lock columns when checkoutRunId points at a terminal heartbeat run", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock — terminal checkoutRunId",
      // Status off in_progress + checkoutRunId still set → exactly the recurrence shape.
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.stale_lock_cleared");
    expect((audit?.details as { clearedCheckoutRunId?: string } | null)?.clearedCheckoutRunId).toBe(
      failedRunId,
    );
  });

  it("does not clear locks while the referenced run is still running", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live lock — must be preserved",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("does not clear when checkoutRunId is terminal but executionRunId is still running", async () => {
    const { companyId, agentId, failedRunId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed lock — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: failedRunId, executionRunId: runningRunId });
  });

  it("is idempotent — second pass finds nothing to clear", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idempotency",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.sweepStaleIssueLocks();
    const second = await heartbeat.sweepStaleIssueLocks();
    expect(first.cleared).toBe(1);
    expect(second.cleared).toBe(0);
  });

  it("durably clears a terminal pointer and redirects deferred work to its active graph", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Graph-owned stale finalizer",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: failedRunId,
      executionLockedAt: new Date(),
    });
    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: `stale-graph-${randomUUID()}`,
      name: "Stale graph handoff",
    }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "work",
      name: "Work",
      kind: "working",
      position: 100,
    }).returning();
    const [version] = await db.insert(pipelineGraphVersions).values({
      companyId,
      pipelineId: pipeline!.id,
      version: 1,
      definitionHash: "e".repeat(64),
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
      graphVersionId: version!.id,
      stageId: stage!.id,
      caseKey: `stale-graph-${randomUUID()}`,
      title: "Stale graph handoff",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId: pipelineCase!.id,
      issueId,
      role: "work",
    });
    const [graphRun] = await db.insert(pipelineGraphRuns).values({
      companyId,
      pipelineId: pipeline!.id,
      graphVersionId: version!.id,
      caseId: pipelineCase!.id,
      startIdempotencyKey: `stale-graph-${randomUUID()}`,
      status: "running",
      currentNodeKey: "work",
      startedByType: "user",
      startedById: "board-user",
    }).returning();
    const [deferred] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: { issueId },
      status: "deferred_issue_execution",
    }).returning();

    const result = await heartbeatService(db).sweepStaleIssueLocks();
    expect(result).toEqual({ cleared: 1, issueIds: [issueId] });
    const [updatedIssue] = await db.select({ executionRunId: issues.executionRunId })
      .from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue?.executionRunId).toBeNull();
    const [redirected] = await db.select({
      status: agentWakeupRequests.status,
      error: agentWakeupRequests.error,
    }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred!.id));
    expect(redirected).toEqual({
      status: "cancelled",
      error: `Responsibility redirected to active pipeline graph run ${graphRun!.id}`,
    });
    const [audit] = await db.select({ details: activityLog.details })
      .from(activityLog).where(eq(activityLog.action, "issue.stale_lock_cleared"));
    expect(audit?.details).toMatchObject({ redirectedToGraphRunId: graphRun!.id });
  });

  it("keeps the pool live when many sweepers contend on one issue seam", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Contended stale cleanup",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: failedRunId,
      executionLockedAt: new Date(),
    });

    let releaseBarrier!: () => void;
    const mayRelease = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => { markHeld = resolve; });
    const barrier = db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${graphRecoveryOwnershipLockKey(companyId, issueId)}, 0)
        )
      `);
      markHeld();
      await mayRelease;
    });
    await held;

    try {
      const sweeps = await Promise.all(
        Array.from({ length: 20 }, () => heartbeatService(db).sweepStaleIssueLocks()),
      );
      expect(sweeps.every((result) => result.cleared === 0)).toBe(true);
      const responsive = await Promise.race([
        db.select({ id: companies.id }).from(companies).limit(1).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(responsive).toBe(true);
    } finally {
      releaseBarrier();
      await barrier;
    }

    expect(await heartbeatService(db).sweepStaleIssueLocks()).toEqual({
      cleared: 1,
      issueIds: [issueId],
    });
  }, 15_000);
});
