ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_by_external" jsonb;
