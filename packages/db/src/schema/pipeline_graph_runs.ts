import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";
import { pipelineGraphVersions, pipelines } from "./pipelines.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const pipelineGraphRuns = pgTable(
  "pipeline_graph_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id").notNull(),
    graphVersionId: uuid("graph_version_id").notNull(),
    caseId: uuid("case_id").notNull(),
    startIdempotencyKey: text("start_idempotency_key").notNull(),
    status: text("status").notNull().default("running"),
    currentNodeKey: text("current_node_key").notNull(),
    revision: integer("revision").notNull().default(1),
    nextEventSequence: integer("next_event_sequence").notNull().default(2),
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>().notNull().default({}),
    cycleState: jsonb("cycle_state").$type<Record<string, unknown>>().notNull().default({}),
    startedByType: text("started_by_type").notNull(),
    startedById: text("started_by_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUq: uniqueIndex("pipeline_graph_runs_company_id_uq").on(table.companyId, table.id),
    activeCaseUq: uniqueIndex("pipeline_graph_runs_active_case_uq")
      .on(table.caseId)
      .where(sql`${table.status} in ('running', 'paused')`),
    companyStartIdempotencyUq: uniqueIndex("pipeline_graph_runs_company_start_idempotency_uq")
      .on(table.companyId, table.startIdempotencyKey),
    companyPipelineStatusIdx: index("pipeline_graph_runs_company_pipeline_status_idx")
      .on(table.companyId, table.pipelineId, table.status),
    caseIdx: index("pipeline_graph_runs_case_idx").on(table.caseId, table.createdAt),
    graphVersionFk: foreignKey({
      columns: [table.companyId, table.pipelineId, table.graphVersionId],
      foreignColumns: [
        pipelineGraphVersions.companyId,
        pipelineGraphVersions.pipelineId,
        pipelineGraphVersions.id,
      ],
      name: "pipeline_graph_runs_graph_version_fk",
    }).onDelete("restrict"),
    caseFk: foreignKey({
      columns: [table.companyId, table.pipelineId, table.caseId],
      foreignColumns: [pipelineCases.companyId, pipelineCases.pipelineId, pipelineCases.id],
      name: "pipeline_graph_runs_case_fk",
    }).onDelete("cascade"),
    pipelineFk: foreignKey({
      columns: [table.companyId, table.pipelineId],
      foreignColumns: [pipelines.companyId, pipelines.id],
      name: "pipeline_graph_runs_pipeline_fk",
    }).onDelete("cascade"),
    statusCheck: check(
      "pipeline_graph_runs_status_check",
      sql`${table.status} in ('running', 'paused', 'succeeded', 'failed', 'cancelled')`,
    ),
    revisionCheck: check("pipeline_graph_runs_revision_check", sql`${table.revision} > 0`),
    eventSequenceCheck: check(
      "pipeline_graph_runs_event_sequence_check",
      sql`${table.nextEventSequence} > 1`,
    ),
    actorTypeCheck: check(
      "pipeline_graph_runs_started_by_type_check",
      sql`${table.startedByType} in ('user', 'agent')`,
    ),
    lifecycleCheck: check(
      "pipeline_graph_runs_lifecycle_check",
      sql`(
        (${table.status} = 'running' and ${table.pausedAt} is null and ${table.finishedAt} is null)
        or (${table.status} = 'paused' and ${table.pausedAt} is not null and ${table.finishedAt} is null)
        or (${table.status} in ('succeeded', 'failed', 'cancelled') and ${table.finishedAt} is not null)
      )`,
    ),
  }),
);

