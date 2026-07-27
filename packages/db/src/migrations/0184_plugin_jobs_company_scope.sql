ALTER TABLE "plugin_jobs"
  ADD COLUMN "scope" text DEFAULT 'instance' NOT NULL;

ALTER TABLE "plugin_jobs"
  ADD CONSTRAINT "plugin_jobs_scope_check"
  CHECK ("scope" IN ('instance', 'company'));
