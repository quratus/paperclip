import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
  issues,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { createEscalation, sweepAutoClearing } from "../services/escalations.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping escalations service tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("createEscalation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-escalations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "EscalationCo",
      issuePrefix: `EC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("reversible + low + no waitCondition → ungated, zero approvals rows created", async () => {
    const companyId = await setupCompany();
    const result = await createEscalation(db, {
      companyId,
      actionKind: "file_write",
      reversibility: "reversible",
      impact: "low",
    });

    expect(result.gateState).toBe("ungated");
    expect(result.approvalId).toBeNull();

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("irreversible + high → batched_escalate, exactly one approvals row with correct fields", async () => {
    const companyId = await setupCompany();
    const result = await createEscalation(db, {
      companyId,
      actionKind: "delete_database",
      reversibility: "irreversible",
      impact: "high",
    });

    expect(result.gateState).toBe("batched_escalate");
    expect(result.approvalId).toBeTruthy();

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.type).toBe("loop_action");
    expect(row.status).toBe("pending");
    expect(row.reversibility).toBe("irreversible");
    expect(row.impact).toBe("high");
    expect((row.payload as Record<string, unknown>).gateState).toBe("batched_escalate");
    expect((row.payload as Record<string, unknown>).actionKind).toBe("delete_database");
    expect(row.id).toBe(result.approvalId);
  });

  it("reversible + low + schedule waitCondition → auto_clearing, row stores structured waitCondition", async () => {
    const companyId = await setupCompany();
    const result = await createEscalation(db, {
      companyId,
      actionKind: "send_message",
      reversibility: "reversible",
      impact: "low",
      waitCondition: { kind: "schedule", fireAt: "2026-09-01T00:00:00.000Z" },
    });

    expect(result.gateState).toBe("auto_clearing");
    expect(result.approvalId).toBeTruthy();

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("loop_action");
    expect((rows[0].waitCondition as Record<string, unknown>)?.kind).toBe("schedule");
    expect((rows[0].waitCondition as Record<string, unknown>)?.fireAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

describeEmbeddedPostgres("sweepAutoClearing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "SweepCo",
      issuePrefix: `SW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("schedule condition in the past → clears on sweep", async () => {
    const companyId = await setupCompany();
    await createEscalation(db, {
      companyId,
      actionKind: "action",
      reversibility: "reversible",
      impact: "low",
      waitCondition: { kind: "schedule", fireAt: "2020-01-01T00:00:00.000Z" },
    });

    const result = await sweepAutoClearing(db, companyId, "2026-01-01T00:00:00.000Z");
    expect(result.cleared).toBe(1);

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows[0].status).toBe("auto_cleared");
  });

  it("schedule condition in the future → does not clear", async () => {
    const companyId = await setupCompany();
    await createEscalation(db, {
      companyId,
      actionKind: "action",
      reversibility: "reversible",
      impact: "low",
      waitCondition: { kind: "schedule", fireAt: "2099-01-01T00:00:00.000Z" },
    });

    const result = await sweepAutoClearing(db, companyId, "2026-01-01T00:00:00.000Z");
    expect(result.cleared).toBe(0);

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows[0].status).toBe("pending");
  });

  it("internal condition pointing at done issue → clears", async () => {
    const companyId = await setupCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "blocking issue",
      status: "done",
      issueNumber: 1,
      identifier: "TST-1",
      originKind: "manual",
    });

    await createEscalation(db, {
      companyId,
      actionKind: "action",
      reversibility: "reversible",
      impact: "low",
      waitCondition: { kind: "internal", blockingIssueId: issueId },
    });

    const result = await sweepAutoClearing(db, companyId, "2026-01-01T00:00:00.000Z");
    expect(result.cleared).toBe(1);

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows[0].status).toBe("auto_cleared");
  });

  it("internal condition pointing at non-done issue → does not clear", async () => {
    const companyId = await setupCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "in-progress issue",
      status: "in_progress",
      issueNumber: 2,
      identifier: "TST-2",
      originKind: "manual",
    });

    await createEscalation(db, {
      companyId,
      actionKind: "action",
      reversibility: "reversible",
      impact: "low",
      waitCondition: { kind: "internal", blockingIssueId: issueId },
    });

    const result = await sweepAutoClearing(db, companyId, "2026-01-01T00:00:00.000Z");
    expect(result.cleared).toBe(0);

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows[0].status).toBe("pending");
  });
});
