import { sql } from "drizzle-orm";
import type { PipelineGraphDefinitionV1 } from "@paperclipai/shared";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const pipelines = pgTable(
  "pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    enforceTransitions: boolean("enforce_transitions").notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("pipelines_company_key_uq").on(table.companyId, table.key),
    companyIdUq: uniqueIndex("pipelines_company_id_uq").on(table.companyId, table.id),
    companyIdx: index("pipelines_company_idx").on(table.companyId),
    companyProjectIdx: index("pipelines_company_project_idx").on(table.companyId, table.projectId),
  }),
);

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    position: integer("position").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pipelineKeyUq: uniqueIndex("pipeline_stages_pipeline_key_uq").on(table.pipelineId, table.key),
    pipelinePositionIdx: index("pipeline_stages_pipeline_position_idx").on(table.pipelineId, table.position),
    kindCheck: check("pipeline_stages_kind_check", sql`${table.kind} in ('working', 'review', 'done', 'cancelled')`),
  }),
);

export const pipelineTransitions = pgTable(
  "pipeline_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    fromStageId: uuid("from_stage_id").notNull().references(() => pipelineStages.id, { onDelete: "cascade" }),
    toStageId: uuid("to_stage_id").notNull().references(() => pipelineStages.id, { onDelete: "cascade" }),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pipelineEdgeUq: uniqueIndex("pipeline_transitions_pipeline_edge_uq").on(
      table.pipelineId,
      table.fromStageId,
      table.toStageId,
    ),
    pipelineFromIdx: index("pipeline_transitions_pipeline_from_idx").on(table.pipelineId, table.fromStageId),
    pipelineToIdx: index("pipeline_transitions_pipeline_to_idx").on(table.pipelineId, table.toStageId),
  }),
);

export const pipelineGraphVersions = pgTable(
  "pipeline_graph_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definitionHash: text("definition_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    definition: jsonb("definition").$type<PipelineGraphDefinitionV1>().notNull(),
    status: text("status").notNull().default("draft"),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pipelineVersionUq: uniqueIndex("pipeline_graph_versions_pipeline_version_uq")
      .on(table.pipelineId, table.version),
    pipelineHashUq: uniqueIndex("pipeline_graph_versions_pipeline_hash_uq")
      .on(table.pipelineId, table.definitionHash),
    companyPipelineVersionIdx: index("pipeline_graph_versions_company_pipeline_version_idx")
      .on(table.companyId, table.pipelineId, table.version),
    companyPipelineFk: foreignKey({
      columns: [table.companyId, table.pipelineId],
      foreignColumns: [pipelines.companyId, pipelines.id],
      name: "pipeline_graph_versions_company_pipeline_fk",
    }).onDelete("cascade"),
    versionPositiveCheck: check("pipeline_graph_versions_version_positive_check", sql`${table.version} > 0`),
    schemaVersionPositiveCheck: check(
      "pipeline_graph_versions_schema_version_positive_check",
      sql`${table.schemaVersion} > 0`,
    ),
    definitionHashCheck: check(
      "pipeline_graph_versions_definition_hash_check",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusCheck: check(
      "pipeline_graph_versions_status_check",
      sql`${table.status} in ('draft', 'retired')`,
    ),
    createdByTypeCheck: check(
      "pipeline_graph_versions_created_by_type_check",
      sql`${table.createdByType} in ('user', 'agent')`,
    ),
  }),
);
