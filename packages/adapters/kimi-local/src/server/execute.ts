import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envWithKimiPath, resolveKimiCommand } from "./resolve-kimi.js";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSessionCodec,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asBoolean,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  resolveCommandForLogs,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  joinPromptSections,
  currentDateSection,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_GRACE_SEC = 20;

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function kimiSkillsHome(): string {
  return path.join(os.homedir(), ".kimi", "skills");
}

type EnsureKimiSkillsInjectedOptions = {
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  skillsHome?: string;
  linkSkill?: (source: string, target: string) => Promise<void>;
};

async function ensureKimiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureKimiSkillsInjectedOptions = {},
) {
  const skillsEntries = options.skillsEntries ?? await readPaperclipRuntimeSkillEntries({}, __moduleDir);
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? kimiSkillsHome();
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Kimi skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Kimi skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  const linkSkill = options.linkSkill ?? ((source: string, target: string) => fs.symlink(source, target));
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Kimi skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Kimi skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Session codec
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Kimi tracks sessions per cwd in ~/.kimi/kimi.json. Only pass --continue when
// a session actually exists, otherwise Kimi exits with "No previous session found".
async function kimiHasSessionForCwd(cwd: string): Promise<boolean> {
  try {
    const kimiJsonPath = path.join(os.homedir(), ".kimi", "kimi.json");
    const raw = await fs.readFile(kimiJsonPath, "utf-8");
    const data = JSON.parse(raw) as {
      work_dirs?: Array<{ path: string; last_session_id: string | null }>;
    };
    const resolved = path.resolve(cwd);
    return (data.work_dirs ?? []).some(
      (d) => path.resolve(d.path) === resolved && d.last_session_id != null,
    );
  } catch {
    return false;
  }
}

// Read the last_session_id for a given cwd from ~/.kimi/kimi.json.
async function kimiSessionIdForCwd(cwd: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), ".kimi", "kimi.json"), "utf-8");
    const data = JSON.parse(raw) as {
      work_dirs?: Array<{ path: string; last_session_id: string | null }>;
    };
    const resolved = path.resolve(cwd);
    const entry = (data.work_dirs ?? []).find((d) => path.resolve(d.path) === resolved);
    return entry?.last_session_id ?? undefined;
  } catch {
    return undefined;
  }
}

// Parse token usage from ~/.kimi/logs/kimi.log.
// Reads only lines appended after `startOffset` bytes to isolate this run.
// Filters by sessionUuid when available; sums per-step input + output counts.
async function parseKimiLogUsage(
  startOffset: number,
  sessionUuid?: string,
): Promise<UsageSummary | undefined> {
  const logPath = path.join(os.homedir(), ".kimi", "logs", "kimi.log");
  try {
    const buffer = await fs.readFile(logPath);
    if (buffer.length <= startOffset) return undefined;
    const content = buffer.slice(startOffset).toString("utf-8");
    const uuidPrefix = sessionUuid ? `${sessionUuid} - ` : "";
    const pattern = new RegExp(
      `${uuidPrefix}LLM step completed in [\\d.]+s \\(input=(\\d+), output=(\\d+)\\)`,
      "g",
    );
    let totalInput = 0;
    let totalOutput = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      totalInput += Number.parseInt(match[1], 10);
      totalOutput += Number.parseInt(match[2], 10);
    }
    if (totalInput === 0 && totalOutput === 0) return undefined;
    return { inputTokens: totalInput, outputTokens: totalOutput, cachedInputTokens: 0 };
  } catch {
    return undefined;
  }
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    if (!cwd) return null;
    return { cwd };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    if (!cwd) return null;
    return { cwd };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params || typeof params !== "object") return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    if (!cwd) return null;
    return `kimi-${cwd}`;
  },
};

// ---------------------------------------------------------------------------
// Kimi stream-json message types
// ---------------------------------------------------------------------------

type KimiMessage =
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        type: "function";
        id: string;
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string }
  | { role: "user"; content: string }
  | { role: "system"; content: string };

interface ParsedKimiOutput {
  messages: KimiMessage[];
  finalText: string;
  usage?: UsageSummary;
  model?: string;
  provider?: string;
}

