import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, goals } from "@paperclipai/db";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("goalService deterministic creation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Paperclip",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("coalesces concurrent creates with the same caller-supplied UUID", async () => {
    const companyId = await seedCompany();
    const id = randomUUID();
    const svc = goalService(db);
    const results = await Promise.all([
      svc.create(companyId, { id, title: "Mission", status: "planned" }),
      svc.create(companyId, { id, title: "Mission", status: "planned" }),
    ]);
    expect(results.map((goal) => goal.id)).toEqual([id, id]);
    expect(await db.select().from(goals)).toHaveLength(1);
  });

  it("does not leak or reuse the same UUID across companies", async () => {
    const firstCompanyId = await seedCompany();
    const secondCompanyId = await seedCompany();
    const id = randomUUID();
    const svc = goalService(db);
    await svc.create(firstCompanyId, { id, title: "Private mission" });
    await expect(svc.create(secondCompanyId, { id, title: "Collision" }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("validates caller-supplied ids at the shared API edge", () => {
    expect(createGoalSchema.safeParse({ id: "not-a-uuid", title: "Mission" }).success).toBe(false);
    expect(updateGoalSchema.parse({ id: randomUUID(), title: "Renamed" })).toEqual({ title: "Renamed" });
  });
});
