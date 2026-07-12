import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunStatus(
  db: ReturnType<typeof createDb>,
  runId: string,
  status: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
}

async function waitForCapacityRequeue(
  db: ReturnType<typeof createDb>,
  input: { agentId: string; issueId: string; agentStatus?: "at_capacity" | "running" },
  timeoutMs = 4_000,
) {
  const readState = async () => {
    const [agent, issue, comments] = await Promise.all([
      db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, input.issueId)),
    ]);
    return {
      agent,
      issue,
      comment: comments.find((comment) => comment.body.includes("Awaiting capacity")) ?? null,
    };
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState();
    if (
      state.agent?.status === (input.agentStatus ?? "at_capacity") &&
      state.issue?.status === "todo" &&
      state.issue.executionRunId === null &&
      state.issue.checkoutRunId === null &&
      state.comment
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return readState();
}

async function waitForAgentStatus(
  db: ReturnType<typeof createDb>,
  agentId: string,
  status: string,
  timeoutMs = 4_000,
) {
  const readAgent = () =>
    db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agent = await readAgent();
    if (agent?.status === status) return agent;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return readAgent();
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    issueStatus?: "todo" | "in_progress" | "done" | "cancelled";
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: input?.issueStatus ?? "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const runtimeState = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(runtimeState?.lastRunId).toBe(runId);
    expect(runtimeState?.lastRunStatus).toBe("failed");
    expect(runtimeState?.lastError).toContain("Process lost");
    expect(runtimeState?.lastError).toContain("retrying once");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(retryRun?.id ?? null);

    const ownership = await issueService(db).assertCheckoutOwner(issueId, agentId, retryRun?.id ?? null);
    expect(ownership.checkoutRunId).toBe(retryRun?.id ?? null);
  });

  it("marks process capacity exits as at_capacity and requeues the issue with a comment", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "paperclip-capacity-"));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer VPS",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(75)"],
        cwd,
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run saturated fast-lane work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });
    expect(queuedRun?.id).toBeTypeOf("string");

    const run = await waitForRunStatus(db, queuedRun?.id ?? "", "failed", 4_000);
    expect(run?.errorCode).toBe("capacity_exhausted");
    expect(run?.exitCode).toBe(75);

    const { agent, issue, comment } = await waitForCapacityRequeue(db, { agentId, issueId });
    expect(agent?.status).toBe("at_capacity");
    expect(issue?.status).toBe("todo");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
    expect(comment?.body).toContain("Awaiting capacity");
    expect(comment?.metadata).toMatchObject({ kind: "capacity_exhausted_requeue" });
  });

  it("classifies Claude session quota output as capacity and requeues the issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "paperclip-quota-"));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer VPS",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.stderr.write(\"You've hit your session limit - resets at 5pm\\n\"); process.exit(1)"],
        cwd,
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run quota-limited fast-lane work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const queuedRun = await heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });

    const run = await waitForRunStatus(db, queuedRun?.id ?? "", "failed", 4_000);
    expect(run?.errorCode).toBe("capacity_exhausted");
    expect(run?.exitCode).toBe(1);

    const { agent, issue, comment } = await waitForCapacityRequeue(db, { agentId, issueId });
    expect(agent?.status).toBe("at_capacity");
    expect(issue?.status).toBe("todo");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
    expect(comment?.body).toContain("Awaiting capacity");
  });

  it("keeps the agent running when a capacity failure has a healthy sibling run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const siblingRunId = randomUUID();
    const siblingWakeupId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "paperclip-quota-sibling-"));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer VPS",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.stderr.write(\"You've hit your session limit - resets soon\\n\"); process.exit(1)"],
        cwd,
      },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: siblingWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "claimed",
      runId: siblingRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: siblingRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: siblingWakeupId,
      contextSnapshot: { issueId: randomUUID() },
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run quota-limited work beside healthy sibling",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const queuedRun = await heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });

    const run = await waitForRunStatus(db, queuedRun?.id ?? "", "failed", 4_000);
    expect(run?.errorCode).toBe("capacity_exhausted");

    const { agent, issue, comment } = await waitForCapacityRequeue(db, { agentId, issueId, agentStatus: "running" });
    expect(agent?.status).toBe("running");
    expect(issue?.status).toBe("todo");
    expect(comment?.body).toContain("Awaiting capacity");
  });

  it("keeps ordinary process crashes as agent errors", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "paperclip-crash-"));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Broken Process",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.stderr.write(\"boom\\n\"); process.exit(1)"],
        cwd,
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run broken process",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const queuedRun = await heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });

    const run = await waitForRunStatus(db, queuedRun?.id ?? "", "failed", 4_000);
    expect(run?.errorCode).toBe("adapter_failed");

    const agent = await waitForAgentStatus(db, agentId, "error");
    expect(agent?.status).toBe("error");
  });

  it("exits a newer same-issue sibling run before adapter execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const olderWakeupId = randomUUID();
    const newerWakeupId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "SIB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Sibling Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: olderWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        status: "claimed",
        runId: olderRunId,
      },
      {
        id: newerWakeupId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "process_lost_retry",
        status: "queued",
        runId: newerRunId,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId: olderWakeupId,
        contextSnapshot: { issueId },
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: newerWakeupId,
        contextSnapshot: { issueId, wakeReason: "process_lost_retry" },
        createdAt: new Date("2026-03-19T00:01:00.000Z"),
        updatedAt: new Date("2026-03-19T00:01:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Sibling guarded issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: olderRunId,
      executionRunId: olderRunId,
    });

    await heartbeatService(db).resumeQueuedRuns();

    const newerRun = await waitForRunStatus(db, newerRunId, "succeeded");
    expect(newerRun?.errorCode).toBeNull();
    expect(newerRun?.resultJson).toMatchObject({
      skipped: true,
      reason: "live_sibling_run",
      issueId,
      siblingRunId: olderRunId,
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.checkoutRunId).toBe(olderRunId);
    expect(issue?.executionRunId).toBe(olderRunId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(`Superseded by live sibling run ${olderRunId}.`);
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("transitions to machine-actionable blocked after two identical runtime failure outcomes", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId },
      errorCode: "process_lost",
      error: "Previous execution process was lost",
      createdAt: new Date("2026-03-18T23:59:00.000Z"),
      updatedAt: new Date("2026-03-18T23:59:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Blocked: runtime failure loop detected.");
    expect(comments[0]?.body).not.toContain("Blocked pending human");
    expect(comments[0]?.body).toContain("Detector: repeating_error");
    expect(comments[0]?.body).toContain("Gate: batched_escalate");
    expect(comments[0]?.metadata).toMatchObject({
      kind: "stuck_detection_transition",
      plateauReason: "repeating_error",
      transitionReason: "runtime_failure",
    });
  });

  it("does not transition when the recent execution history is not a plateau", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId },
      createdAt: new Date("2026-03-18T23:59:00.000Z"),
      updatedAt: new Date("2026-03-18T23:59:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("does not move terminal issues back to blocked_pending_human from stale failed runs", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
      issueStatus: "done",
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId },
      errorCode: "process_lost",
      error: "Previous execution process was lost",
      createdAt: new Date("2026-03-18T23:59:00.000Z"),
      updatedAt: new Date("2026-03-18T23:59:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("done");
    expect(issue?.executionRunId).toBeNull();

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(mockTelemetryClient, {
      agentRole: "engineer",
    });
  });
});
