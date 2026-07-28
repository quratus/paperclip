CREATE UNIQUE INDEX "pipelines_company_id_uq" ON "pipelines" ("company_id", "id");

CREATE TABLE "pipeline_graph_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "pipeline_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "definition_hash" text NOT NULL,
  "schema_version" integer NOT NULL,
  "definition" jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_graph_versions_version_positive_check" CHECK ("version" > 0),
  CONSTRAINT "pipeline_graph_versions_schema_version_positive_check" CHECK ("schema_version" > 0),
  CONSTRAINT "pipeline_graph_versions_definition_hash_check" CHECK ("definition_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pipeline_graph_versions_status_check" CHECK ("status" IN ('draft', 'retired')),
  CONSTRAINT "pipeline_graph_versions_creator_check" CHECK (num_nonnulls("created_by_user_id", "created_by_agent_id") = 1),
  CONSTRAINT "pipeline_graph_versions_company_pipeline_fk"
    FOREIGN KEY ("company_id", "pipeline_id")
    REFERENCES "pipelines"("company_id", "id")
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX "pipeline_graph_versions_pipeline_version_uq"
  ON "pipeline_graph_versions" ("pipeline_id", "version");
CREATE UNIQUE INDEX "pipeline_graph_versions_pipeline_hash_uq"
  ON "pipeline_graph_versions" ("pipeline_id", "definition_hash");
CREATE INDEX "pipeline_graph_versions_company_pipeline_version_idx"
  ON "pipeline_graph_versions" ("company_id", "pipeline_id", "version");
