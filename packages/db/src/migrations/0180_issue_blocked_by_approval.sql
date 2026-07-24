ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_by_approval_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_blocked_by_approval_id_approvals_id_fk"
 FOREIGN KEY ("blocked_by_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_blocked_by_approval_idx" ON "issues" USING btree ("company_id", "blocked_by_approval_id");
