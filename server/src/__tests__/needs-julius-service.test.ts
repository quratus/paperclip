import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues, labels, issueLabels } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { needsJulius } from "../services/needs-julius.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres needs-julius tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OWNER = "local-board";

describeEmbeddedPostgres("needsJulius detection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-needs-julius-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "SQNCR",
      issuePrefix: "SQN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  it("returns mention + parked items oldest-first and excludes owner-resolved asks", async () => {
    await seedCompanyAndAgent();

    const mentionIssueId = randomUUID();
    const parkedIssueId = randomUUID();
    const resolvedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: mentionIssueId,
        companyId,
        title: "Mention ask",
        identifier: "SQN-1",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-06-01T08:00:00.000Z"),
      },
      {
        id: parkedIssueId,
        companyId,
        title: "Parked on Julius",
        identifier: "SQN-2",
        status: "in_review",
        priority: "high",
        assigneeUserId: OWNER,
        updatedAt: new Date("2026-06-02T08:00:00.000Z"),
      },
      {
        id: resolvedIssueId,
        companyId,
        title: "Already answered",
        identifier: "SQN-3",
        status: "todo",
        priority: "low",
        updatedAt: new Date("2026-05-29T08:00:00.000Z"),
      },
    ]);

    const mentionCommentId = randomUUID();
    await db.insert(issueComments).values([
      {
        id: mentionCommentId,
        companyId,
        issueId: mentionIssueId,
        authorAgentId: agentId,
        body: "Hey @local-board, can you confirm the rollout window?",
        createdAt: new Date("2026-06-01T09:00:00.000Z"),
      },
      // resolved: an agent pings the owner, then the owner replies later -> filtered out.
      {
        id: randomUUID(),
        companyId,
        issueId: resolvedIssueId,
        authorAgentId: agentId,
        body: "@local-board please decide",
        createdAt: new Date("2026-05-30T09:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        issueId: resolvedIssueId,
        authorUserId: OWNER,
        body: "Done — go ahead.",
        createdAt: new Date("2026-05-31T09:00:00.000Z"),
      },
    ]);

    const result = await needsJulius(db, companyId, OWNER);

    expect(result.map((r) => r.issueId)).toEqual([mentionIssueId, parkedIssueId]);

    expect(result[0]).toMatchObject({
      issueId: mentionIssueId,
      reason: "mention",
      commentId: mentionCommentId,
      triggerAt: "2026-06-01T09:00:00.000Z",
    });
    expect(result[0]?.snippet).toContain("rollout window");

    expect(result[1]).toMatchObject({
      issueId: parkedIssueId,
      reason: "parked",
      commentId: null,
      snippet: null,
      triggerAt: "2026-06-02T08:00:00.000Z",
    });

    expect(result.some((r) => r.issueId === resolvedIssueId)).toBe(false);
  });

  it("labeled-surfaces: issue tagged needs-julius surfaces with reason=labeled", async () => {
    await seedCompanyAndAgent();

    const labeledIssueId = randomUUID();
    const labelId = randomUUID();
    const labelAppliedAt = new Date("2026-06-20T10:00:00.000Z");

    await db.insert(issues).values({
      id: labeledIssueId,
      companyId,
      title: "Needs Julius label test",
      identifier: "SQN-20",
      status: "todo",
      priority: "medium",
      updatedAt: new Date("2026-06-19T08:00:00.000Z"),
    });
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "needs-julius",
      color: "#ff0000",
    });
    await db.insert(issueLabels).values({
      issueId: labeledIssueId,
      labelId,
      companyId,
      createdAt: labelAppliedAt,
    });

    const result = await needsJulius(db, companyId, OWNER);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      issueId: labeledIssueId,
      reason: "labeled",
      commentId: null,
      snippet: null,
    });
  });

  it("labeled-clears: issue auto-clears when Julius replies after label applied", async () => {
    await seedCompanyAndAgent();

    const labeledIssueId = randomUUID();
    const labelId = randomUUID();
    const labelAppliedAt = new Date("2026-06-20T10:00:00.000Z");

    await db.insert(issues).values({
      id: labeledIssueId,
      companyId,
      title: "Labeled but answered",
      identifier: "SQN-21",
      status: "todo",
      priority: "low",
      updatedAt: new Date("2026-06-19T08:00:00.000Z"),
    });
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "needs-julius",
      color: "#ff0000",
    });
    await db.insert(issueLabels).values({
      issueId: labeledIssueId,
      labelId,
      companyId,
      createdAt: labelAppliedAt,
    });
    // Julius replies after the label was applied — should clear the item.
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: labeledIssueId,
      authorUserId: OWNER,
      body: "On it.",
      createdAt: new Date("2026-06-20T11:00:00.000Z"),
    });

    const result = await needsJulius(db, companyId, OWNER);
    expect(result.some((r) => r.issueId === labeledIssueId)).toBe(false);
  });

  it("flags a blocked issue assigned to the owner", async () => {
    await seedCompanyAndAgent();

    const blockedIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Blocked on owner",
      identifier: "SQN-9",
      status: "blocked",
      priority: "urgent",
      assigneeUserId: OWNER,
      updatedAt: new Date("2026-06-04T08:00:00.000Z"),
    });

    const result = await needsJulius(db, companyId, OWNER);
    expect(result).toHaveLength(1);
    // parked + blocked both match; oldest triggerAt wins (here both use updatedAt).
    expect(result[0]).toMatchObject({ issueId: blockedIssueId });
    expect(["parked", "blocked"]).toContain(result[0]?.reason);
  });
});
