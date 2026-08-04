import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWorkflowRoleAssignments,
  pipelineGraphRoleBindings,
  workflowRoles,
  workflowRoleSeparationConstraints,
} from "@paperclipai/db";
import { unprocessable } from "../errors.js";

export function workflowRoleService(db: Db) {
  return {
    async list(companyId: string) {
      const [roles, assignments, constraints] = await Promise.all([
        db.select().from(workflowRoles).where(eq(workflowRoles.companyId, companyId))
          .orderBy(asc(workflowRoles.key)),
        db.select({
          roleKey: agentWorkflowRoleAssignments.roleKey,
          agentId: agentWorkflowRoleAssignments.agentId,
          priority: agentWorkflowRoleAssignments.priority,
          agentName: agents.name,
          agentStatus: agents.status,
        }).from(agentWorkflowRoleAssignments).innerJoin(
          agents,
          and(
            eq(agents.companyId, agentWorkflowRoleAssignments.companyId),
            eq(agents.id, agentWorkflowRoleAssignments.agentId),
          ),
        ).where(eq(agentWorkflowRoleAssignments.companyId, companyId)).orderBy(
          asc(agentWorkflowRoleAssignments.roleKey),
          asc(agentWorkflowRoleAssignments.priority),
          asc(agentWorkflowRoleAssignments.agentId),
        ),
        db.select().from(workflowRoleSeparationConstraints)
          .where(eq(workflowRoleSeparationConstraints.companyId, companyId))
          .orderBy(
            asc(workflowRoleSeparationConstraints.firstRoleKey),
            asc(workflowRoleSeparationConstraints.secondRoleKey),
          ),
      ]);
      return {
        roles: roles.map((role) => ({
          ...role,
          assignments: assignments.filter((assignment) => assignment.roleKey === role.key),
        })),
        separationConstraints: constraints,
      };
    },

    async replaceAssignments(input: {
      companyId: string;
      roleKey: string;
      assignments: Array<{ agentId: string; priority: number }>;
    }) {
      return db.transaction(async (tx) => {
        const role = await tx.select({ key: workflowRoles.key }).from(workflowRoles).where(and(
          eq(workflowRoles.companyId, input.companyId),
          eq(workflowRoles.key, input.roleKey),
        )).then((rows) => rows[0] ?? null);
        if (!role) {
          throw unprocessable(`Workflow role '${input.roleKey}' is not configured for this company`, {
            code: "workflow_role_not_configured",
          });
        }
        const uniqueAgentIds = [...new Set(input.assignments.map((assignment) => assignment.agentId))];
        if (uniqueAgentIds.length !== input.assignments.length) {
          throw unprocessable("Workflow role assignments contain duplicate agents", {
            code: "workflow_role_assignment_duplicate",
          });
        }
        const companyAgentIds = uniqueAgentIds.length === 0 ? [] : await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(
            eq(agents.companyId, input.companyId),
            inArray(agents.id, uniqueAgentIds),
          )).then((rows) => rows.map((row) => row.id));
        if (companyAgentIds.length !== uniqueAgentIds.length) {
          throw unprocessable("Every workflow role assignment must reference an agent in the same company", {
            code: "workflow_role_assignment_company_mismatch",
          });
        }
        await tx.delete(agentWorkflowRoleAssignments).where(and(
          eq(agentWorkflowRoleAssignments.companyId, input.companyId),
          eq(agentWorkflowRoleAssignments.roleKey, input.roleKey),
        ));
        if (input.assignments.length > 0) {
          await tx.insert(agentWorkflowRoleAssignments).values(input.assignments.map((assignment) => ({
            companyId: input.companyId,
            roleKey: input.roleKey,
            ...assignment,
          })));
        }
        return input.assignments;
      });
    },

    async configureCatalog(input: {
      companyId: string;
      roles: Array<{ key: string; label: string }>;
      separationConstraints: Array<{ firstRoleKey: string; secondRoleKey: string }>;
    }) {
      const roleKeys = input.roles.map((role) => role.key);
      if (new Set(roleKeys).size !== roleKeys.length) {
        throw unprocessable("Workflow role catalog contains duplicate role keys", {
          code: "workflow_role_catalog_duplicate",
        });
      }
      const configuredRoleKeys = new Set(roleKeys);
      const constraintKeys = input.separationConstraints.map((constraint) =>
        `${constraint.firstRoleKey}:${constraint.secondRoleKey}`,
      );
      if (new Set(constraintKeys).size !== constraintKeys.length) {
        throw unprocessable("Workflow role catalog contains duplicate separation constraints", {
          code: "workflow_role_constraint_duplicate",
        });
      }
      for (const constraint of input.separationConstraints) {
        if (
          constraint.firstRoleKey >= constraint.secondRoleKey
          || !configuredRoleKeys.has(constraint.firstRoleKey)
          || !configuredRoleKeys.has(constraint.secondRoleKey)
        ) {
          throw unprocessable("Workflow role separation constraints must be ordered and reference configured roles", {
            code: "workflow_role_constraint_invalid",
            constraint,
          });
        }
      }

      await db.transaction(async (tx) => {
        if (input.roles.length > 0) {
          for (const role of input.roles) {
            await tx.insert(workflowRoles).values({
              companyId: input.companyId,
              ...role,
            }).onConflictDoUpdate({
              target: [workflowRoles.companyId, workflowRoles.key],
              set: { label: role.label, updatedAt: new Date() },
            });
          }
        }
        await tx.delete(workflowRoleSeparationConstraints).where(
          eq(workflowRoleSeparationConstraints.companyId, input.companyId),
        );
        if (input.separationConstraints.length > 0) {
          await tx.insert(workflowRoleSeparationConstraints).values(
            input.separationConstraints.map((constraint) => ({
              companyId: input.companyId,
              ...constraint,
            })),
          );
        }
      });
      return this.list(input.companyId);
    },

    async resolveAndBind(input: {
      companyId: string;
      runId: string;
      runRevision: number;
      nodeKey: string;
      roleKey: string;
    }) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.runId}))`);

        const existing = await tx.select().from(pipelineGraphRoleBindings).where(and(
          eq(pipelineGraphRoleBindings.companyId, input.companyId),
          eq(pipelineGraphRoleBindings.runId, input.runId),
          eq(pipelineGraphRoleBindings.runRevision, input.runRevision),
          eq(pipelineGraphRoleBindings.nodeKey, input.nodeKey),
        )).then((rows) => rows[0] ?? null);
        if (existing) {
          if (existing.roleKey !== input.roleKey) {
            throw unprocessable("Graph node role changed after its assignment was bound", {
              code: "graph_role_binding_conflict",
              boundRoleKey: existing.roleKey,
              requestedRoleKey: input.roleKey,
            });
          }
          return existing;
        }

        const role = await tx.select({ key: workflowRoles.key }).from(workflowRoles).where(and(
          eq(workflowRoles.companyId, input.companyId),
          eq(workflowRoles.key, input.roleKey),
        )).then((rows) => rows[0] ?? null);
        if (!role) {
          throw unprocessable(`Workflow role '${input.roleKey}' is not configured for this company`, {
            code: "workflow_role_not_configured",
            roleKey: input.roleKey,
          });
        }

        const separatedRoles = await tx.select({
          firstRoleKey: workflowRoleSeparationConstraints.firstRoleKey,
          secondRoleKey: workflowRoleSeparationConstraints.secondRoleKey,
        }).from(workflowRoleSeparationConstraints).where(and(
          eq(workflowRoleSeparationConstraints.companyId, input.companyId),
          or(
            eq(workflowRoleSeparationConstraints.firstRoleKey, input.roleKey),
            eq(workflowRoleSeparationConstraints.secondRoleKey, input.roleKey),
          ),
        ));
        const incompatibleRoleKeys = separatedRoles.map((constraint) =>
          constraint.firstRoleKey === input.roleKey
            ? constraint.secondRoleKey
            : constraint.firstRoleKey,
        );
        const excludedAgentIds = incompatibleRoleKeys.length === 0
          ? []
          : await tx.select({ agentId: pipelineGraphRoleBindings.agentId })
            .from(pipelineGraphRoleBindings)
            .where(and(
              eq(pipelineGraphRoleBindings.companyId, input.companyId),
              eq(pipelineGraphRoleBindings.runId, input.runId),
              inArray(pipelineGraphRoleBindings.roleKey, incompatibleRoleKeys),
            )).then((rows) => [...new Set(rows.map((row) => row.agentId))]);

        const candidate = await tx.select({
          agentId: agentWorkflowRoleAssignments.agentId,
        }).from(agentWorkflowRoleAssignments).innerJoin(
          agents,
          and(
            eq(agents.companyId, agentWorkflowRoleAssignments.companyId),
            eq(agents.id, agentWorkflowRoleAssignments.agentId),
          ),
        ).where(and(
          eq(agentWorkflowRoleAssignments.companyId, input.companyId),
          eq(agentWorkflowRoleAssignments.roleKey, input.roleKey),
          inArray(agents.status, ["idle", "running"]),
          excludedAgentIds.length > 0
            ? notInArray(agentWorkflowRoleAssignments.agentId, excludedAgentIds)
            : undefined,
        )).orderBy(
          asc(agentWorkflowRoleAssignments.priority),
          asc(agentWorkflowRoleAssignments.agentId),
        ).limit(1).then((rows) => rows[0] ?? null);

        if (!candidate) {
          throw unprocessable(`No eligible agent can satisfy workflow role '${input.roleKey}'`, {
            code: "workflow_role_unresolved",
            roleKey: input.roleKey,
            separatedFrom: incompatibleRoleKeys,
          });
        }

        return tx.insert(pipelineGraphRoleBindings).values({
          ...input,
          agentId: candidate.agentId,
        }).returning().then((rows) => rows[0]);
      });
    },
  };
}
