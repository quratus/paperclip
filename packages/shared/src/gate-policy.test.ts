import { describe, expect, it } from "vitest";
import { classifyGate } from "./gate-policy.js";

describe("classifyGate", () => {
  // batched_escalate: only irreversible + high, regardless of waitCondition
  it("irreversible + high → batched_escalate (no waitCondition)", () => {
    expect(classifyGate({ reversibility: "irreversible", impact: "high" })).toBe("batched_escalate");
  });

  it("irreversible + high + waitCondition → batched_escalate (one-way door wins)", () => {
    expect(classifyGate({ reversibility: "irreversible", impact: "high", waitCondition: "2026-08-01" })).toBe("batched_escalate");
  });

  // auto_clearing: not the one-way door, but has a waitCondition
  it("irreversible + low + waitCondition → auto_clearing", () => {
    expect(classifyGate({ reversibility: "irreversible", impact: "low", waitCondition: "issue-id-123" })).toBe("auto_clearing");
  });

  it("reversible + high + waitCondition → auto_clearing", () => {
    expect(classifyGate({ reversibility: "reversible", impact: "high", waitCondition: "2026-08-01" })).toBe("auto_clearing");
  });

  it("reversible + low + waitCondition → auto_clearing", () => {
    expect(classifyGate({ reversibility: "reversible", impact: "low", waitCondition: "blocker-id" })).toBe("auto_clearing");
  });

  // ungated: not one-way door, no waitCondition
  it("irreversible + low, no waitCondition → ungated", () => {
    expect(classifyGate({ reversibility: "irreversible", impact: "low" })).toBe("ungated");
  });

  it("reversible + high, no waitCondition → ungated", () => {
    expect(classifyGate({ reversibility: "reversible", impact: "high" })).toBe("ungated");
  });

  it("reversible + low, no waitCondition → ungated", () => {
    expect(classifyGate({ reversibility: "reversible", impact: "low" })).toBe("ungated");
  });

  // edge cases: null/undefined fields and empty waitCondition treated as absent
  it("null reversibility + null impact → ungated", () => {
    expect(classifyGate({ reversibility: null, impact: null })).toBe("ungated");
  });

  it("empty string waitCondition treated as absent → ungated", () => {
    expect(classifyGate({ reversibility: "reversible", impact: "low", waitCondition: "" })).toBe("ungated");
  });

  it("null waitCondition treated as absent → ungated", () => {
    expect(classifyGate({ reversibility: "reversible", impact: "low", waitCondition: null })).toBe("ungated");
  });
});
