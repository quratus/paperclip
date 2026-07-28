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
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdempotencyUq: uniqueIndex("pipeline_graph_wake_outbox_company_idempotency_uq")
      .on(table.companyId, table.idempotencyKey),
    pendingIdx: index("pipeline_graph_wake_outbox_pending_idx")
      .on(table.status, table.availableAt, table.createdAt),
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
  }),
);
