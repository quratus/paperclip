import { describe, expect, it } from "vitest";
import { resolvePipelineGraphWakeDispatchBatchSize } from "../config.js";

describe("pipeline graph wake dispatch config", () => {
  it("defaults to two and cannot expand beyond the v0.5 concurrency boundary", () => {
    expect(resolvePipelineGraphWakeDispatchBatchSize(undefined)).toBe(2);
    expect(resolvePipelineGraphWakeDispatchBatchSize("1")).toBe(1);
    expect(resolvePipelineGraphWakeDispatchBatchSize("2")).toBe(2);
    expect(resolvePipelineGraphWakeDispatchBatchSize("10")).toBe(2);
    expect(resolvePipelineGraphWakeDispatchBatchSize("100")).toBe(2);
  });
});
