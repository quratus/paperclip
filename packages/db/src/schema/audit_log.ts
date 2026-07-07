import { pgTable, bigserial, text, timestamp, jsonb, index, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const auditLog = pgTable(
  "audit_log",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id").references(() => companies.id),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    prevHash: text("prev_hash").notNull(),
    thisHash: text("this_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySeqIdx: index("audit_log_company_seq_idx").on(table.companyId, table.seq),
  }),
);
