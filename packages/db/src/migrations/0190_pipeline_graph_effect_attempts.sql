CREATE TABLE IF NOT EXISTS "pipeline_graph_effect_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "node_key" text NOT NULL,
  "run_revision" integer NOT NULL,
  "effect_type" text NOT NULL,
  "authority_class" text NOT NULL,
  "target_ref" jsonb NOT NULL,
  "payload_hash" text NOT NULL,
  "subject_hash" text NOT NULL,
  "authority_receipt" jsonb NOT NULL,
  "executor_attestation" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "retry_policy" jsonb DEFAULT '{"maxAttempts":1}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "requested_by_type" text NOT NULL,
  "requested_by_id" text NOT NULL,
  "requested_by_run_id" uuid,
  "executor_type" text,
  "executor_id" text,
  "lease_token" uuid,
  "claimed_at" timestamp with time zone,
  "claim_expires_at" timestamp with time zone,
  "reconciliation_evidence" jsonb,
  "provider_receipt" jsonb,
  "failure_evidence" jsonb,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_graph_effect_attempts_run_revision_check" CHECK ("run_revision" > 0),
  CONSTRAINT "pipeline_graph_effect_attempts_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "pipeline_graph_effect_attempts_payload_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pipeline_graph_effect_attempts_subject_hash_check" CHECK ("subject_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pipeline_graph_effect_attempts_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pipeline_graph_effect_attempts_status_check"
    CHECK ("status" in ('pending', 'executing', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "pipeline_graph_effect_attempts_requested_by_type_check"
    CHECK ("requested_by_type" in ('user', 'agent')),
  CONSTRAINT "pipeline_graph_effect_attempts_requested_by_identity_check" CHECK (
    ("requested_by_type" = 'user' and "requested_by_run_id" is null)
    or ("requested_by_type" = 'agent' and "requested_by_run_id" is not null)
  ),
  CONSTRAINT "pipeline_graph_effect_attempts_executor_type_check"
    CHECK ("executor_type" is null or "executor_type" in ('user', 'agent', 'system')),
  CONSTRAINT "pipeline_graph_effect_attempts_lifecycle_check" CHECK (
    (
      "status" = 'pending'
      and "executor_type" is null and "executor_id" is null and "lease_token" is null
      and "claimed_at" is null and "claim_expires_at" is null and "finished_at" is null
    )
    or (
      "status" = 'executing'
      and "executor_type" is not null and "executor_id" is not null and "lease_token" is not null
      and "claimed_at" is not null and "claim_expires_at" is not null and "finished_at" is null
    )
    or (
      "status" in ('succeeded', 'failed')
      and "executor_type" is not null and "executor_id" is not null and "lease_token" is null
      and "claimed_at" is not null and "claim_expires_at" is null and "finished_at" is not null
    )
    or (
      "status" = 'cancelled' and "lease_token" is null
      and "claim_expires_at" is null and "finished_at" is not null
    )
  ),
  CONSTRAINT "pipeline_graph_effect_attempts_result_check" CHECK (
    ("status" = 'succeeded' and "provider_receipt" is not null and "failure_evidence" is null)
    or ("status" = 'failed' and "provider_receipt" is null and "failure_evidence" is not null)
    or ("status" not in ('succeeded', 'failed') and "provider_receipt" is null and "failure_evidence" is null)
  )
);--> statement-breakpoint
ALTER TABLE "pipeline_graph_effect_attempts"
  ADD CONSTRAINT "pipeline_graph_effect_attempts_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_graph_effect_attempts"
  ADD CONSTRAINT "pipeline_graph_effect_attempts_run_fk"
  FOREIGN KEY ("company_id", "run_id")
  REFERENCES "public"."pipeline_graph_runs"("company_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_effect_attempts_company_idempotency_uq"
  ON "pipeline_graph_effect_attempts" USING btree ("company_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_effect_attempts_company_subject_uq"
  ON "pipeline_graph_effect_attempts" USING btree ("company_id", "subject_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_effect_attempts_company_id_uq"
  ON "pipeline_graph_effect_attempts" USING btree ("company_id", "id");--> statement-breakpoint
CREATE INDEX "pipeline_graph_effect_attempts_pending_idx"
  ON "pipeline_graph_effect_attempts" USING btree ("status", "created_at");--> statement-breakpoint
CREATE INDEX "pipeline_graph_effect_attempts_run_idx"
  ON "pipeline_graph_effect_attempts" USING btree ("company_id", "run_id", "created_at");
