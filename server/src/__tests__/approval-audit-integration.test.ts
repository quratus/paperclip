import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, approvals, companies, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { appendAuditEntry, recomputeAuditHash } from "../services/audit-log.js";
import { approvalService } from "../services/approvals.js";

describe("approval decision audit integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-audit-"); db = createDb(tempDb.connectionString); }, 20_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  it("writes exactly one valid audit row for an applied approval decision", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "AuditCo", issuePrefix: `AU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const [approval] = await db.insert(approvals).values({ companyId, type: "request_board_approval", status: "pending", payload: { title: "Approve" } }).returning();
    if (!approval) throw new Error("approval insert failed");
    const previous = await appendAuditEntry(db, { companyId, eventType: "approval.created", subjectType: "approval", subjectId: approval.id, payload: { status: "pending" } });
    await approvalService(db).approve(approval.id, "board", "Approved");
    await approvalService(db).approve(approval.id, "board", "Approved");
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.subjectId, approval.id))).orderBy(auditLog.seq);
    const decisions = rows.filter((row) => row.eventType === "approval.decided");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.prevHash).toBe(previous.thisHash);
    expect(decisions[0]?.thisHash).toBe(decisions[0] ? await recomputeAuditHash(db, decisions[0]) : "");
  });
});
