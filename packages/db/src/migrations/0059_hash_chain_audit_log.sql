CREATE TABLE "audit_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"event_type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"payload" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"this_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_log_company_seq_idx" ON "audit_log" ("company_id","seq");
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_hash(seq bigint, company_id uuid, event_type text, subject_type text, subject_id uuid, payload jsonb, prev_hash text, created_at timestamp with time zone)
RETURNS text LANGUAGE sql STABLE AS $$ SELECT encode(digest(jsonb_build_array(seq, company_id, event_type, subject_type, subject_id, payload, prev_hash, created_at)::text, 'sha256'), 'hex') $$;
--> statement-breakpoint
INSERT INTO "audit_log" ("seq","company_id","event_type","subject_type","subject_id","payload","prev_hash","this_hash","created_at")
VALUES (
  0,
  NULL,
  'genesis',
  'audit_log',
  NULL,
  '{}'::jsonb,
  repeat('0', 64),
  audit_log_hash(0, NULL, 'genesis', 'audit_log', NULL, '{}'::jsonb, repeat('0', 64), '1970-01-01 00:00:00+00'::timestamptz),
  '1970-01-01 00:00:00+00'::timestamptz
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permission denied: audit_log rows are immutable'; END; $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_log_no_delete BEFORE DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_log" FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip') THEN REVOKE UPDATE, DELETE ON "audit_log" FROM "paperclip"; END IF; END $$;
