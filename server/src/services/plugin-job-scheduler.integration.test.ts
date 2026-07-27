import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyPendingMigrations,
  companies,
  createDb,
  pluginConfig,
  pluginJobRuns,
  pluginJobs,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";
import { pluginJobStore } from "./plugin-job-store.js";

const externalUrl = process.env.PAPERCLIP_COMPANY_JOB_TEST_DATABASE_URL;
const embeddedSupport = externalUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describeDb("company-scoped scheduler persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      db = createDb(externalUrl);
      return;
    }
    database = await startEmbeddedPostgresTestDatabase("paperclip-company-scheduler-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("persists a due cursor, drains the next batch, then returns to cron", async () => {
    const pluginId = randomUUID();
    const companyIds = Array.from({ length: 4 }, () => randomUUID()).sort();
    await db.insert(companies).values(companyIds.map((id, index) => ({
      id,
      name: `Company ${index}`,
      issuePrefix: `CJ${index}`,
    })));
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.scheduler-integration",
      packageName: "paperclip.scheduler-integration",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["connector"],
      manifestJson: {
        id: "paperclip.scheduler-integration",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Scheduler integration",
        description: "Company-scoped scheduler persistence fixture.",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: ["jobs.schedule"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginConfig).values(companyIds.map((companyId) => ({
      pluginId,
      companyId,
      configJson: {},
    })));

    const store = pluginJobStore(db);
    await store.syncJobDeclarations(pluginId, [{
      jobKey: "sync",
      displayName: "Sync",
      schedule: "* * * * *",
      scope: "company",
    }]);
    const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    await db.update(pluginJobs).set({ nextRunAt: new Date(0) }).where(eq(pluginJobs.id, job!.id));
    const call = vi.fn(async () => undefined);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: store,
      workerManager: { isRunning: () => true, call } as never,
      maxCompaniesPerJobTick: 2,
    });

    await scheduler.tick();
    let runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, job!.id));
    let [persistedJob] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, job!.id));
    expect(runs.map((run) => run.companyId).sort()).toEqual(companyIds.slice(0, 2));
    expect(persistedJob?.companyCursor).toBe(companyIds[1]);
    expect(persistedJob!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());

    await scheduler.tick();
    runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, job!.id));
    [persistedJob] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, job!.id));
    expect(runs.map((run) => run.companyId).sort()).toEqual(companyIds);
    expect(persistedJob?.companyCursor).toBeNull();
    expect(persistedJob!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    await scheduler.tick();
    expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, job!.id)))
      .toHaveLength(4);
  }, 20_000);
});
