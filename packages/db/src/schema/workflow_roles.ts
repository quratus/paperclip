import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const workflowRoles = pgTable(
  "workflow_roles",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.key], name: "workflow_roles_pkey" }),
    keyCheck: check("workflow_roles_key_check", sql`${table.key} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  }),
);

export const agentWorkflowRoleAssignments = pgTable(
  "agent_workflow_role_assignments",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    agentId: uuid("agent_id").notNull(),
    priority: integer("priority").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.companyId, table.roleKey, table.agentId],
      name: "agent_workflow_role_assignments_pkey",
    }),
    rolePriorityIdx: index("agent_workflow_role_assignments_role_priority_idx")
      .on(table.companyId, table.roleKey, table.priority, table.agentId),
    roleFk: foreignKey({
      columns: [table.companyId, table.roleKey],
      foreignColumns: [workflowRoles.companyId, workflowRoles.key],
      name: "agent_workflow_role_assignments_role_fk",
    }).onDelete("cascade"),
    agentFk: foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "agent_workflow_role_assignments_agent_fk",
    }).onDelete("cascade"),
    priorityCheck: check("agent_workflow_role_assignments_priority_check", sql`${table.priority} >= 0`),
  }),
);

export const workflowRoleSeparationConstraints = pgTable(
  "workflow_role_separation_constraints",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    firstRoleKey: text("first_role_key").notNull(),
    secondRoleKey: text("second_role_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.companyId, table.firstRoleKey, table.secondRoleKey],
      name: "workflow_role_separation_constraints_pkey",
    }),
    firstRoleFk: foreignKey({
      columns: [table.companyId, table.firstRoleKey],
      foreignColumns: [workflowRoles.companyId, workflowRoles.key],
      name: "workflow_role_separation_constraints_first_role_fk",
    }).onDelete("cascade"),
    secondRoleFk: foreignKey({
      columns: [table.companyId, table.secondRoleKey],
      foreignColumns: [workflowRoles.companyId, workflowRoles.key],
      name: "workflow_role_separation_constraints_second_role_fk",
    }).onDelete("cascade"),
    orderedCheck: check(
      "workflow_role_separation_constraints_ordered_check",
      sql`${table.firstRoleKey} < ${table.secondRoleKey}`,
    ),
  }),
);
