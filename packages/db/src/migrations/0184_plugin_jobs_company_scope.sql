ALTER TABLE "plugin_jobs"
  ADD COLUMN "scope" text DEFAULT 'instance' NOT NULL,
  ADD COLUMN "company_cursor" text;

ALTER TABLE "plugin_jobs"
  ADD CONSTRAINT "plugin_jobs_scope_check"
  CHECK ("scope" IN ('instance', 'company'));
