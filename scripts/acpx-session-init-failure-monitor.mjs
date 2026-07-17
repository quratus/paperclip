#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ALERT_THRESHOLD = 0.2;
const DEFAULT_RESOLVE_THRESHOLD = 0.05;
const DEFAULT_MIN_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 1000;
const MARKER = "acpx-session-init-failure-monitor";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "dry-run" || key === "json") {
      args[key] = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

function asDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function runTime(run) {
  return asDate(run.startedAt) ?? asDate(run.createdAt) ?? asDate(run.finishedAt);
}

function readText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(readText).filter(Boolean).join(" ");
  return "";
}

function isAcpxSessionInitFailure(run) {
  if (run?.errorCode === "acpx_session_init_failed") return true;
  const haystack = [
    run?.error,
    run?.resultSummary,
    run?.resultResult,
    run?.resultMessage,
    run?.resultError,
    readText(run?.resultJson),
  ].filter(Boolean).join(" ");
  return /\bacpx_session_init_failed\b/.test(haystack);
}

function sampleErrorMessage(run) {
  const candidates = [
    run?.error,
    run?.resultError,
    run?.resultMessage,
    run?.resultSummary,
    run?.resultResult,
    readText(run?.resultJson),
  ];
  for (const candidate of candidates) {
    const text = typeof candidate === "string" ? candidate.trim() : "";
    if (text) return text.replace(/\s+/g, " ").slice(0, 500);
  }
  return "No sample error message available.";
}

export function evaluateAcpxSessionInitFailures(runs, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rollingWindowMs = options.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS;
  const minFailureWindowMs = options.minFailureWindowMs ?? DEFAULT_MIN_FAILURE_WINDOW_MS;
  const alertThreshold = options.alertThreshold ?? DEFAULT_ALERT_THRESHOLD;
  const resolveThreshold = options.resolveThreshold ?? DEFAULT_RESOLVE_THRESHOLD;
  const windowStart = new Date(now.getTime() - rollingWindowMs);
  const recentRuns = runs.filter((run) => {
    const time = runTime(run);
    return time && time >= windowStart && time <= now;
  });
  const failedRuns = recentRuns.filter(isAcpxSessionInitFailure);
  const failedTimes = failedRuns.map(runTime).filter(Boolean).sort((a, b) => a.getTime() - b.getTime());
  const failureWindowMs = failedTimes.length > 1
    ? failedTimes.at(-1).getTime() - failedTimes[0].getTime()
    : 0;
  const totalRuns = recentRuns.length;
  const failedCount = failedRuns.length;
  const failureRate = totalRuns === 0 ? 0 : failedCount / totalRuns;
  const suppressedTransient = failedCount > 0 && failureRate > alertThreshold && failureWindowMs < minFailureWindowMs;
  const shouldAlert = failureRate > alertThreshold && failedCount > 0 && !suppressedTransient;
  const shouldResolve = failureRate < resolveThreshold;
  const sampleRun = failedRuns.find((run) => sampleErrorMessage(run)) ?? failedRuns[0] ?? null;

  return {
    totalRuns,
    failedCount,
    failureRate,
    failurePercent: failureRate * 100,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    failureWindowMs,
    failureWindowHours: failureWindowMs / (60 * 60 * 1000),
    suppressedTransient,
    shouldAlert,
    shouldResolve,
    sampleErrorMessage: sampleRun ? sampleErrorMessage(sampleRun) : "No acpx_session_init_failed run in rolling window.",
  };
}

function latestMonitorState(comments) {
  let state = "resolved";
  for (const comment of comments) {
    const body = typeof comment?.body === "string" ? comment.body : "";
    const match = body.match(/<!--\s*acpx-session-init-failure-monitor:state=(active|resolved)\s*-->/);
    if (match) state = match[1];
  }
  return state;
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function alertComment(result) {
  return [
    `<!-- ${MARKER}:state=active -->`,
    "## Alert: acpx_session_init_failed rate above threshold",
    "",
    `Rolling 24h failure rate is ${formatPercent(result.failurePercent)} (${result.failedCount}/${result.totalRuns} runs), above the 20% alert threshold.`,
    "",
    "- Monitoring action only: no server restart or agent restart was attempted.",
    `- Failure window: ${result.failureWindowHours.toFixed(2)}h`,
    `- Sample error: ${result.sampleErrorMessage}`,
  ].join("\n");
}

function resolveComment(result) {
  return [
    `<!-- ${MARKER}:state=resolved -->`,
    "## Resolved: acpx_session_init_failed rate back below threshold",
    "",
    `Rolling 24h failure rate is ${formatPercent(result.failurePercent)} (${result.failedCount}/${result.totalRuns} runs), below the 5% resolve threshold.`,
    "",
    "- Monitoring action only: no server restart or agent restart was attempted.",
  ].join("\n");
}

async function apiFetch(apiBase, path, options = {}) {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${options.method ?? "GET"} ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = args["api-base"] ?? process.env.PAPERCLIP_API_BASE ?? "http://127.0.0.1:3100";
  const companyId = args["company-id"] ?? process.env.PAPERCLIP_COMPANY_ID;
  const opsIssueId = args["ops-issue-id"] ?? process.env.PAPERCLIP_OPS_ISSUE_ID;
  const runId = args["run-id"] ?? process.env.PAPERCLIP_RUN_ID;
  const mutationHeaders = runId ? { "X-Paperclip-Run-Id": runId } : {};
  const limit = Number(args.limit ?? DEFAULT_LIMIT);
  if (!companyId) throw new Error("--company-id or PAPERCLIP_COMPANY_ID is required");
  if (!opsIssueId && !args["dry-run"]) throw new Error("--ops-issue-id or PAPERCLIP_OPS_ISSUE_ID is required unless --dry-run is set");

  const runs = await apiFetch(apiBase, `/api/companies/${companyId}/heartbeat-runs?limit=${Number.isFinite(limit) ? limit : DEFAULT_LIMIT}`);
  if (!Array.isArray(runs)) throw new Error("heartbeat-runs response was not a list");
  const result = evaluateAcpxSessionInitFailures(runs);
  const comments = opsIssueId
    ? await apiFetch(apiBase, `/api/issues/${opsIssueId}/comments`).catch(() => [])
    : [];
  const currentState = Array.isArray(comments) ? latestMonitorState(comments) : "resolved";
  const next = { ...result, currentState, action: "none" };

  if (!result.suppressedTransient && result.shouldAlert && currentState !== "active") {
    next.action = "alert";
    if (!args["dry-run"]) {
      await apiFetch(apiBase, `/api/issues/${opsIssueId}/comments`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ body: alertComment(result) }),
      });
    }
  } else if (result.shouldResolve && currentState === "active") {
    next.action = "resolve";
    if (!args["dry-run"]) {
      await apiFetch(apiBase, `/api/issues/${opsIssueId}/comments`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ body: resolveComment(result) }),
      });
    }
  } else if (result.suppressedTransient) {
    next.action = "suppress_transient";
  }

  const line = `acpx_session_init_failed monitor: ${next.action}; ${next.failedCount}/${next.totalRuns} (${formatPercent(next.failurePercent)}), failureWindow=${next.failureWindowHours.toFixed(2)}h`;
  if (args.json) console.log(JSON.stringify(next, null, 2));
  else console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
