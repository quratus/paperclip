import { describe, expect, it } from "vitest";
import { findBlockedStateRegressions, hasTypedExternalBlocker } from "../../../scripts/blocked-state-watchdog.mjs";

describe("blocked-state-watchdog", () => {
  it("reports blocked issues with no machine-readable blocker", () => {
    const findings = findBlockedStateRegressions([
      { id: "issue-1", identifier: "SQN-1", status: "blocked", title: "Stuck", blockedBy: [] },
    ]);

    expect(findings).toEqual([{
      kind: "untyped_blocked_issue",
      issueId: "issue-1",
      identifier: "SQN-1",
      title: "Stuck",
    }]);
  });

  it("accepts typed external blockers", () => {
    expect(hasTypedExternalBlocker({
      type: "vendor_response",
      owner: "Vendor support",
      recheckDate: "2026-07-24T00:00:00.000Z",
    })).toBe(true);

    expect(findBlockedStateRegressions([
      {
        id: "issue-1",
        identifier: "SQN-1",
        status: "blocked",
        blockedBy: [],
        blockedByExternal: {
          type: "vendor_response",
          owner: "Vendor support",
          recheckDate: "2026-07-24T00:00:00.000Z",
        },
      },
    ])).toEqual([]);
  });

  it("reports a blocked issue whose dedicated approval blocker is already decided", () => {
    const approvalsById = new Map([
      ["approval-1", { id: "approval-1", status: "approved" }],
    ]);

    expect(findBlockedStateRegressions([
      { id: "issue-1", identifier: "SQN-1", status: "blocked", blockedBy: [], blockedByApprovalId: "approval-1" },
    ], approvalsById)).toEqual([{
      kind: "decided_approval_blocker",
      issueId: "issue-1",
      identifier: "SQN-1",
      approvalId: "approval-1",
      approvalStatus: "approved",
    }]);
  });

  it("does not treat an ordinary approval link as a blocker", () => {
    expect(findBlockedStateRegressions([
      { id: "issue-1", identifier: "SQN-1", status: "blocked", blockedBy: [] },
    ], new Map([["approval-1", { id: "approval-1", status: "pending" }]]))).toEqual([{
      kind: "untyped_blocked_issue",
      issueId: "issue-1",
      identifier: "SQN-1",
      title: null,
    }]);
  });
});
