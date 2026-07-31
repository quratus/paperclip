import { describe, expect, it } from "vitest";
import type { AdapterInvocationMeta } from "../types.js";
import { execute } from "./execute.js";

describe("process adapter execute", () => {
  it("passes scoped issue wake context to the child process", async () => {
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({task:process.env.PAPERCLIP_TASK_ID,reason:process.env.PAPERCLIP_WAKE_REASON,comment:process.env.PAPERCLIP_WAKE_COMMENT_ID}))",
        ],
      },
      context: {
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.resultJson?.stdout))).toEqual({
      task: "issue-1",
      reason: "issue_comment_mentioned",
      comment: "comment-1",
    });
  });

  it("passes the normalized graph assignment wake payload to the child process", async () => {
    const graphAssignment = {
      schemaVersion: 1,
      id: "run-1:1:implement",
      runId: "11111111-1111-4111-8111-111111111111",
      caseId: "22222222-2222-4222-8222-222222222222",
      issueId: "33333333-3333-4333-8333-333333333333",
      graphVersionId: "44444444-4444-4444-8444-444444444444",
      runRevision: 1,
      nodeKey: "implement",
      nodeKind: "working",
      targetAgentId: "55555555-5555-4555-8555-555555555555",
      responsibilityOwner: "implementer",
      instruction: "Complete through the graph transition endpoint.",
      acceptanceCriteria: ["Exact-head evidence is durable"],
      allowedOutcomes: ["ready_for_review", "capacity_unavailable"],
      completion: {
        method: "POST",
        path: "/api/graph-runs/11111111-1111-4111-8111-111111111111/transitions",
        requiredFields: ["expectedRevision", "idempotencyKey", "outcome", "checkpoint"],
      },
    };
    const invocationMetadata: AdapterInvocationMeta[] = [];
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.PAPERCLIP_WAKE_PAYLOAD_JSON || '')"],
      },
      context: {
        issueId: graphAssignment.issueId,
        taskId: graphAssignment.issueId,
        wakeReason: "pipeline_graph_wake",
        paperclipWake: { graphAssignment },
      },
      onLog: async () => {},
      onMeta: async (metadata) => {
        invocationMetadata.push(metadata);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.resultJson?.stdout))).toMatchObject({ graphAssignment });
    expect(invocationMetadata).toHaveLength(1);
    expect(invocationMetadata[0]?.env).toMatchObject({
      PAPERCLIP_WAKE_PAYLOAD_JSON: "***REDACTED***",
    });
    expect(JSON.stringify(invocationMetadata)).not.toContain(graphAssignment.instruction);
  });
});
