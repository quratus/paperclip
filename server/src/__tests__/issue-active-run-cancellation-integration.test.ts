import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("active-run issue cancellation integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-active-run-cancel-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appForActor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedActiveRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancel active run",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: new Date(),
    });
    return { companyId, agentId, issueId, runId };
  }

  it("cancels the claimed run, clears ownership, records activity, and rejects late run output", async () => {
    const fixture = await seedActiveRunFixture();
    const boardApp = appForActor({
      type: "board",
      userId: "local-board",
      companyIds: [fixture.companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const cancelRes = await request(boardApp)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ status: "cancelled" });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("cancelled");
    expect(cancelRes.body.checkoutRunId).toBeNull();
    expect(cancelRes.body.executionRunId).toBeNull();

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because its issue was cancelled",
      errorCode: "cancelled",
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.runId));
    expect(activity).toMatchObject({
      action: "heartbeat.cancelled",
      details: expect.objectContaining({
        issueId: fixture.issueId,
        source: "issue_status_cancelled",
      }),
    });

    const agentApp = appForActor({
      type: "agent",
      agentId: fixture.agentId,
      companyId: fixture.companyId,
      source: "agent_key",
      runId: fixture.runId,
    });
    const lateCommentRes = await request(agentApp)
      .post(`/api/issues/${fixture.issueId}/comments`)
      .send({ body: "late normal output" });

    expect(lateCommentRes.status).toBe(409);
    expect(lateCommentRes.body.details).toMatchObject({
      issueId: fixture.issueId,
      issueStatus: "cancelled",
      runId: fixture.runId,
      runStatus: "cancelled",
    });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(0);
  });
});
