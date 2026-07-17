import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAcpxSessionInitFailures } from "../acpx-session-init-failure-monitor.mjs";

const now = new Date("2026-07-13T12:00:00.000Z");

function run(minutesAgo, overrides = {}) {
  const at = new Date(now.getTime() - minutesAgo * 60 * 1000).toISOString();
  return {
    id: `run-${minutesAgo}`,
    status: "failed",
    startedAt: at,
    createdAt: at,
    errorCode: null,
    error: null,
    resultJson: null,
    ...overrides,
  };
}

test("alerts when acpx_session_init_failed is above 20 percent for more than one hour", () => {
  const runs = [
    run(10, { errorCode: "acpx_session_init_failed", error: "spawn failed" }),
    run(90, { resultJson: { error: "acpx_session_init_failed wrapper missing" } }),
    run(120),
    run(130),
    run(140),
  ];

  const result = evaluateAcpxSessionInitFailures(runs, { now });

  assert.equal(result.totalRuns, 5);
  assert.equal(result.failedCount, 2);
  assert.equal(result.shouldAlert, true);
  assert.equal(result.suppressedTransient, false);
  assert.equal(result.sampleErrorMessage, "spawn failed");
});

test("suppresses transient spikes when the failure window is under one hour", () => {
  const runs = [
    run(10, { errorCode: "acpx_session_init_failed" }),
    run(20, { resultJson: { message: "acpx_session_init_failed" } }),
    run(120),
    run(130),
    run(140),
  ];

  const result = evaluateAcpxSessionInitFailures(runs, { now });

  assert.equal(result.failedCount, 2);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.suppressedTransient, true);
});

test("resolves when the rate drops below five percent", () => {
  const runs = [
    run(10, { errorCode: "acpx_session_init_failed" }),
    ...Array.from({ length: 30 }, (_, index) => run(20 + index, { status: "succeeded" })),
  ];

  const result = evaluateAcpxSessionInitFailures(runs, { now });

  assert.equal(result.totalRuns, 31);
  assert.equal(result.failedCount, 1);
  assert.equal(result.shouldResolve, true);
  assert.equal(result.shouldAlert, false);
});
