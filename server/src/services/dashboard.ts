import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRunEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type { WorkflowQuadrant } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const ANALYTICS_WINDOW_DAYS = 14;
const QUADRANT_COMPLETION_THRESHOLD = 0.7;
const QUADRANT_CORRECTION_THRESHOLD = 0.3;

function classifyQuadrant(completionRate: number, correctionRate: number): WorkflowQuadrant {
  const highCompletion = completionRate >= QUADRANT_COMPLETION_THRESHOLD;
  const highCorrections = correctionRate >= QUADRANT_CORRECTION_THRESHOLD;
  if (highCompletion && !highCorrections) return "Q1";
  if (highCompletion && highCorrections) return "Q2";
  if (!highCompletion && !highCorrections) return "Q3";
  return "Q4";
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      const analyticsWindowStart = new Date();
      analyticsWindowStart.setDate(analyticsWindowStart.getDate() - ANALYTICS_WINDOW_DAYS);

      const runRows = await db
        .select({
          runStatus: heartbeatRuns.status,
          projectId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'projectId'`.as("projectId"),
          issueProjectId: issues.projectId,
        })
        .from(heartbeatRuns)
        .leftJoin(
          issues,
          eq(issues.id, sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId')::uuid`),
        )
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, analyticsWindowStart),
            inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled"]),
          ),
        );

      const correctionRows = await db
        .select({
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.companyId, companyId),
            gte(heartbeatRunEvents.createdAt, analyticsWindowStart),
            eq(heartbeatRunEvents.eventType, "analytics.user_correction_submitted"),
          ),
        );

      const projectIds = new Set<string>();
      for (const row of runRows) {
        const pid = row.projectId ?? row.issueProjectId;
        if (pid) projectIds.add(pid);
      }

      let projectNames = new Map<string, string>();
      if (projectIds.size > 0) {
        const projectRows = await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), inArray(projects.id, [...projectIds])));
        for (const row of projectRows) {
          projectNames.set(row.id, row.name);
        }
      }

      const workflowMap = new Map<string, { total: number; completed: number; failed: number; corrections: number }>();
      let totalRuns = 0;
      let completedRuns = 0;
      let failedRuns = 0;

      for (const row of runRows) {
        const pid = row.projectId ?? row.issueProjectId ?? "uncategorized";
        const name = projectNames.get(pid) ?? (pid === "uncategorized" ? "Uncategorized" : pid.slice(0, 8));
        const bucket = workflowMap.get(name) ?? { total: 0, completed: 0, failed: 0, corrections: 0 };
        bucket.total++;
        totalRuns++;
        if (row.runStatus === "succeeded") {
          bucket.completed++;
          completedRuns++;
        } else {
          bucket.failed++;
          failedRuns++;
        }
        workflowMap.set(name, bucket);
      }

      for (const row of correctionRows) {
        const payload = (row.payload as Record<string, unknown> | null) ?? {};
        const workflowType = String(payload.workflowType ?? "uncategorized");
        const name = projectNames.get(workflowType) ?? (workflowType === "uncategorized" ? "Uncategorized" : workflowType.slice(0, 8));
        const bucket = workflowMap.get(name);
        if (bucket) {
          bucket.corrections++;
        } else {
          // Correction for a workflow with no runs in window — still track it
          workflowMap.set(name, { total: 0, completed: 0, failed: 0, corrections: 1 });
        }
      }

      const quadrants: Record<WorkflowQuadrant, string[]> = {
        Q1: [],
        Q2: [],
        Q3: [],
        Q4: [],
      };

      let totalCorrections = 0;
      const workflowAnalytics = [...workflowMap.entries()]
        .map(([workflowType, counts]) => {
          const completionRate = counts.total > 0 ? Math.round((counts.completed / counts.total) * 1000) / 1000 : 0;
          const correctionRate = counts.total > 0 ? Math.round((counts.corrections / counts.total) * 1000) / 1000 : 0;
          const quadrant = classifyQuadrant(completionRate, correctionRate);
          quadrants[quadrant].push(workflowType);
          totalCorrections += counts.corrections;
          return {
            workflowType,
            runsTotal: counts.total,
            runsCompleted: counts.completed,
            runsFailed: counts.failed,
            completionRate,
            correctionsTotal: counts.corrections,
            correctionRate,
            quadrant,
          };
        })
        .sort((a, b) => b.runsTotal - a.runsTotal);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        analytics: {
          runsTotal: totalRuns,
          runsCompleted: completedRuns,
          runsFailed: failedRuns,
          completionRate: totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 1000) / 1000 : 0,
          correctionsTotal: totalCorrections,
          workflows: workflowAnalytics,
          quadrants,
        },
      };
    },
  };
}