export const pipelineGraphRunEvents = pgTable(
  "pipeline_graph_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    nodeKey: text("node_key").notNull(),
    outcome: text("outcome"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    actorRunId: uuid("actor_run_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSequenceUq: uniqueIndex("pipeline_graph_run_events_run_sequence_uq")
      .on(table.runId, table.sequence),
    runIdempotencyUq: uniqueIndex("pipeline_graph_run_events_run_idempotency_uq")
      .on(table.runId, table.idempotencyKey),
    companyRunIdUq: uniqueIndex("pipeline_graph_run_events_company_run_id_uq")
      .on(table.companyId, table.runId, table.id),
    companyRunCreatedIdx: index("pipeline_graph_run_events_company_run_created_idx")
      .on(table.companyId, table.runId, table.sequence),
    runFk: foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [pipelineGraphRuns.companyId, pipelineGraphRuns.id],
      name: "pipeline_graph_run_events_run_fk",
    }).onDelete("cascade"),
    sequenceCheck: check("pipeline_graph_run_events_sequence_check", sql`${table.sequence} > 0`),
    requestHashCheck: check(
      "pipeline_graph_run_events_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    typeCheck: check(
      "pipeline_graph_run_events_type_check",
      sql`${table.type} in (
        'run_started',
        'checkpoint_saved',
        'transition_committed',
        'run_paused',
        'run_resumed',
        'run_succeeded',
        'run_failed',
        'run_cancelled',
        'wake_requested'
      )`,
    ),
    actorTypeCheck: check(
      "pipeline_graph_run_events_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'system')`,
    ),
    actorIdentityCheck: check(
      "pipeline_graph_run_events_actor_identity_check",
      sql`(
        (${table.actorType} = 'system' and ${table.actorId} is null and ${table.actorRunId} is null)
        or (${table.actorType} = 'user' and ${table.actorId} is not null and ${table.actorRunId} is null)
        or (${table.actorType} = 'agent' and ${table.actorId} is not null and ${table.actorRunId} is not null)
      )`,
    ),
  }),
);

export const pipelineGraphWakeOutbox = pgTable(
  "pipeline_graph_wake_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    eventId: uuid("event_id").notNull(),
    caseId: uuid("case_id").notNull(),
    targetNodeKey: text("target_node_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    claimedBy: text("claimed_by"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchReceipt: jsonb("dispatch_receipt").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdempotencyUq: uniqueIndex("pipeline_graph_wake_outbox_company_idempotency_uq")
      .on(table.companyId, table.idempotencyKey),
    pendingIdx: index("pipeline_graph_wake_outbox_pending_idx")
      .on(table.status, table.availableAt, table.createdAt),
    claimIdx: index("pipeline_graph_wake_outbox_claim_idx")
      .on(table.status, table.claimExpiresAt, table.availableAt),
    companyRunIdx: index("pipeline_graph_wake_outbox_company_run_idx")
      .on(table.companyId, table.runId),
    runFk: foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [pipelineGraphRuns.companyId, pipelineGraphRuns.id],
      name: "pipeline_graph_wake_outbox_run_fk",
    }).onDelete("cascade"),
    eventFk: foreignKey({
      columns: [table.companyId, table.runId, table.eventId],
      foreignColumns: [
        pipelineGraphRunEvents.companyId,
        pipelineGraphRunEvents.runId,
        pipelineGraphRunEvents.id,
      ],
      name: "pipeline_graph_wake_outbox_event_fk",
    }).onDelete("cascade"),
    caseFk: foreignKey({
      columns: [table.companyId, table.caseId],
      foreignColumns: [pipelineCases.companyId, pipelineCases.id],
      name: "pipeline_graph_wake_outbox_case_fk",
    }).onDelete("cascade"),
    statusCheck: check(
      "pipeline_graph_wake_outbox_status_check",
      sql`${table.status} in ('pending', 'claimed', 'dispatched', 'failed', 'cancelled')`,
    ),
    attemptCountCheck: check(
      "pipeline_graph_wake_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    claimLifecycleCheck: check(
      "pipeline_graph_wake_outbox_claim_lifecycle_check",
      sql`(
        (
          ${table.status} = 'claimed'
          and ${table.claimToken} is not null
          and ${table.claimedBy} is not null
          and ${table.claimedAt} is not null
          and ${table.claimExpiresAt} is not null
          and ${table.dispatchedAt} is null
        )
        or (
          ${table.status} <> 'claimed'
          and ${table.claimToken} is null
          and ${table.claimedBy} is null
          and ${table.claimExpiresAt} is null
        )
      )`,
    ),
  }),
);

