import { describe, expect, it } from "vitest";
import { plateauDetector, runVerifier } from "./stuck-detector.js";

describe("plateauDetector", () => {
  it("does not flag below the iteration threshold", () => {
    expect(
      plateauDetector({
        iterationSignatures: ["state:a", "state:a"],
        maxPlateauIterations: 3,
      }),
    ).toEqual({ isStuck: false, reason: null });
  });

  it("does not flag healthy progress", () => {
    expect(
      plateauDetector({
        iterationSignatures: ["state:a", "state:b", "state:c"],
        maxPlateauIterations: 3,
      }),
    ).toEqual({ isStuck: false, reason: null });
  });

  it("flags a no-state-change plateau", () => {
    expect(
      plateauDetector({
        iterationSignatures: ["state:a", "state:b", "state:b", "state:b"],
        maxPlateauIterations: 3,
      }),
    ).toEqual({ isStuck: true, reason: "no_state_change" });
  });

  it("flags a repeating error plateau", () => {
    expect(
      plateauDetector({
        iterationSignatures: ["state:a", "error:timeout", "error:timeout", "error:timeout"],
        maxPlateauIterations: 3,
      }),
    ).toEqual({ isStuck: true, reason: "repeating_error" });
  });
});

describe("runVerifier", () => {
  it("returns verified=true for a passing test command", async () => {
    await expect(
      runVerifier("test_pass_fail", {
        command: process.execPath,
        args: ["-e", "console.log('pass')"],
      }),
    ).resolves.toEqual({ verified: true, method: "test_pass_fail", evidence: "pass" });
  });

  it("returns verified=false for a failing test command", async () => {
    const result = await runVerifier("test_pass_fail", {
      command: process.execPath,
      args: ["-e", "console.error('fail'); process.exit(1)"],
    });

    expect(result.verified).toBe(false);
    expect(result.method).toBe("test_pass_fail");
    expect(result.evidence).toContain("fail");
  });

  it("returns verified=false for an observed failing process outcome", async () => {
    await expect(
      runVerifier("test_pass_fail", {
        exitCode: 1,
        evidence: "failed:process_lost",
      }),
    ).resolves.toEqual({ verified: false, method: "test_pass_fail", evidence: "failed:process_lost" });
  });

  it("does not implement second_model verifier yet", async () => {
    await expect(
      runVerifier("second_model", {
        command: process.execPath,
      }),
    ).rejects.toThrow("second_model verifier is not implemented");
  });

  it("does not implement human_legible_diff verifier yet", async () => {
    await expect(
      runVerifier("human_legible_diff", {
        command: process.execPath,
      }),
    ).rejects.toThrow("human_legible_diff verifier is not implemented");
  });
});
