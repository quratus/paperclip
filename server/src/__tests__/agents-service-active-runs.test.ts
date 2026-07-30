import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent active run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service active run projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-active-runs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("exposes routine and recovery live heartbeat rows on individual agent reads", async () => {
    const companyId = await seedCompany("Paperclip");
    const agentId = await seedAgent(companyId, "Codex");
    const routineRunId = randomUUID();
    const recoveryRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: routineRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "timer",
        triggerDetail: "system",
        contextSnapshot: { routineId: "routine-1" },
        createdAt: new Date("2026-07-30T10:00:00.000Z"),
      },
      {
        id: recoveryRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "automation",
        triggerDetail: "system",
        contextSnapshot: { issueId: "issue-1", recoveryActionId: "recovery-1" },
        startedAt: new Date("2026-07-30T10:01:00.000Z"),
        createdAt: new Date("2026-07-30T10:00:30.000Z"),
      },
    ]);

    const agent = await agentService(db).getById(agentId);

    expect(agent?.activeRun).toMatchObject({
      id: recoveryRunId,
      status: "running",
      source: "automation",
      invocationSource: "automation",
      triggerDetail: "system",
      issueId: "issue-1",
    });
    expect(agent?.activeRuns).toMatchObject([
      { id: recoveryRunId, status: "running" },
      { id: routineRunId, status: "queued", issueId: null },
    ]);
  });

  it("hydrates company agent reads without leaking live runs across companies", async () => {
    const companyId = await seedCompany("Paperclip");
    const otherCompanyId = await seedCompany("Other Co");
    const agentId = await seedAgent(companyId, "Codex");
    const otherAgentId = await seedAgent(otherCompanyId, "Codex");
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        triggerDetail: "callback",
        contextSnapshot: { issueId: "issue-1" },
        startedAt: new Date("2026-07-30T10:01:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "running",
        invocationSource: "timer",
        triggerDetail: "system",
        contextSnapshot: { issueId: "other-issue" },
        startedAt: new Date("2026-07-30T10:02:00.000Z"),
      },
    ]);

    const listed = await agentService(db).list(companyId);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.activeRun).toMatchObject({
      id: runId,
      status: "running",
      issueId: "issue-1",
    });
    expect(listed[0]?.activeRuns).toHaveLength(1);
  });

  it("does not project completed heartbeat rows as active work", async () => {
    const companyId = await seedCompany("Paperclip");
    const agentId = await seedAgent(companyId, "Codex");

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "callback",
      contextSnapshot: { issueId: "issue-1" },
      startedAt: new Date("2026-07-30T10:01:00.000Z"),
      finishedAt: new Date("2026-07-30T10:02:00.000Z"),
    });

    const agent = await agentService(db).getById(agentId);

    expect(agent?.activeRun).toBeNull();
    expect(agent?.activeRuns).toEqual([]);
  });
});
