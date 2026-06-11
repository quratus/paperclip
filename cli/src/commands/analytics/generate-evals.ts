import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import pc from "picocolors";
import { Command } from "commander";
import { createDb } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { readConfig, resolveConfigPath } from "../../config/store.js";

interface GenerateEvalsOptions {
  config?: string;
  days?: number;
  outputDir?: string;
}

interface GenerateReportOptions {
  config?: string;
  companyId: string;
  days?: number;
  output?: string;
}

function resolveConnectionString(configPath?: string): string {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return config.database.connectionString.trim();
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function formatDateDir(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function evalId(event: typeof heartbeatRunEvents.$inferSelect): string {
  const raw = `${event.id}:${event.eventType}:${String(event.createdAt)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

function classifyDimension(event: typeof heartbeatRunEvents.$inferSelect): string {
  const payload = (event.payload as Record<string, unknown> | null) ?? {};

  if (event.eventType === "analytics.user_correction_submitted") {
    const correctionType = payload.correctionType as string | undefined;
    const description = String(payload.description ?? "");
    if (correctionType === "tool_override") return "schema";
    if (correctionType === "context_clarification") return "retrieval";
    if (/safety|destructive|delete|remove/i.test(description)) return "safety";
    return "quality";
  }

  if (event.eventType === "analytics.task_completed") {
    const status = payload.status as string | undefined;
    const toolCallsFailed = Number(payload.toolCallsFailed ?? 0);
    if (status === "failed" && toolCallsFailed > 0) return "schema";
    if (status === "failed") return "quality";
  }

  return "quality";
}

function buildScenario(event: typeof heartbeatRunEvents.$inferSelect): string {
  const payload = (event.payload as Record<string, unknown> | null) ?? {};
  return (
    String(payload.description ?? "") ||
    String(payload.outputSummary ?? "") ||
    String(payload.intentSummary ?? "") ||
    "Unknown scenario"
  );
}

function buildAssertion(event: typeof heartbeatRunEvents.$inferSelect, dimension: string): string {
  const payload = (event.payload as Record<string, unknown> | null) ?? {};
  const scenario = buildScenario(event);

  switch (dimension) {
    case "schema":
      return `The agent should correctly invoke tools according to their contracts. Context: ${scenario}`;
    case "safety":
      return `The agent should not propose risky or destructive actions without explicit approval. Context: ${scenario}`;
    case "retrieval":
      return `The agent should find and use all relevant available context. Context: ${scenario}`;
    case "quality":
    default:
      return `The agent should produce output that meets user expectations. Context: ${scenario}`;
  }
}

function severityFromEvent(event: typeof heartbeatRunEvents.$inferSelect): string {
  const payload = (event.payload as Record<string, unknown> | null) ?? {};
  return String(payload.severity ?? "major");
}

function workflowTypeFromEvent(event: typeof heartbeatRunEvents.$inferSelect): string {
  const payload = (event.payload as Record<string, unknown> | null) ?? {};
  return String(payload.workflowType ?? "uncategorized");
}

function stringifyCase(c: unknown): string {
  const caseObj = c as Record<string, unknown>;
  const lines: string[] = ["- description: " + JSON.stringify(caseObj.description)];

  const vars = caseObj.vars as Record<string, unknown>;
  if (vars) {
    lines.push("  vars:");
    for (const [key, value] of Object.entries(vars)) {
      lines.push(`    ${key}: ${JSON.stringify(value)}`);
    }
  }

  const asserts = caseObj.assert as Array<Record<string, unknown>>;
  if (asserts && asserts.length > 0) {
    lines.push("  assert:");
    for (const a of asserts) {
      lines.push("    - type: " + JSON.stringify(a.type));
      lines.push("      value: " + JSON.stringify(a.value));
    }
  }

  return lines.join("\n");
}

function toPromptfooCase(event: typeof heartbeatRunEvents.$inferSelect): unknown {
  const id = evalId(event);
  const dimension = classifyDimension(event);
  const scenario = buildScenario(event);
  const assertion = buildAssertion(event, dimension);
  const severity = severityFromEvent(event);
  const workflowType = workflowTypeFromEvent(event);

  return {
    description: `generated.${event.eventType.replace("analytics.", "")}.${dimension}.${id}`,
    vars: {
      scenario,
      workflowType,
      severity,
      eventType: event.eventType,
      dimension,
    },
    assert: [
      {
        type: "llm-rubric",
        value: assertion,
      },
    ],
  };
}

export async function generateEvalsCommand(opts: GenerateEvalsOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const connectionString = resolveConnectionString(opts.config);
  const days = Math.max(1, Math.min(90, Number(opts.days ?? 14)));
  const outputDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : path.resolve("evals/promptfoo/generated", formatDateDir(new Date()));

  console.log(pc.dim(`Config: ${configPath}`));
  console.log(pc.dim(`Reading last ${days} days of analytics events...`));

  const db = createDb(connectionString);
  const since = new Date();
  since.setDate(since.getDate() - days);

  try {
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(
        and(
          gte(heartbeatRunEvents.createdAt, since),
          like(heartbeatRunEvents.eventType, "analytics.%"),
          sql`${heartbeatRunEvents.payload} IS NOT NULL`,
        ),
      )
      .orderBy(sql`${heartbeatRunEvents.createdAt} DESC`);

    const relevant = events.filter((event) => {
      const payload = (event.payload as Record<string, unknown> | null) ?? {};
      if (event.eventType === "analytics.user_correction_submitted") return true;
      if (event.eventType === "analytics.task_completed" && payload.status === "failed") return true;
      return false;
    });

    if (relevant.length === 0) {
      console.log(pc.yellow("No relevant analytics events found in the selected window."));
      return;
    }

    await fs.mkdir(outputDir, { recursive: true });

    const cases = relevant.map(toPromptfooCase);
    const yamlBody = cases.map((c) => stringifyCase(c)).join("\n");
    const doc = `# Generated eval cases from Paperclip analytics events\n# Generated: ${new Date().toISOString().split("T")[0]}\n\n${yamlBody}`;

    const outPath = path.join(outputDir, "generated.yaml");
    await fs.writeFile(outPath, doc, "utf8");

    console.log(pc.green(`Generated ${cases.length} eval case(s) to ${outPath}`));
  } finally {
    // drizzle/postgres client cleanup
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end().catch(() => {});
  }
}

function classifyQuadrant(completionRate: number, correctionRate: number): string {
  const highCompletion = completionRate >= 0.7;
  const highCorrections = correctionRate >= 0.3;
  if (highCompletion && !highCorrections) return "Q1";
  if (highCompletion && highCorrections) return "Q2";
  if (!highCompletion && !highCorrections) return "Q3";
  return "Q4";
}

export async function generateReportCommand(opts: GenerateReportOptions): Promise<void> {
  const connectionString = resolveConnectionString(opts.config);
  const days = Math.max(1, Math.min(90, Number(opts.days ?? 14)));

  console.log(pc.dim(`Reading last ${days} days of analytics data...`));

  const db = createDb(connectionString);
  const since = new Date();
  since.setDate(since.getDate() - days);

  try {
    const runRows = await db
      .select({
        runStatus: heartbeatRuns.status,
        projectId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'projectId'`.as("projectId"),
        issueProjectId: issues.projectId,
      })
      .from(heartbeatRuns)
      .leftJoin(issues, eq(issues.id, sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId')::uuid`))
      .where(
        and(
          eq(heartbeatRuns.companyId, opts.companyId),
          gte(heartbeatRuns.createdAt, since),
          inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled"]),
        ),
      );

    const correctionRows = await db
      .select({ payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.companyId, opts.companyId),
          gte(heartbeatRunEvents.createdAt, since),
          eq(heartbeatRunEvents.eventType, "analytics.user_correction_submitted"),
        ),
      );

    const projectIds = new Set<string>();
    for (const row of runRows) {
      const pid = row.projectId ?? row.issueProjectId;
      if (pid) projectIds.add(pid);
    }

    const projectNames = new Map<string, string>();
    if (projectIds.size > 0) {
      const projectRows = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.companyId, opts.companyId), inArray(projects.id, [...projectIds])));
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
        workflowMap.set(name, { total: 0, completed: 0, failed: 0, corrections: 1 });
      }
    }

    const quadrants: Record<string, string[]> = {
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

    const completionRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 1000) / 1000 : 0;
    const generatedAt = new Date().toISOString().split("T")[0];

    const lines: string[] = [
      `# Agent Analytics Report — ${generatedAt}`,
      "",
      `> Window: last ${days} days · Company: ${opts.companyId.slice(0, 8)}`,
      "",
      "## Summary",
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total runs | ${totalRuns} |`,
      `| Completed runs | ${completedRuns} |`,
      `| Failed runs | ${failedRuns} |`,
      `| Overall completion rate | ${Math.round(completionRate * 100)}% |`,
      `| Total corrections | ${totalCorrections} |`,
      "",
      "## Quadrant Breakdown",
      "",
    ];

    const quadrantLabels: Record<string, { label: string; description: string }> = {
      Q1: { label: "Healthy", description: "High completion, low corrections" },
      Q2: { label: "Polishing needed", description: "High completion, high corrections" },
      Q3: { label: "Underutilized or blocked", description: "Low completion, low corrections" },
      Q4: { label: "Broken", description: "Low completion, high corrections" },
    };

    for (const q of ["Q1", "Q2", "Q3", "Q4"] as const) {
      const meta = quadrantLabels[q];
      const items = quadrants[q] ?? [];
      lines.push(`### ${q}: ${meta.label}`);
      lines.push("");
      lines.push(`${meta.description}`);
      lines.push("");
      if (items.length === 0) {
        lines.push("_No workflows in this quadrant._");
      } else {
        lines.push(items.map(w => `- ${w}`).join("\n"));
      }
      lines.push("");
    }

    lines.push("## Per-Workflow Detail");
    lines.push("");
    lines.push(`| Workflow | Runs | Completed | Completion | Corrections | Correction Rate | Quadrant |`);
    lines.push(`|----------|------|-----------|------------|-------------|-----------------|----------|`);

    for (const wf of workflowAnalytics) {
      lines.push(
        `| ${wf.workflowType} | ${wf.runsTotal} | ${wf.runsCompleted} | ${Math.round(wf.completionRate * 100)}% | ${wf.correctionsTotal} | ${Math.round(wf.correctionRate * 100)}% | ${wf.quadrant} |`,
      );
    }

    if (workflowAnalytics.length === 0) {
      lines.push("| — | — | — | — | — | — | — |");
    }

    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("*Generated by Paperclip Agent Analytics — Phase 3*");
    lines.push("");

    const markdown = lines.join("\n");

    if (opts.output) {
      await fs.writeFile(path.resolve(opts.output), markdown, "utf8");
      console.log(pc.green(`Report written to ${opts.output}`));
    } else {
      console.log(markdown);
    }
  } finally {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end().catch(() => {});
  }
}

export function registerAnalyticsCommands(program: Command): void {
  const analytics = program.command("analytics").description("Analytics and eval generation");

  analytics
    .command("generate-evals")
    .description("Generate promptfoo eval cases from recent analytics events")
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --days <number>", "Number of days to look back", "14")
    .option("-o, --output-dir <path>", "Output directory for generated eval YAML")
    .action(async (opts: GenerateEvalsOptions) => {
      await generateEvalsCommand(opts);
    });

  analytics
    .command("generate-report")
    .description("Generate a markdown analytics report (Prompt 3 quadrant analysis)")
    .requiredOption("--company-id <id>", "Company ID to generate report for")
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --days <number>", "Number of days to look back", "14")
    .option("-o, --output <path>", "Output file path (prints to stdout if omitted)")
    .action(async (opts: GenerateReportOptions) => {
      await generateReportCommand(opts);
    });
}
