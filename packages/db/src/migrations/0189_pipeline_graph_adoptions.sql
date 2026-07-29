CREATE TABLE "pipeline_graph_adoptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "pipeline_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "expected_active_version_id" uuid,
  "expected_active_definition_hash" text,
  "result_version_id" uuid NOT NULL,
  "result_definition_hash" text NOT NULL,
  "changed" boolean NOT NULL,
  "restored" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_graph_adoptions_company_pipeline_fk"
    FOREIGN KEY ("company_id", "pipeline_id")
    REFERENCES "pipelines"("company_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "pipeline_graph_adoptions_result_version_fk"
    FOREIGN KEY ("company_id", "pipeline_id", "result_version_id")
    REFERENCES "pipeline_graph_versions"("company_id", "pipeline_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "pipeline_graph_adoptions_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pipeline_graph_adoptions_expected_hash_check"
    CHECK ("expected_active_definition_hash" IS NULL OR "expected_active_definition_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pipeline_graph_adoptions_result_hash_check"
    CHECK ("result_definition_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "pipeline_graph_adoptions_pipeline_idempotency_uq"
  ON "pipeline_graph_adoptions" ("pipeline_id", "idempotency_key");

CREATE INDEX "pipeline_graph_adoptions_company_pipeline_created_idx"
  ON "pipeline_graph_adoptions" ("company_id", "pipeline_id", "created_at");
