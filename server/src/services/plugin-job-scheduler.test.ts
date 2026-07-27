import { describe, expect, it, vi } from "vitest";
import {
  createPluginJobScheduler,
  resolveJobCompanyBatches,
} from "./plugin-job-scheduler.js";

describe("company-scoped plugin job routing", () => {
  it("fans company jobs across configured companies and keeps instance jobs singular", () => {
    const result = resolveJobCompanyBatches([
      { id: "company-job", pluginId: "plugin-a", scope: "company", companyCursor: null },
      { id: "instance-job", pluginId: "plugin-a", scope: "instance", companyCursor: null },
      { id: "unconfigured-job", pluginId: "plugin-b", scope: "company", companyCursor: null },
    ], [
      { pluginId: "plugin-a", companyId: "company-1" },
      { pluginId: "plugin-a", companyId: "company-2" },
    ], 50);

    expect(result.get("company-job")).toEqual({
      companyIds: ["company-1", "company-2"],
      nextCursor: null,
    });
    expect(result.get("instance-job")).toEqual({ companyIds: [null], nextCursor: null });
    expect(result.get("unconfigured-job")).toEqual({ companyIds: [], nextCursor: null });
  });

  it("bounds and deterministically resumes company fanout without duplicates", () => {
    const rows = ["company-3", "company-1", "company-4", "company-2"]
      .map((companyId) => ({ pluginId: "plugin-a", companyId }));
    const first = resolveJobCompanyBatches([
      { id: "job", pluginId: "plugin-a", scope: "company", companyCursor: null },
    ], rows, 2).get("job");
    const second = resolveJobCompanyBatches([
      {
        id: "job",
        pluginId: "plugin-a",
        scope: "company",
        companyCursor: first?.nextCursor ?? null,
      },
    ], rows, 2).get("job");

    expect(first).toEqual({
      companyIds: ["company-1", "company-2"],
      nextCursor: "company-2",
    });
    expect(second).toEqual({
      companyIds: ["company-3", "company-4"],
      nextCursor: null,
    });
  });

  it("dispatches only the bounded batch per tick and persists its cursor", async () => {
    const job = {
      id: "job",
      pluginId: "plugin-a",
      jobKey: "sync",
      schedule: "* * * * *",
      scope: "company",
      companyCursor: null as string | null,
      status: "active",
      nextRunAt: new Date(0),
    };
    const rows = ["company-4", "company-2", "company-1", "company-3"]
      .map((companyId) => ({ pluginId: "plugin-a", companyId }));
    let selectCount = 0;
    const cursorUpdates: Array<string | null> = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => selectCount++ % 2 === 0 ? [job] : rows),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: { companyCursor: string | null }) => {
          job.companyCursor = values.companyCursor;
          cursorUpdates.push(values.companyCursor);
          return { where: vi.fn(async () => undefined) };
        }),
      })),
    };
    const createRun = vi.fn(async ({ companyId }: { companyId: string }) => ({
      id: `run-${companyId}`,
    }));
    const call = vi.fn(async () => undefined);
    const scheduler = createPluginJobScheduler({
      db: db as never,
      jobStore: {
        createRun,
        markRunning: vi.fn(async () => undefined),
        completeRun: vi.fn(async () => undefined),
        updateRunTimestamps: vi.fn(async () => undefined),
      } as never,
      workerManager: { isRunning: () => true, call } as never,
      maxCompaniesPerJobTick: 2,
    });

    await scheduler.tick();
    expect(createRun.mock.calls.map(([input]) => input.companyId))
      .toEqual(["company-1", "company-2"]);
    expect(cursorUpdates).toEqual(["company-2"]);

    await scheduler.tick();
    expect(createRun.mock.calls.map(([input]) => input.companyId))
      .toEqual(["company-1", "company-2", "company-3", "company-4"]);
    expect(cursorUpdates).toEqual(["company-2", null]);
    expect(call).toHaveBeenCalledTimes(4);
  });
});