export const pipelineGraphEffectAttempts = pgTable(
  "pipeline_graph_effect_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    nodeKey: text("node_key").notNull(),
    runRevision: integer("run_revision").notNull(),
    effectType: text("effect_type").notNull(),
    authorityClass: text("authority_class").notNull(),
    targetRef: jsonb("target_ref").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    subjectHash: text("subject_hash").notNull(),
    authorityReceipt: jsonb("authority_receipt").$type<Record<string, unknown>>().notNull(),
    executorAttestation: jsonb("executor_attestation").$type<{
      keyId: string;
      controllerBuildId: string;
      subjectHash: string;
      action: "request";
      actionHash: string;
      signature: string;
    }>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    retryPolicy: jsonb("retry_policy").$type<{ maxAttempts: number }>().notNull().default({ maxAttempts: 1 }),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    requestedByRunId: uuid("requested_by_run_id"),
    executorType: text("executor_type"),
    executorId: text("executor_id"),
    leaseToken: uuid("lease_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    reconciliationEvidence: jsonb("reconciliation_evidence").$type<Record<string, unknown>>(),
    providerReceipt: jsonb("provider_receipt").$type<Record<string, unknown>>(),
    failureEvidence: jsonb("failure_evidence").$type<Record<string, unknown>>(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdempotencyUq: uniqueIndex("pipeline_graph_effect_attempts_company_idempotency_uq")
      .on(table.companyId, table.idempotencyKey),
    companySubjectUq: uniqueIndex("pipeline_graph_effect_attempts_company_subject_uq")
      .on(table.companyId, table.subjectHash),
    companyIdUq: uniqueIndex("pipeline_graph_effect_attempts_company_id_uq")
      .on(table.companyId, table.id),
    pendingIdx: index("pipeline_graph_effect_attempts_pending_idx")
      .on(table.status, table.createdAt),
    runIdx: index("pipeline_graph_effect_attempts_run_idx")
      .on(table.companyId, table.runId, table.createdAt),
    runFk: foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [pipelineGraphRuns.companyId, pipelineGraphRuns.id],
      name: "pipeline_graph_effect_attempts_run_fk",
    }).onDelete("cascade"),
    runRevisionCheck: check("pipeline_graph_effect_attempts_run_revision_check", sql`${table.runRevision} > 0`),
    attemptCountCheck: check("pipeline_graph_effect_attempts_attempt_count_check", sql`${table.attemptCount} >= 0`),
    payloadHashCheck: check("pipeline_graph_effect_attempts_payload_hash_check", sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    subjectHashCheck: check("pipeline_graph_effect_attempts_subject_hash_check", sql`${table.subjectHash} ~ '^[0-9a-f]{64}$'`),
    requestHashCheck: check("pipeline_graph_effect_attempts_request_hash_check", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    statusCheck: check(
      "pipeline_graph_effect_attempts_status_check",
      sql`${table.status} in ('pending', 'executing', 'succeeded', 'failed', 'cancelled')`,
    ),
    requesterTypeCheck: check(
      "pipeline_graph_effect_attempts_requested_by_type_check",
      sql`${table.requestedByType} in ('user', 'agent')`,
    ),
    requesterIdentityCheck: check(
      "pipeline_graph_effect_attempts_requested_by_identity_check",
      sql`(
        (${table.requestedByType} = 'user' and ${table.requestedByRunId} is null)
        or (${table.requestedByType} = 'agent' and ${table.requestedByRunId} is not null)
      )`,
    ),
    executorTypeCheck: check(
      "pipeline_graph_effect_attempts_executor_type_check",
      sql`${table.executorType} is null or ${table.executorType} in ('user', 'agent', 'system')`,
    ),
    lifecycleCheck: check(
      "pipeline_graph_effect_attempts_lifecycle_check",
      sql`(
        (
          ${table.status} = 'pending'
          and ${table.executorType} is null and ${table.executorId} is null
          and ${table.leaseToken} is null and ${table.claimedAt} is null
          and ${table.claimExpiresAt} is null and ${table.finishedAt} is null
        )
        or (
          ${table.status} = 'executing'
          and ${table.executorType} is not null and ${table.executorId} is not null
          and ${table.leaseToken} is not null and ${table.claimedAt} is not null
          and ${table.claimExpiresAt} is not null and ${table.finishedAt} is null
        )
        or (
          ${table.status} in ('succeeded', 'failed')
          and ${table.executorType} is not null and ${table.executorId} is not null
          and ${table.leaseToken} is null and ${table.claimedAt} is not null
          and ${table.claimExpiresAt} is null and ${table.finishedAt} is not null
        )
        or (
          ${table.status} = 'cancelled' and ${table.leaseToken} is null
          and ${table.claimExpiresAt} is null and ${table.finishedAt} is not null
        )
      )`,
    ),
    resultCheck: check(
      "pipeline_graph_effect_attempts_result_check",
      sql`(
        (${table.status} = 'succeeded' and ${table.providerReceipt} is not null and ${table.failureEvidence} is null)
        or (${table.status} = 'failed' and ${table.providerReceipt} is null and ${table.failureEvidence} is not null)
        or (${table.status} not in ('succeeded', 'failed') and ${table.providerReceipt} is null and ${table.failureEvidence} is null)
      )`,
    ),
  }),
);
