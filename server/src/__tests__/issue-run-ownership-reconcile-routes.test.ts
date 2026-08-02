import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-ownership reconcile route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// SQN-4980: stale run-ownership pointers strand COMPLETED issues at closeout.
// These four suites lock in the acceptance criteria from the issue: assignee
// self-heal on a terminal transition (AC1), durable pointer clearing on
// reassignment (AC2), an authorized non-assignee force-reconcile path (AC3),
// and preservation of a live competing checkout (AC4).
describeEmbeddedPostgres("issue run-ownership reconcile routes (SQN-4980)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-ownership-reconcile-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // The board actor authenticates as user "board-user"; company-scope checks
    // read active membership from the database, so seed it here.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    opts: { role?: string; name?: string; reportsTo?: string | null } = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.name ?? "Agent",
      role: opts.role ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo: opts.reportsTo ?? null,
    });
    return agentId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    status: "running" | "failed" | "timed_out" | "succeeded",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      invocationSource: "manual",
      ...(status === "running" ? { startedAt: new Date() } : { finishedAt: new Date() }),
    });
    return runId;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function outsideBoardActor(): Express.Request["actor"] {
    return {
      type: "board",
      userId: "outside-user",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  // ── AC1 ────────────────────────────────────────────────────────────────
  // The rightful assignee can drive a terminal status transition even though
  // both checkoutRunId and executionRunId still point at a dead run. The
  // stranded state (SQN-4510/4910) self-heals instead of throwing an ownership
  // conflict.
  it("AC1: assignee terminal transition self-heals when both pointers reference a dead run", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const deadRun = await seedRun(companyId, assignee, "failed");
    const liveRun = await seedRun(companyId, assignee, "running");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded completed work",
      status: "in_progress",
      priority: "high",
      // docs_ops keeps the transition off the product-truth admission redirect
      // and the in_review review-path gate, isolating the run-ownership check.
      executionPolicy: { workClass: "docs_ops" },
      assigneeAgentId: assignee,
      checkoutRunId: deadRun,
      executionRunId: deadRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, assignee, liveRun)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  // ── AC2 ────────────────────────────────────────────────────────────────
  // Reassigning the issue to a different agent durably clears the run-ownership
  // pointers in the database (not just in the response body).
  it("AC2: reassignment durably clears checkoutRunId and executionRunId", async () => {
    // Exercised at the service layer to isolate the durability guarantee (the
    // incident was "response said executionRunId:null but the DB kept the stale
    // id") from the route-level assignment side effects (wakeups, admission).
    const companyId = await seedCompany();
    const previous = await seedAgent(companyId, { name: "Previous" });
    const next = await seedAgent(companyId, { name: "Next" });
    const deadRun = await seedRun(companyId, previous, "failed");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassign clears pointers",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: previous,
      checkoutRunId: deadRun,
      executionRunId: deadRun,
      executionAgentNameKey: "previous",
      executionLockedAt: new Date(),
    });

    const svc = issueService(db);
    const updated = await svc.update(issueId, { assigneeAgentId: next });

    // Response projection reports the cleared pointers...
    expect(updated?.assigneeAgentId).toBe(next);
    expect(updated?.checkoutRunId ?? null).toBeNull();
    expect(updated?.executionRunId ?? null).toBeNull();

    // ...and the durable row matches (not just the response body).
    const row = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      assigneeAgentId: next,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  // ── AC3 ────────────────────────────────────────────────────────────────
  // A non-assignee control-plane authority (CEO / recovery owner) that is locked
  // out of the normal assignee mutation boundary can force-reconcile orphaned
  // run ownership through the admin endpoint, with an audit trail.
  it("AC3: the assignee-boundary blocks a non-assignee CEO from a direct PATCH", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const ceo = await seedAgent(companyId, { name: "Charles", role: "ceo" });
    const ceoRun = await seedRun(companyId, ceo, "running");
    const deadRun = await seedRun(companyId, assignee, "failed");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked-out reconcile",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      checkoutRunId: deadRun,
      executionRunId: deadRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, ceo, ceoRun)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    // The direct PATCH must not succeed and must not mutate the pointers.
    expect(res.status).not.toBe(200);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: deadRun, executionRunId: deadRun });
  });

  it("AC3: a CEO can force-reconcile orphaned run ownership and it writes an audit trail", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const ceo = await seedAgent(companyId, { name: "Charles", role: "ceo" });
    const ceoRun = await seedRun(companyId, ceo, "running");
    const deadRun = await seedRun(companyId, assignee, "failed");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reconcile orphaned pointers",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      checkoutRunId: deadRun,
      executionRunId: deadRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, ceo, ceoRun)))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.previous).toEqual({ checkoutRunId: deadRun, executionRunId: deadRun });
    expect(res.body.reconciled).toEqual({ checkoutRunId: true, executionRunId: true });
    // Assignee and status are preserved (this is a reconcile, not a release).
    expect(res.body.issue).toMatchObject({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: assignee,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: assignee,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    const audit = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_reconcile_run_ownership"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.admin_reconcile_run_ownership",
      entityId: issueId,
    });

    const comment = await db
      .select({ authorType: issueComments.authorType, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows[0]);
    expect(comment?.authorType).toBe("system");
    expect(comment?.body ?? "").toContain("run ownership");
  });

  it("AC3: force-reconcile preserves a live run pointer and only clears the orphaned one", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const ceo = await seedAgent(companyId, { name: "Charles", role: "ceo" });
    const ceoRun = await seedRun(companyId, ceo, "running");
    const deadRun = await seedRun(companyId, assignee, "failed");
    const liveRun = await seedRun(companyId, assignee, "running");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed live and dead pointers",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      // checkout on a live run, execution lock on a dead run.
      checkoutRunId: liveRun,
      executionRunId: deadRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, ceo, ceoRun)))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reconciled).toEqual({ checkoutRunId: false, executionRunId: true });

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // Live checkout preserved; only the orphaned execution lock cleared.
    expect(row).toEqual({ checkoutRunId: liveRun, executionRunId: null });
  });

  it("AC3: an unrelated agent cannot force-reconcile another agent's issue", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const stranger = await seedAgent(companyId, { name: "Stranger" });
    const strangerRun = await seedRun(companyId, stranger, "running");
    const deadRun = await seedRun(companyId, assignee, "failed");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unauthorized reconcile",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      checkoutRunId: deadRun,
      executionRunId: deadRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, stranger, strangerRun)))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send();

    expect(res.status).toBe(403);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: deadRun, executionRunId: deadRun });
  });

  it("AC3: a board user with company access can force-reconcile; an outsider cannot", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const deadRun = await seedRun(companyId, assignee, "failed");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board reconcile",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      checkoutRunId: deadRun,
      executionRunId: deadRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    await request(createApp(outsideBoardActor()))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send()
      .expect(404);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reconciled).toEqual({ checkoutRunId: true, executionRunId: true });

    const row = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ assigneeAgentId: assignee, checkoutRunId: null, executionRunId: null });
  });

  // ── Security regression (independent review, 2026-08-02) ───────────────
  // An agent from a different company must not be able to reach an
  // unassigned issue in another tenant just because assigneeAgentId is null.
  it("cross-tenant: an agent in a different company cannot reconcile another company's unassigned issue", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const outsideAgent = await seedAgent(otherCompanyId, { name: "Outsider" });
    const outsideRun = await seedRun(otherCompanyId, outsideAgent, "running");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unassigned issue in a different company",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });

    const res = await request(createApp(agentActor(otherCompanyId, outsideAgent, outsideRun)))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send();

    // Cross-tenant lookup must fail closed as a 404 (existence hiding), never
    // a 200 authorized:true fallthrough for the unassigned-issue branch.
    expect(res.status).toBe(404);
  });

  // A board viewer membership is read-only; this endpoint mutates issue state
  // and writes an audit trail, so it must be excluded like every other
  // mutating admin route.
  it("a board viewer cannot force-reconcile (mutating action requires write access)", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const deadRun = await seedRun(companyId, assignee, "failed");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Viewer cannot reconcile",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      checkoutRunId: deadRun,
      executionRunId: deadRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const viewerActor: Express.Request["actor"] = {
      type: "board",
      userId: "viewer-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };

    const res = await request(createApp(viewerActor))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send();

    expect(res.status).toBe(403);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: deadRun, executionRunId: deadRun });
  });

  // ── AC4 ────────────────────────────────────────────────────────────────
  // Existing valid ownership protection is preserved: a live competing run can
  // neither steal an active checkout via PATCH nor via force-reconcile.
  it("AC4: a different live run cannot steal an active checkout via PATCH", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const liveOwnerRun = await seedRun(companyId, assignee, "running");
    const contenderRun = await seedRun(companyId, assignee, "running");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live owner protected",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      checkoutRunId: liveOwnerRun,
      executionRunId: liveOwnerRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, assignee, contenderRun)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: liveOwnerRun, executionRunId: liveOwnerRun });
  });

  it("AC4: force-reconcile is a no-op when both pointers reference live runs", async () => {
    const companyId = await seedCompany();
    const assignee = await seedAgent(companyId, { name: "Implementer" });
    const ceo = await seedAgent(companyId, { name: "Charles", role: "ceo" });
    const ceoRun = await seedRun(companyId, ceo, "running");
    const liveRun = await seedRun(companyId, assignee, "running");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live pointers untouched",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignee,
      checkoutRunId: liveRun,
      executionRunId: liveRun,
      executionAgentNameKey: "implementer",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, ceo, ceoRun)))
      .post(`/api/issues/${issueId}/admin/reconcile-run-ownership`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reconciled).toEqual({ checkoutRunId: false, executionRunId: false });

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: liveRun, executionRunId: liveRun });
  });
});
