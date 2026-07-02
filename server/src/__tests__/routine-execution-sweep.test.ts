import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  issueComments,
  issues,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { closeStaleRoutineExecutionIssues } from "../services/routine-execution-sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping routine execution sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine-execution-sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-execution-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertIssue(companyId: string, status: string, createdAt: Date) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "test routine execution",
      status,
      priority: "medium",
      originKind: "routine_execution",
      createdByUserId: "user-1",
      createdAt,
      updatedAt: createdAt,
    });
    return id;
  }

  it("closes stale open routine_execution issue and inserts comment", async () => {
    const companyId = await seedCompany();
    const staleDate = new Date(Date.now() - 49 * 60 * 60 * 1_000);
    const issueId = await insertIssue(companyId, "todo", staleDate);

    const count = await closeStaleRoutineExecutionIssues(db);

    expect(count).toBe(1);
    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.status).toBe("cancelled");
    expect(updated.cancelledAt).not.toBeNull();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("auto-closed: routine execution stale >48h, no terminal transition");
  });

  it("leaves recent open routine_execution issue untouched", async () => {
    const companyId = await seedCompany();
    const issueId = await insertIssue(companyId, "todo", new Date(Date.now() - 60 * 60 * 1_000));

    const count = await closeStaleRoutineExecutionIssues(db);

    expect(count).toBe(0);
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("leaves terminal routine_execution issue untouched even when stale", async () => {
    const companyId = await seedCompany();
    const issueId = await insertIssue(companyId, "done", new Date(Date.now() - 49 * 60 * 60 * 1_000));

    const count = await closeStaleRoutineExecutionIssues(db);

    expect(count).toBe(0);
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row.status).toBe("done");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });
});
