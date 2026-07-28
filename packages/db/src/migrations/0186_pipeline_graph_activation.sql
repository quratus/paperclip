ALTER TABLE "pipeline_graph_versions"
  DROP CONSTRAINT "pipeline_graph_versions_status_check";

ALTER TABLE "pipeline_graph_versions"
  ADD COLUMN "activated_by_type" text,
  ADD COLUMN "activated_by_id" text,
  ADD COLUMN "activated_at" timestamp with time zone,
  ADD COLUMN "retired_at" timestamp with time zone,
  ADD CONSTRAINT "pipeline_graph_versions_status_check"
    CHECK ("status" IN ('draft', 'active', 'retired')),
  ADD CONSTRAINT "pipeline_graph_versions_activated_by_type_check"
    CHECK ("activated_by_type" IS NULL OR "activated_by_type" IN ('user', 'agent')),
  ADD CONSTRAINT "pipeline_graph_versions_activation_actor_check"
    CHECK (("activated_by_type" IS NULL) = ("activated_by_id" IS NULL)),
  ADD CONSTRAINT "pipeline_graph_versions_lifecycle_check"
    CHECK (
      ("status" = 'draft' AND "activated_at" IS NULL AND "retired_at" IS NULL)
      OR ("status" = 'active' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL)
      OR ("status" = 'retired' AND "activated_at" IS NOT NULL AND "retired_at" IS NOT NULL)
    );

CREATE UNIQUE INDEX "pipeline_graph_versions_pipeline_id_uq"
  ON "pipeline_graph_versions" ("pipeline_id", "id");

CREATE UNIQUE INDEX "pipeline_graph_versions_pipeline_active_uq"
  ON "pipeline_graph_versions" ("pipeline_id")
  WHERE "status" = 'active';

ALTER TABLE "pipeline_cases"
  ADD COLUMN "graph_version_id" uuid;

ALTER TABLE "pipeline_cases"
  ADD CONSTRAINT "pipeline_cases_pipeline_graph_version_fk"
  FOREIGN KEY ("pipeline_id", "graph_version_id")
  REFERENCES "pipeline_graph_versions" ("pipeline_id", "id")
  ON DELETE RESTRICT;

CREATE INDEX "pipeline_cases_graph_version_idx"
  ON "pipeline_cases" ("graph_version_id");
