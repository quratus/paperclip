DROP INDEX IF EXISTS "issues_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "issues"."origin_kind" = 'routine_execution'
    AND "issues"."origin_id" IS NOT NULL
    AND "issues"."hidden_at" IS NULL
    AND "issues"."execution_run_id" IS NOT NULL
    AND "issues"."status" IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked_pending_human', 'blocked');
