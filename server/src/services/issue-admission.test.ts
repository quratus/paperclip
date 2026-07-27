import { describe, expect, it } from "vitest";
import { evaluateIssueAdmission } from "./issue-admission.js";

const reviewPolicy = {
  workClass: "backend",
  stages: [{
    type: "review",
    participants: [{ type: "agent", agentId: "11111111-1111-4111-8111-111111111111" }],
  }],
};

describe("evaluateIssueAdmission", () => {
  it("allows product work with a truth contract and review chain", () => {
    expect(evaluateIssueAdmission({
      issue: {
        id: "issue-1",
        description: "## Product Truth Contract\nA real contract.",
        executionPolicy: reviewPolicy,
      },
      source: "checkout",
      actorType: "agent",
    })).toEqual({ kind: "allow" });
  });

  it("returns a typed redirect instead of a generic refusal", () => {
    expect(evaluateIssueAdmission({
      issue: { id: "issue-1", description: "Build it", executionPolicy: null },
      source: "checkout",
      actorType: "agent",
    })).toEqual({
      kind: "redirect",
      code: "missing_product_truth_contract",
      issueId: "issue-1",
      source: "checkout",
      requiredResponsibility: "issue_refinement",
      routingPolicy: "manager_chain_v1",
      resolverVersion: 1,
      missing: [
        "executionPolicy.workClass",
        "## Product Truth Contract",
        "executionPolicy.stages",
      ],
      validWorkClasses: ["product_ui", "backend", "security", "docs_ops"],
    });
  });

  it("keeps the board override and docs-only exemption", () => {
    expect(evaluateIssueAdmission({
      issue: { id: "issue-1" },
      source: "status_transition",
      actorType: "board",
    })).toEqual({ kind: "allow" });
    expect(evaluateIssueAdmission({
      issue: { id: "issue-2", executionPolicy: { workClass: "docs_ops", stages: [] } },
      source: "assignment",
      actorType: "agent",
    })).toEqual({ kind: "allow" });
  });

  it("evaluates proposed values during a patch", () => {
    expect(evaluateIssueAdmission({
      issue: { id: "issue-1", description: "old", executionPolicy: null },
      nextDescription: "## Product Truth Contract\nnew",
      nextExecutionPolicy: reviewPolicy,
      source: "status_transition",
      actorType: "agent",
    })).toEqual({ kind: "allow" });
  });
});
