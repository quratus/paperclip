import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditLog } from "@paperclipai/db";

const GENESIS_HASH = "0".repeat(64);

export interface AuditEntryInput {
  companyId: string; eventType: string; subjectType: string; subjectId: string;
  payload?: Record<string, unknown> | null;
}
export type AuditEntry = typeof auditLog.$inferSelect;

export async function appendAuditEntry(db: Db, input: AuditEntryInput): Promise<AuditEntry> {
  validateInput(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.companyId}, 0))`);
    const [lastRow] = await tx
      .select({ seq: auditLog.seq, thisHash: auditLog.thisHash })
      .from(auditLog)
      .where(eq(auditLog.companyId, input.companyId))
      .orderBy(desc(auditLog.seq))
      .limit(1);

    const prevHash = lastRow?.thisHash ?? GENESIS_HASH;
    const seqResult = await tx.execute(sql`SELECT nextval('audit_log_seq_seq') AS next_seq`);
    const rawSeq = (seqResult as unknown as Array<{ next_seq: unknown }>)[0]?.next_seq;
    const nextSeq = Number.parseInt(String(rawSeq ?? "1"), 10);
    const createdAt = new Date().toISOString();
    const payload = JSON.stringify(input.payload ?? {});
    const inserted = await tx.execute(sql`
      INSERT INTO "audit_log" (seq, event_type, company_id, subject_type, subject_id, payload, prev_hash, this_hash, created_at)
      VALUES (${nextSeq}, ${input.eventType}, ${input.companyId}, ${input.subjectType}, ${input.subjectId}, ${payload}::jsonb, ${prevHash},
        audit_log_hash(${nextSeq}, ${input.companyId}::uuid, ${input.eventType}, ${input.subjectType}, ${input.subjectId}::uuid, ${payload}::jsonb, ${prevHash}, ${createdAt}), ${createdAt})
      RETURNING seq, event_type AS "eventType", company_id AS "companyId", subject_type AS "subjectType",
        subject_id AS "subjectId", payload, prev_hash AS "prevHash", this_hash AS "thisHash", created_at AS "createdAt"
    `);
    const row = (inserted as unknown as AuditEntry[])[0];
    if (!row) throw new Error("audit_log insert returned no row");
    return row;
  });
}

export async function recomputeAuditHash(db: Db, row: Omit<AuditEntry, "thisHash">): Promise<string> {
  const payload = JSON.stringify(row.payload ?? {});
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
  const result = await db.execute(sql`
    SELECT audit_log_hash(${row.seq}, ${row.companyId}::uuid, ${row.eventType}, ${row.subjectType}, ${row.subjectId}::uuid, ${payload}::jsonb, ${row.prevHash}, ${createdAt}) AS hash
  `);
  return String((result as unknown as Array<{ hash: unknown }>)[0]?.hash ?? "");
}

function validateInput(input: AuditEntryInput): void {
  for (const value of [input.companyId, input.eventType, input.subjectType, input.subjectId]) {
    if (value.trim().length === 0) throw new Error("audit log fields are required");
  }
  JSON.stringify(input.payload ?? {});
}
