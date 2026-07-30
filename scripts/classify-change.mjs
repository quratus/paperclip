#!/usr/bin/env node
// SQN-4278 - Paperclip merge-review classification gate.
//
// The delivery gates prove a change builds and tests. This classifier emits the
// routing verdict used by merge automation: critical changes need human review,
// design changes require visual/design conformance, and non-critical changes can
// auto-route once objective gates are green.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const compile = (arr) => (arr || []).map((s) => new RegExp(s));
const firstMatch = (path, res) => res.find((re) => re.test(path)) || null;

export function classifyFile(file, policy) {
  const path = file.path;
  const churn = (file.added || 0) + (file.deleted || 0);
  const critical = policy.critical;

  const criticalHit = firstMatch(path, compile(critical.paths));
  if (criticalHit) {
    return { tier: "critical", rule: `critical-path ${criticalHit.source}` };
  }
  if ((critical.coreStateFiles || []).includes(path)) {
    return { tier: "critical", rule: "core-state-file" };
  }
  if ((file.status === "M" || file.status === "D") && churn >= (critical.rewriteThreshold ?? 300)) {
    return { tier: "critical", rule: `rewrite churn=${churn} >= ${critical.rewriteThreshold ?? 300}` };
  }
  if (file.status === "D" && new RegExp(critical.sourceDeletionRe).test(path)) {
    return { tier: "critical", rule: "source-deletion" };
  }

  const designHit = firstMatch(path, compile(policy.design.paths));
  if (designHit) {
    return { tier: "design", rule: `design-path ${designHit.source}` };
  }
  if (policy.design.componentRe && new RegExp(policy.design.componentRe).test(path)) {
    return { tier: "design", rule: "ui-component" };
  }

  const hint = firstMatch(path, compile(policy.nonCritical.hintPaths));
  return {
    tier: "non-critical",
    rule: hint ? `non-critical ${hint.source}` : "non-core-change",
  };
}

export function classifyChange(input, policy) {
  const files = input.files || [];
  const subjects = input.subjects || [];
  const labels = (input.labels || []).map((label) => String(label).toLowerCase());
  const reasons = [];

  for (const file of files) {
    const { tier, rule } = classifyFile(file, policy);
    reasons.push({ file: file.path, tier, rule });
  }

  const breakingRe = new RegExp(policy.critical.breakingSubjectRe);
  for (const subject of subjects) {
    if (breakingRe.test(subject)) {
      reasons.push({ tier: "critical", rule: "breaking-subject", subject: subject.slice(0, 80) });
    }
  }

  const criticalLabels = (policy.critical.labels || []).map((label) => label.toLowerCase());
  for (const label of labels) {
    if (criticalLabels.includes(label)) {
      reasons.push({ tier: "critical", rule: `label:${label}` });
    }
  }

  const hasCritical = reasons.some((reason) => reason.tier === "critical");
  const hasDesign = reasons.some((reason) => reason.tier === "design");
  const classification = hasCritical ? "critical" : hasDesign ? "design" : "non-critical";

  return {
    classification,
    routing: hasCritical ? "human" : "auto",
    requiresHumanApproval: hasCritical,
    requiresConformance: hasDesign,
    fileCount: files.length,
    reasons,
  };
}

export class GitCommandError extends Error {
  constructor(args, result) {
    const stderr = (result.stderr || result.error?.message || "").trim();
    const detail = stderr ? `: ${stderr}` : "";
    super(`git ${args.join(" ")} failed with status ${result.status ?? "error"}${detail}`);
    this.name = "GitCommandError";
    this.args = args;
    this.status = result.status;
    this.stderr = stderr;
  }
}

const git = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new GitCommandError(args, result);
  }
  return result;
};

function resolveCommit(ref) {
  return git(["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
}

export function gatherFiles(range, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  const numstat = git(["diff", "--numstat", range]).stdout || "";
  const names = git(["diff", "--name-status", range]).stdout || "";
  const statuses = new Map();

  for (const line of names.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    const status = fields[0]?.[0];
    const path = fields[fields.length - 1];
    if (status && path) statuses.set(path, status);
  }

  const files = [];
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const rawPath = fields[fields.length - 1];
    files.push({
      path: rawPath,
      status: statuses.get(rawPath) || "M",
      added: fields[0] === "-" ? null : Number(fields[0]),
      deleted: fields[1] === "-" ? null : Number(fields[1]),
    });
  }
  if (files.length === 0 && !allowEmpty) {
    throw new Error(`No changed files found for ${range}; refusing to auto-route an empty classifier input.`);
  }
  return files;
}

function parseArgs(argv) {
  const options = {
    base: process.env.CLASSIFY_BASE || "origin/master",
    head: process.env.CLASSIFY_HEAD || "HEAD",
    labels: process.env.PAPERCLIP_PR_LABELS || "",
    writeArtifact: true,
    allowEmpty: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") options.base = argv[++i];
    else if (arg === "--head") options.head = argv[++i];
    else if (arg === "--labels") options.labels = argv[++i];
    else if (arg === "--no-artifact") options.writeArtifact = false;
    else if (arg === "--allow-empty") options.allowEmpty = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function isMainModule(url) {
  return !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/classify-change.mjs [--base <ref>] [--head <ref>] [--labels <csv>] [--no-artifact] [--allow-empty]");
    process.exit(0);
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const policy = JSON.parse(readFileSync(join(here, "change-policy.json"), "utf8"));
    git(["fetch", "--quiet", "origin"]);
    const baseSha = resolveCommit(options.base);
    const headSha = resolveCommit(options.head);

    const range = `${options.base}...${options.head}`;
    const files = gatherFiles(range, { allowEmpty: options.allowEmpty });
    const subjects = (git(["log", "--format=%s", `${options.base}..${options.head}`]).stdout || "")
      .split("\n")
      .filter(Boolean);
    const labels = options.labels.split(",").map((label) => label.trim()).filter(Boolean);
    const verdict = classifyChange({ files, subjects, labels }, policy);

    console.log(`\nclassify-change: ${files.length} file(s) for ${range}`);
    console.log(`BASE_SHA=${baseSha} HEAD_SHA=${headSha}`);
    for (const reason of verdict.reasons) {
      console.log(`  [${reason.tier}] ${reason.file || reason.subject || reason.rule} - ${reason.rule}`);
    }
    console.log(
      `\nCLASSIFICATION=${verdict.classification} ROUTING=${verdict.routing}`
        + ` HUMAN=${verdict.requiresHumanApproval} CONFORMANCE=${verdict.requiresConformance}`,
    );
    if (verdict.routing === "human") {
      console.log("CRITICAL: a human must review this before it merges.");
    } else if (verdict.requiresConformance) {
      console.log("DESIGN: auto-route requires design-conformance and visual checks to pass.");
    } else {
      console.log("NON-CRITICAL: eligible to auto-route once objective gates are green.");
    }

    if (options.writeArtifact) {
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync("artifacts", { recursive: true });
        writeFileSync(
          "artifacts/classification.json",
          JSON.stringify({ range, baseSha, headSha, ...verdict }, null, 2),
        );
      } catch {
        // Printed verdict is the contract; artifact writing is best effort.
      }
    }
  } catch (error) {
    console.error(`classify-change: ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  process.exit(0);
}
