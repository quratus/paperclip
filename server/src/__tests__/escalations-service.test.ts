import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { createEscalation } from "../services/escalations.ts";

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
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup() {
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
    const companyId = await setup();
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
    const companyId = await setup();
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

  it("reversible + low + waitCondition → auto_clearing, one approvals row", async () => {
    const companyId = await setup();
    const result = await createEscalation(db, {
      companyId,
      actionKind: "send_message",
      reversibility: "reversible",
      impact: "low",
      waitCondition: "2026-09-01",
    });

    expect(result.gateState).toBe("auto_clearing");
    expect(result.approvalId).toBeTruthy();

    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("loop_action");
    expect((rows[0].payload as Record<string, unknown>).gateState).toBe("auto_clearing");
    expect((rows[0].payload as Record<string, unknown>).waitCondition).toBe("2026-09-01");
  });
});