function parseKimiStreamJson(stdout: string): ParsedKimiOutput {
  const messages: KimiMessage[] = [];
  let finalText = "";
  let model: string | undefined;
  let provider: string | undefined;
  let usage: UsageSummary | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as KimiMessage & {
        model?: string;
        provider?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      if (msg.role && typeof msg.role === "string") {
        messages.push(msg as KimiMessage);
        if (msg.role === "assistant" && typeof msg.content === "string") {
          finalText = msg.content;
        }
      }
      if (msg.model && typeof msg.model === "string") {
        model = msg.model;
      }
      if (msg.provider && typeof msg.provider === "string") {
        provider = msg.provider;
      }
      if (msg.usage && typeof msg.usage === "object") {
        const u = msg.usage;
        usage = {
          inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
          outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
          cachedInputTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
        };
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  // If no structured messages were parsed, treat the whole stdout as text
  if (messages.length === 0 && stdout.trim().length > 0) {
    finalText = stdout.trim();
  }

  return { messages, finalText, usage, model, provider };
}

// ---------------------------------------------------------------------------
// Build runtime config
// ---------------------------------------------------------------------------

interface KimiRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}

async function buildKimiRuntimeConfig(
  ctx: AdapterExecutionContext,
): Promise<KimiRuntimeConfig> {
  const { runId, agent, config, context, authToken } = ctx;

  const command = asString(config.command, "kimi");
  const configuredCwd = asString(config.cwd, "");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const effectiveCwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(effectiveCwd, { createIfMissing: true });

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Ensure the Kimi Code CLI binary directory is on PATH even when Paperclip
  // is started from a non-interactive context (launchd, cron, systemd) that
  // does not inherit the user's shell PATH.
  const envWithFallback = envWithKimiPath({ ...process.env, ...env });
  env.PATH = envWithFallback.PATH ?? process.env.PATH ?? "";

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.KIMI_API_KEY === "string" && envConfig.KIMI_API_KEY.trim().length > 0;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.KIMI_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, effectiveCwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, effectiveCwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);

  return {
    command,
    resolvedCommand,
    cwd: effectiveCwd,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
  };
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn } = ctx;

  const runtimeConfig = await buildKimiRuntimeConfig(ctx);
  const { command, resolvedCommand, cwd, env, loggedEnv, timeoutSec, graceSec } = runtimeConfig;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const resolvedCwd = path.resolve(cwd);
  const paperclipHasSession =
    Boolean(runtime.sessionId) &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === resolvedCwd);
  const canResumeSession = paperclipHasSession && (await kimiHasSessionForCwd(resolvedCwd));

  // Agent preset selection — this is the "what powers the agent" field
  const agentPreset = asString(config.agentPreset, "default");
  const customAgentFile = asString(config.customAgentFile, "").trim();
  const model = asString(config.model, "").trim();
  const thinking = asBoolean(config.thinking, false);
  const noThinking = asBoolean(config.noThinking, false);

  if (agentPreset === "custom" && !customAgentFile) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "kimi_local: agentPreset is 'custom' but customAgentFile is empty. Provide an absolute path to a Kimi agent YAML file.",
    };
  }

  const promptTemplate = asString(
    config.promptTemplate,
    `You are agent {{agent.id}} ({{agent.name}}) operating inside a Paperclip heartbeat.

## Paperclip Heartbeat Startup Protocol

Your env has: PAPERCLIP_AGENT_ID={{agent.id}}, PAPERCLIP_COMPANY_ID={{agent.companyId}}, PAPERCLIP_RUN_ID={{runId}}

**Step 0 — Check your task:**
\`\`\`bash
echo "TASK_ID=$PAPERCLIP_TASK_ID"
\`\`\`

- **If PAPERCLIP_TASK_ID is set** → checkout the issue, read its description, read the project's AGENTS.md, then do the work.
- **If PAPERCLIP_TASK_ID is EMPTY** → do NOT wander. Do NOT read random files. Find your work:
  \`\`\`bash
  curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=todo,in_progress" \\
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
    | python3 -c 'import sys,json; data=json.load(sys.stdin); assigned=[i for i in data if i.get("assigneeAgentId")=="'"$PAPERCLIP_AGENT_ID"'"]; prio={"critical":0,"high":1,"medium":2,"low":3}; assigned.sort(key=lambda x: prio.get(x.get("priority"),4)); [print("%s | %s | %s | %s" % (i.get("priority",""), i.get("status",""), i.get("identifier",""), i.get("title",""))) for i in assigned]'
  \`\`\`
  Pick the highest-priority issue with status todo or in_progress. If none assigned, report clearly and STOP.

**Forbidden without a specific assigned issue:** reading JETZT.md, browsing handoffs, running git log out of curiosity, exploring files randomly.

When working: read the issue description completely first, then the project's AGENTS.md, then implement exactly what the issue asks.`,
  );

  const kimiSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredKimiSkillNames = resolvePaperclipDesiredSkillNames(config, kimiSkillEntries);
  await ensureKimiSkillsInjected(onLog, {
    skillsEntries: kimiSkillEntries.filter((entry) => desiredKimiSkillNames.includes(entry.key)),
  });

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const prompt = joinPromptSections([currentDateSection(), wakePrompt, sessionHandoffNote, renderedPrompt]);

  // Build Kimi CLI arguments for the current kimi-code CLI.
  // Non-interactive prompt mode uses --prompt <text> plus --output-format stream-json.
  const args = [
    "--prompt",
    prompt,
    "--output-format",
    "stream-json",
  ];

  if (canResumeSession) {
    args.push("--continue");
    await onLog("stdout", `[paperclip] Continuing previous Kimi session for ${resolvedCwd}\n`);
  }

  if (model) {
    args.push("--model", model);
  }

  // Agent preset / thinking flags are not supported by the current kimi-code CLI.
  // Keep reading the config for backwards compatibility but do not pass them.
  if (agentPreset !== "default" || customAgentFile || thinking || noThinking) {
    await onLog(
      "stderr",
      `[paperclip] kimi_local: agentPreset/thinking options are ignored by the current Kimi CLI\n`,
    );
  }

  const extraArgs = asString(config.extraArgs, "").trim();
  if (extraArgs) {
    args.push(...extraArgs.split(/\s+/).filter(Boolean));
  }

  if (onMeta) {
    await onMeta({
      adapterType: "kimi_local",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
      prompt,
      context,
    });
  }

  await onLog("stdout", `[kimi] Starting Kimi Code CLI with ${agentPreset} agent preset\n`);

  // Snapshot log file size so we only parse lines appended during this run.
  const kimiLogPath = path.join(os.homedir(), ".kimi", "logs", "kimi.log");
  let logStartOffset = 0;
  try {
    const stat = await fs.stat(kimiLogPath);
    logStartOffset = stat.size;
  } catch { /* log may not exist on first run */ }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog,
  });

  // Read session UUID from kimi.json after the run (updated by Kimi on exit).
  const kimiSessionUuid = await kimiSessionIdForCwd(resolvedCwd);
  const logUsage = await parseKimiLogUsage(logStartOffset, kimiSessionUuid);

  const parsed = parseKimiStreamJson(proc.stdout);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
      summary: parsed.finalText || undefined,
    };
  }

  // Extract the first meaningful stderr line for error reporting
  const stderrLine =
    proc.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  const hasErrors = (proc.exitCode ?? 0) !== 0;

  // Build session state for Paperclip to resume on the next heartbeat
  const sessionParams = { cwd: resolvedCwd };
  const sessionDisplayId = `kimi-${resolvedCwd}`;

  // Prefer log-based token counts (accurate per-step sums) over stream-json
  // which never emits usage fields in Kimi's current output format.
  const resolvedUsage = logUsage ?? parsed.usage;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: hasErrors
      ? (stderrLine
        ? `Kimi exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
        : `Kimi exited with code ${proc.exitCode ?? -1}`)
      : null,
    summary: parsed.finalText || "(no output from Kimi)",
    provider: parsed.provider || "kimi",
    model: parsed.model || model || "default",
    usage: resolvedUsage,
    billingType: resolvedUsage ? "subscription_included" : undefined,
    sessionId: sessionDisplayId,
    sessionParams,
    sessionDisplayId,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
