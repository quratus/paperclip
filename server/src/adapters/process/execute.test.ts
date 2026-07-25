import { describe, expect, it } from "vitest";
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
});
