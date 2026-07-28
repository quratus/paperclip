ALTER TABLE "pipeline_graph_wake_outbox"
  ADD COLUMN "claim_token" uuid,
  ADD COLUMN "claimed_by" text,
  ADD COLUMN "claim_expires_at" timestamp with time zone,
  ADD COLUMN "dispatch_receipt" jsonb;--> statement-breakpoint

ALTER TABLE "pipeline_graph_wake_outbox"
  ADD CONSTRAINT "pipeline_graph_wake_outbox_claim_lifecycle_check" CHECK (
    (
      "status" = 'claimed'
      and "claim_token" is not null
      and "claimed_by" is not null
      and "claimed_at" is not null
      and "claim_expires_at" is not null
      and "dispatched_at" is null
    )
    or (
      "status" <> 'claimed'
      and "claim_token" is null
      and "claimed_by" is null
      and "claim_expires_at" is null
    )
  );--> statement-breakpoint

CREATE INDEX "pipeline_graph_wake_outbox_claim_idx"
  ON "pipeline_graph_wake_outbox" USING btree ("status", "claim_expires_at", "available_at");
