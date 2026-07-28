CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_company_pipeline_id_uq"
  ON "pipeline_cases" USING btree ("company_id", "pipeline_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_company_id_uq"
  ON "pipeline_cases" USING btree ("company_id", "id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pipeline_graph_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "pipeline_id" uuid NOT NULL,
  "graph_version_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "start_idempotency_key" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "current_node_key" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "next_event_sequence" integer DEFAULT 2 NOT NULL,
  "checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "cycle_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_by_type" text NOT NULL,
  "started_by_id" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paused_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_graph_runs_status_check"
    CHECK ("status" in ('running', 'paused', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "pipeline_graph_runs_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "pipeline_graph_runs_event_sequence_check" CHECK ("next_event_sequence" > 1),
  CONSTRAINT "pipeline_graph_runs_started_by_type_check" CHECK ("started_by_type" in ('user', 'agent')),
  CONSTRAINT "pipeline_graph_runs_lifecycle_check" CHECK (
    ("status" = 'running' and "paused_at" is null and "finished_at" is null)
    or ("status" = 'paused' and "paused_at" is not null and "finished_at" is null)
    or ("status" in ('succeeded', 'failed', 'cancelled') and "finished_at" is not null)
  )
);--> statement-breakpoint

ALTER TABLE "pipeline_graph_runs"
  ADD CONSTRAINT "pipeline_graph_runs_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_graph_runs"
  ADD CONSTRAINT "pipeline_graph_runs_pipeline_fk"
  FOREIGN KEY ("company_id", "pipeline_id") REFERENCES "public"."pipelines"("company_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_graph_runs"
  ADD CONSTRAINT "pipeline_graph_runs_graph_version_fk"
  FOREIGN KEY ("company_id", "pipeline_id", "graph_version_id")
  REFERENCES "public"."pipeline_graph_versions"("company_id", "pipeline_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "pipeline_graph_runs"
  ADD CONSTRAINT "pipeline_graph_runs_case_fk"
  FOREIGN KEY ("company_id", "pipeline_id", "case_id")
  REFERENCES "public"."pipeline_cases"("company_id", "pipeline_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_runs_company_id_uq"
  ON "pipeline_graph_runs" USING btree ("company_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_runs_active_case_uq"
  ON "pipeline_graph_runs" USING btree ("case_id")
  WHERE "status" in ('running', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_runs_company_start_idempotency_uq"
  ON "pipeline_graph_runs" USING btree ("company_id", "start_idempotency_key");--> statement-breakpoint
CREATE INDEX "pipeline_graph_runs_company_pipeline_status_idx"
  ON "pipeline_graph_runs" USING btree ("company_id", "pipeline_id", "status");--> statement-breakpoint
CREATE INDEX "pipeline_graph_runs_case_idx"
  ON "pipeline_graph_runs" USING btree ("case_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pipeline_graph_run_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "node_key" text NOT NULL,
  "outcome" text,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "actor_run_id" uuid,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_graph_run_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "pipeline_graph_run_events_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pipeline_graph_run_events_actor_type_check"
    CHECK ("actor_type" in ('user', 'agent', 'system')),
  CONSTRAINT "pipeline_graph_run_events_actor_identity_check" CHECK (
    ("actor_type" = 'system' and "actor_id" is null and "actor_run_id" is null)
    or ("actor_type" = 'user' and "actor_id" is not null and "actor_run_id" is null)
    or ("actor_type" = 'agent' and "actor_id" is not null and "actor_run_id" is not null)
  ),
  CONSTRAINT "pipeline_graph_run_events_type_check" CHECK (
    "type" in (
      'run_started', 'checkpoint_saved', 'transition_committed', 'run_paused',
      'run_resumed', 'run_succeeded', 'run_failed', 'run_cancelled', 'wake_requested'
    )
  )
);--> statement-breakpoint
ALTER TABLE "pipeline_graph_run_events"
  ADD CONSTRAINT "pipeline_graph_run_events_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_graph_run_events"
  ADD CONSTRAINT "pipeline_graph_run_events_run_fk"
  FOREIGN KEY ("company_id", "run_id")
  REFERENCES "public"."pipeline_graph_runs"("company_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_run_events_run_sequence_uq"
  ON "pipeline_graph_run_events" USING btree ("run_id", "sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_run_events_run_idempotency_uq"
  ON "pipeline_graph_run_events" USING btree ("run_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_run_events_company_run_id_uq"
  ON "pipeline_graph_run_events" USING btree ("company_id", "run_id", "id");--> statement-breakpoint
CREATE INDEX "pipeline_graph_run_events_company_run_created_idx"
  ON "pipeline_graph_run_events" USING btree ("company_id", "run_id", "sequence");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pipeline_graph_wake_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "target_node_key" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_graph_wake_outbox_status_check"
    CHECK ("status" in ('pending', 'claimed', 'dispatched', 'failed', 'cancelled')),
  CONSTRAINT "pipeline_graph_wake_outbox_attempt_count_check" CHECK ("attempt_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "pipeline_graph_wake_outbox"
  ADD CONSTRAINT "pipeline_graph_wake_outbox_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_graph_wake_outbox"
  ADD CONSTRAINT "pipeline_graph_wake_outbox_run_fk"
  FOREIGN KEY ("company_id", "run_id")
  REFERENCES "public"."pipeline_graph_runs"("company_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_graph_wake_outbox"
  ADD CONSTRAINT "pipeline_graph_wake_outbox_event_fk"
  FOREIGN KEY ("company_id", "run_id", "event_id")
  REFERENCES "public"."pipeline_graph_run_events"("company_id", "run_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_graph_wake_outbox"
  ADD CONSTRAINT "pipeline_graph_wake_outbox_case_fk"
  FOREIGN KEY ("company_id", "case_id")
  REFERENCES "public"."pipeline_cases"("company_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_wake_outbox_company_idempotency_uq"
  ON "pipeline_graph_wake_outbox" USING btree ("company_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX "pipeline_graph_wake_outbox_pending_idx"
  ON "pipeline_graph_wake_outbox" USING btree ("status", "available_at", "created_at");--> statement-breakpoint
CREATE INDEX "pipeline_graph_wake_outbox_company_run_idx"
  ON "pipeline_graph_wake_outbox" USING btree ("company_id", "run_id");
