import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { analyticsReportService } from "../services/analytics-report.js";
import { issueService } from "../services/issues.js";
import { routineService } from "../services/routines.js";
import { assertCompanyAccess } from "./authz.js";

export function analyticsRoutes(db: Db) {
  const router = Router();
  const svc = analyticsReportService(db);
  const issueSvc = issueService(db);
  const routineSvc = routineService(db);

  router.get("/companies/:companyId/analytics/report/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const windowDays = Math.min(90, Math.max(1, Number(req.query.days ?? 14)));
    const markdown = await svc.generateMarkdown(companyId, windowDays);
    res.setHeader("Content-Type", "text/plain");
    res.send(markdown);
  });

  router.post("/companies/:companyId/analytics/report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const windowDays = Math.min(90, Math.max(1, Number(req.body.days ?? 14)));
    const createIssue = req.body.createIssue !== false;
    const assigneeAgentId = req.body.assigneeAgentId as string | undefined;
    const projectId = req.body.projectId as string | undefined;

    const markdown = await svc.generateMarkdown(companyId, windowDays);

    if (!createIssue) {
      res.json({ markdown });
      return;
    }

    const issue = await issueSvc.create(companyId, {
      projectId: projectId ?? null,
      title: `Agent Analytics Report — ${new Date().toISOString().split("T")[0]}`,
      description: markdown,
      status: "todo",
      priority: "medium",
      assigneeAgentId: assigneeAgentId ?? null,
    });

    res.json({ issue, markdown });
  });

  router.post("/companies/:companyId/analytics/weekly-routine", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeAgentId = req.body.assigneeAgentId as string | undefined;
    const projectId = req.body.projectId as string | undefined;

    const actor = {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    };

    const routine = await routineSvc.create(companyId, {
      title: "Weekly Agent Analytics Report — {{date}}",
      description: "Review the weekly agent analytics quadrant report.\n\nTo generate the report, use the CLI or API with this company's ID.",
      status: "active",
      priority: "medium",
      assigneeAgentId: assigneeAgentId ?? null,
      projectId: projectId ?? null,
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    }, actor);

    await routineSvc.createTrigger(
      routine.id,
      {
        kind: "schedule",
        label: "Weekly",
        enabled: true,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
      },
      actor,
    );

    res.json({ routine });
  });

  return router;
}
