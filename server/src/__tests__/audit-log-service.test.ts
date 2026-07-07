import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { auditLog, companies, createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { appendAuditEntry, recomputeAuditHash } from "../services/audit-log.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping audit log tests: ${support.reason ?? "unsupported"}`);

describePg("appendAuditEntry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-audit-log-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "audit_log" RESTART IDENTITY`);
    await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "AuditCo", issuePrefix: `AU${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    return id;
  }

  it("chains sequential appends to the previous row hash", async () => {
    const companyId = await company();
    const first = await appendAuditEntry(db, { companyId, eventType: "approval.created", subjectType: "approval", subjectId: randomUUID(), payload: { b: 2, a: 1 } });
    const second = await appendAuditEntry(db, { companyId, eventType: "approval.decided", subjectType: "approval", subjectId: first.subjectId, payload: { status: "approved" } });
    expect(second.prevHash).toBe(first.thisHash);
    expect(first.thisHash).toBe(await recomputeAuditHash(db, first));
    expect(second.thisHash).toBe(await recomputeAuditHash(db, second));
  });

  it("serializes concurrent appends without duplicate seq or broken links", async () => {
    const companyId = await company();
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendAuditEntry(db, { companyId, eventType: "approval.decided", subjectType: "approval", subjectId: randomUUID(), payload: { i } })));
    const rows = await db.select().from(auditLog).where(eq(auditLog.companyId, companyId)).orderBy(auditLog.seq);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(8);
    for (let i = 1; i < rows.length; i++) expect(rows[i]?.prevHash).toBe(rows[i - 1]?.thisHash);
  });

  it("detects payload tampering by recomputing the stored hash", async () => {
    const companyId = await company();
    const row = await appendAuditEntry(db, { companyId, eventType: "approval.decided", subjectType: "approval", subjectId: randomUUID(), payload: { status: "approved" } });
    const tampered = { ...row, payload: { status: "rejected" } };
    expect(await recomputeAuditHash(db, tampered)).not.toBe(row.thisHash);
  });
});
