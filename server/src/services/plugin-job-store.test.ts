import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, pluginJobRuns, pluginJobs, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { pluginJobStore } from "./plugin-job-store.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("company-scoped plugin job persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-company-jobs-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("defaults old declarations to instance and attributes company runs", async () => {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", issuePrefix: "ACM" });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.company-jobs-test",
      packageName: "paperclip.company-jobs-test",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["connector"],
      manifestJson: {
        id: "paperclip.company-jobs-test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Company jobs test",
        description: "Company-scoped job persistence fixture.",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: ["jobs.schedule"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    const store = pluginJobStore(db);
    await store.syncJobDeclarations(pluginId, [
      { jobKey: "instance", displayName: "Instance", schedule: "* * * * *" },
      { jobKey: "company", displayName: "Company", schedule: "* * * * *", scope: "company" },
    ]);

    expect((await db.select().from(pluginJobs)).map(({ jobKey, scope }) => ({ jobKey, scope })))
      .toEqual(expect.arrayContaining([
        { jobKey: "instance", scope: "instance" },
        { jobKey: "company", scope: "company" },
      ]));
    const companyJob = (await db.select().from(pluginJobs)).find((job) => job.jobKey === "company")!;
    await store.createRun({ jobId: companyJob.id, pluginId, companyId, trigger: "schedule" });
    expect((await db.select().from(pluginJobRuns))[0]?.companyId).toBe(companyId);
  });
});
