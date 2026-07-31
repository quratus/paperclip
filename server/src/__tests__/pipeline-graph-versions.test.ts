import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  pipelineCases,
  pipelineCaseIssueLinks,
  pipelineCaseEvents,
  pipelineGraphAdoptions,
  pipelineGraphEffectAttempts,
  pipelineGraphRunEvents,
  pipelineGraphRuns,
  pipelineGraphWakeOutbox,
  pipelineGraphVersions,
  pipelineStages,
  pipelineTransitions,
  pipelines,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import {
  decodePipelineGraphVersionCursor,
  pipelineGraphVersionService,
} from "../services/pipeline-graph-versions.js";
import {
  decodePipelineGraphRunCursor,
  graphReconciliationIssueStateHash,
  pipelineGraphRunService,
  resolveGraphTransitionAssignmentAuthorization,
} from "../services/pipeline-graph-runs.js";
import { pipelineGraphOutboxService } from "../services/pipeline-graph-outbox.js";
import {
  pipelineGraphEffectService,
  pipelineGraphEffectActionHash,
  pipelineGraphExecutorAttestationMessage,
  pipelineGraphEffectSubjectHash,
  pipelineGraphEffectTargetRefHash,
} from "../services/pipeline-graph-effects.js";
import { pipelineService } from "../services/pipelines.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("pipeline graph versions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-graph-versions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(pipelineGraphWakeOutbox);
    await db.delete(pipelineGraphEffectAttempts);
    await db.delete(pipelineGraphRunEvents);
    await db.delete(pipelineGraphRuns);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(issues);
    await db.delete(pipelineCases);
    await db.delete(pipelineGraphAdoptions);
    await db.delete(pipelineGraphVersions);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLinearPipeline(companyId?: string) {
    const [company] = companyId
      ? [null]
      : await db.insert(companies).values({
          name: "Graph Co",
          issuePrefix: `G${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
        }).returning();
    const resolvedCompanyId = companyId ?? company!.id;
    const [pipeline] = await db.insert(pipelines).values({
      companyId: resolvedCompanyId,
      key: `graph-${randomUUID().slice(0, 8)}`,
      name: "Graph pipeline",
    }).returning();
    const stages = await db.insert(pipelineStages).values([
      {
        pipelineId: pipeline!.id,
        key: "work",
        name: "Work",
        kind: "working",
        position: 100,
      },
      {
        pipelineId: pipeline!.id,
        key: "done",
        name: "Done",
        kind: "done",
        position: 200,
      },
    ]).returning();
    await db.insert(pipelineTransitions).values({
      pipelineId: pipeline!.id,
      fromStageId: stages.find((stage) => stage.key === "work")!.id,
      toStageId: stages.find((stage) => stage.key === "done")!.id,
      label: "complete",
    });
    return { company: company!, companyId: resolvedCompanyId, pipeline: pipeline!, stages };
  }

  async function seedReviewedPipeline() {
    const [company] = await db.insert(companies).values({
      name: "Reviewed Graph Co",
      issuePrefix: `R${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const [pipeline] = await db.insert(pipelines).values({
      companyId: company!.id,
      key: `reviewed-${randomUUID().slice(0, 8)}`,
      name: "Reviewed graph pipeline",
    }).returning();
    const stages = await db.insert(pipelineStages).values([
      {
        pipelineId: pipeline!.id,
        key: "work",
        name: "Work",
        kind: "working",
        position: 100,
      },
      {
        pipelineId: pipeline!.id,
        key: "review",
        name: "Review",
        kind: "review",
        position: 200,
        config: {
          requireApproval: true,
          approver: { kind: "any_human" },
          approveToStageKey: "done",
          rejectToStageKey: "work",
        },
      },
      {
        pipelineId: pipeline!.id,
        key: "done",
        name: "Done",
        kind: "done",
        position: 300,
      },
    ]).returning();
    const byKey = new Map(stages.map((stage) => [stage.key, stage]));
    await db.insert(pipelineTransitions).values([
      {
        pipelineId: pipeline!.id,
        fromStageId: byKey.get("work")!.id,
        toStageId: byKey.get("review")!.id,
        label: "complete",
      },
      {
        pipelineId: pipeline!.id,
        fromStageId: byKey.get("review")!.id,
        toStageId: byKey.get("done")!.id,
        label: "approve",
      },
    ]);
    return { company: company!, companyId: company!.id, pipeline: pipeline!, stages };
  }

  const linearDefinition = {
    entryNodeKey: "work",
    nodes: [
      { key: "work", name: "Work", kind: "working" as const, position: 100 },
      { key: "done", name: "Done", kind: "done" as const, position: 200 },
    ],
    edges: [{ fromNodeKey: "work", toNodeKey: "done", outcome: "complete" }],
  };

  const reviewedDefinition = {
    entryNodeKey: "work",
    nodes: [
      { key: "work", name: "Work", kind: "working" as const, position: 100 },
      { key: "review", name: "Review", kind: "review" as const, position: 200 },
      { key: "done", name: "Done", kind: "done" as const, position: 300 },
    ],
    edges: [
      { fromNodeKey: "work", toNodeKey: "review", outcome: "complete" },
      { fromNodeKey: "review", toNodeKey: "done", outcome: "approve" },
    ],
  };

  it("atomically adopts an immutable definition with durable replay and no execution wake", async () => {
    const fixture = await seedLinearPipeline();
    const service = pipelineGraphVersionService(db);
    const input = {
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: linearDefinition,
      expectedActiveVersionId: null,
      expectedActiveDefinitionHash: null,
      idempotencyKey: "adopt-linear-v1",
      actor: { type: "user" as const, userId: "board-user" },
    };

    const adopted = await service.adoptDefinition(input);
    expect(adopted).toMatchObject({
      changed: true,
      restored: false,
      replayed: false,
      wakeBehavior: "none",
      version: { status: "active", version: 1 },
    });

    const replayed = await service.adoptDefinition(input);
    expect(replayed).toMatchObject({
      adoptionId: adopted.adoptionId,
      changed: true,
      restored: false,
      replayed: true,
      wakeBehavior: "none",
      version: { id: adopted.version.id },
    });

    expect(await db.select().from(pipelineGraphAdoptions)).toHaveLength(1);
    expect(
      await db.select().from(activityLog)
        .where(eq(activityLog.action, "pipeline.graph_definition_adopted")),
    ).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(pipelineGraphRuns)).toHaveLength(0);
    expect(await db.select().from(pipelineGraphRunEvents)).toHaveLength(0);
    expect(await db.select().from(pipelineGraphWakeOutbox)).toHaveLength(0);
  });

  it("fences stale callers and rejects idempotency drift without partial graph changes", async () => {
    const fixture = await seedLinearPipeline();
    const service = pipelineGraphVersionService(db);
    const actor = { type: "user" as const, userId: "board-user" };
    const [otherCompany] = await db.insert(companies).values({
      name: "Other Graph Co",
      issuePrefix: `O${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const [otherAgent] = await db.insert(agents).values({
      companyId: otherCompany!.id,
      name: "Other Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [terminatedAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Terminated Agent",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    for (const [targetAgentId, code] of [
      ["not-a-uuid", "pipeline_graph_target_agent_invalid"],
      [terminatedAgent!.id, "pipeline_graph_target_agent_ineligible"],
    ] as const) {
      await expect(service.adoptDefinition({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        definition: {
          ...linearDefinition,
          nodes: linearDefinition.nodes.map((node) => node.key === "work"
            ? { ...node, config: { dispatchEnabled: true, targetAgentId } }
            : node),
        },
        expectedActiveVersionId: null,
        expectedActiveDefinitionHash: null,
        idempotencyKey: `invalid-target:${targetAgentId}`,
        actor,
      })).rejects.toMatchObject({ status: 422, details: { code } });
    }
    await expect(service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: {
        ...linearDefinition,
        nodes: linearDefinition.nodes.map((node) => node.key === "work"
          ? { ...node, config: { dispatchEnabled: true, targetAgentId: otherAgent!.id } }
          : node),
      },
      expectedActiveVersionId: null,
      expectedActiveDefinitionHash: null,
      idempotencyKey: "cross-company-target",
      actor,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "pipeline_graph_target_agent_company_mismatch" },
    });
    expect(await db.select().from(pipelineGraphVersions)).toHaveLength(0);

    const first = await service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: linearDefinition,
      expectedActiveVersionId: null,
      expectedActiveDefinitionHash: null,
      idempotencyKey: "adopt-first",
      actor,
    });

    await expect(service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: reviewedDefinition,
      expectedActiveVersionId: null,
      expectedActiveDefinitionHash: null,
      idempotencyKey: "stale-plan",
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "pipeline_graph_adoption_conflict" },
    });
    await expect(service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: reviewedDefinition,
      expectedActiveVersionId: null,
      expectedActiveDefinitionHash: null,
      idempotencyKey: "adopt-first",
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "pipeline_graph_adoption_idempotency_conflict" },
    });

    const versions = await db.select().from(pipelineGraphVersions);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ id: first.version.id, status: "active" });
    expect(await db.select().from(pipelineGraphAdoptions)).toHaveLength(1);
  });

  it("restores an earlier immutable version and records no-op adoptions", async () => {
    const fixture = await seedLinearPipeline();
    const service = pipelineGraphVersionService(db);
    const actor = { type: "user" as const, userId: "board-user" };
    const first = await service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: linearDefinition,
      expectedActiveVersionId: null,
      expectedActiveDefinitionHash: null,
      idempotencyKey: "adopt-a",
      actor,
    });
    const noOp = await service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: linearDefinition,
      expectedActiveVersionId: first.version.id,
      expectedActiveDefinitionHash: first.version.definitionHash,
      idempotencyKey: "confirm-a",
      actor,
    });
    expect(noOp).toMatchObject({
      changed: false,
      restored: false,
      version: { id: first.version.id },
    });

    const second = await service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: reviewedDefinition,
      expectedActiveVersionId: first.version.id,
      expectedActiveDefinitionHash: first.version.definitionHash,
      idempotencyKey: "adopt-b",
      actor,
    });
    const restored = await service.adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: linearDefinition,
      expectedActiveVersionId: second.version.id,
      expectedActiveDefinitionHash: second.version.definitionHash,
      idempotencyKey: "restore-a",
      actor,
    });
    expect(restored).toMatchObject({
      changed: true,
      restored: true,
      version: { id: first.version.id, status: "active" },
    });
    expect(
      (await db.select().from(pipelineGraphVersions))
        .filter((version) => version.status === "active"),
    ).toHaveLength(1);
  });

  it("rolls adoption back when its audit receipt cannot be completed", async () => {
    const fixture = await seedLinearPipeline();
    const service = pipelineGraphVersionService(db);
    await db.execute(sql`
      CREATE FUNCTION paperclip_test_reject_graph_adoption_activity()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.action = 'pipeline.graph_definition_adopted' THEN
          RAISE EXCEPTION 'forced graph adoption activity failure';
        END IF;
        RETURN NEW;
      END;
      $function$
    `);
    await db.execute(sql`
      CREATE TRIGGER paperclip_test_reject_graph_adoption_activity
      BEFORE INSERT ON activity_log
      FOR EACH ROW
      EXECUTE FUNCTION paperclip_test_reject_graph_adoption_activity()
    `);

    try {
      await expect(service.adoptDefinition({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        definition: linearDefinition,
        expectedActiveVersionId: null,
        expectedActiveDefinitionHash: null,
        idempotencyKey: "audit-failure",
        actor: { type: "user", userId: "board-user" },
      })).rejects.toThrow();
      expect(await db.select().from(pipelineGraphAdoptions)).toHaveLength(0);
      expect(await db.select().from(pipelineGraphVersions)).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER paperclip_test_reject_graph_adoption_activity ON activity_log`);
      await db.execute(sql`DROP FUNCTION paperclip_test_reject_graph_adoption_activity()`);
    }
  });

  it("persists one immutable draft for concurrent identical requests", async () => {
    const fixture = await seedLinearPipeline();
    const service = pipelineGraphVersionService(db);
    const input = {
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user" as const, userId: "board-user" },
    };
    const [left, right] = await Promise.all([
      service.createDraft(input),
      service.createDraft(input),
    ]);

    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.version.id).toBe(right.version.id);
    expect(left.version.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(left.version.version).toBe(1);

    await db.update(pipelineStages)
      .set({ name: "Implementation" })
      .where(eq(pipelineStages.id, fixture.stages[0]!.id));
    const second = await service.createDraft(input);
    expect(second.created).toBe(true);
    expect(second.version.version).toBe(2);

    const firstPage = await service.list({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      limit: 1,
    });
    expect(firstPage.versions.map((version) => version.version)).toEqual([2]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const beforeVersion = decodePipelineGraphVersionCursor(firstPage.nextCursor!);
    expect(beforeVersion).toBe(2);
    const secondPage = await service.list({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      beforeVersion: beforeVersion!,
      limit: 1,
    });
    expect(secondPage.versions.map((version) => version.version)).toEqual([1]);
    expect(secondPage.nextCursor).toBeNull();

    const firstAgain = await service.get({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: left.version.id,
    });
    expect(firstAgain.definition.nodes[0]!.name).toBe("Work");
  });

  it("rejects invalid live topology and hides versions across companies", async () => {
    const fixture = await seedLinearPipeline();
    const [otherCompany] = await db.insert(companies).values({
      name: "Other Co",
      issuePrefix: `O${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const service = pipelineGraphVersionService(db);
    const created = await service.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });

    await expect(service.get({
      companyId: otherCompany!.id,
      pipelineId: fixture.pipeline.id,
      versionId: created.version.id,
    })).rejects.toMatchObject({ status: 404 });

    await expect(db.insert(pipelineGraphVersions).values({
      companyId: otherCompany!.id,
      pipelineId: fixture.pipeline.id,
      version: 2,
      definitionHash: "0".repeat(64),
      schemaVersion: created.version.schemaVersion,
      definition: created.version.definition,
      status: "draft",
      createdByType: "user",
      createdById: "board-user",
    })).rejects.toThrow();
    await expect(db.insert(pipelineCases).values({
      companyId: otherCompany!.id,
      pipelineId: fixture.pipeline.id,
      graphVersionId: created.version.id,
      stageId: fixture.stages[0]!.id,
      caseKey: "cross-company-case",
      title: "Cross-company case",
    })).rejects.toThrow();

    await db.delete(pipelineTransitions);
    await expect(service.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "pipeline_graph_invalid",
      },
    });
  });

  it("rolls graph persistence back when its audit record cannot be written", async () => {
    const fixture = await seedLinearPipeline();
    const service = pipelineGraphVersionService(db);
    await db.execute(sql`
      CREATE FUNCTION paperclip_test_reject_graph_activity()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.action = 'pipeline.graph_version_created' THEN
          RAISE EXCEPTION 'forced graph activity failure';
        END IF;
        RETURN NEW;
      END;
      $function$
    `);
    await db.execute(sql`
      CREATE TRIGGER paperclip_test_reject_graph_activity
      BEFORE INSERT ON activity_log
      FOR EACH ROW
      EXECUTE FUNCTION paperclip_test_reject_graph_activity()
    `);

    try {
      await expect(service.createDraft({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        entryNodeKey: "work",
        actor: { type: "user", userId: "board-user" },
      })).rejects.toThrow();
      const persisted = await db.select().from(pipelineGraphVersions);
      expect(persisted).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER paperclip_test_reject_graph_activity ON activity_log`);
      await db.execute(sql`DROP FUNCTION paperclip_test_reject_graph_activity()`);
    }
  });

  it("rolls activation back when its audit record cannot be written", async () => {
    const fixture = await seedLinearPipeline();
    const service = pipelineGraphVersionService(db);
    const actor = { type: "user" as const, userId: "board-user" };
    const draft = await service.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor,
    });
    await db.execute(sql`
      CREATE FUNCTION paperclip_test_reject_graph_activation_activity()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.action = 'pipeline.graph_version_activated' THEN
          RAISE EXCEPTION 'forced graph activation activity failure';
        END IF;
        RETURN NEW;
      END;
      $function$
    `);
    await db.execute(sql`
      CREATE TRIGGER paperclip_test_reject_graph_activation_activity
      BEFORE INSERT ON activity_log
      FOR EACH ROW
      EXECUTE FUNCTION paperclip_test_reject_graph_activation_activity()
    `);

    try {
      await expect(service.activate({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        versionId: draft.version.id,
        expectedActiveVersionId: null,
        actor,
      })).rejects.toThrow();
      const persisted = await service.get({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        versionId: draft.version.id,
      });
      expect(persisted).toMatchObject({
        status: "draft",
        activatedAt: null,
        activatedById: null,
      });
    } finally {
      await db.execute(sql`DROP TRIGGER paperclip_test_reject_graph_activation_activity ON activity_log`);
      await db.execute(sql`DROP FUNCTION paperclip_test_reject_graph_activation_activity()`);
    }
  });

  it("preserves immutable actor provenance after an authoring agent is deleted", async () => {
    const fixture = await seedLinearPipeline();
    const [agent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Graph Author",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: agent!.id,
      invocationSource: "manual",
      status: "running",
    });
    const service = pipelineGraphVersionService(db);
    const created = await service.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "agent", agentId: agent!.id, runId },
    });

    await db.delete(activityLog).where(eq(activityLog.runId, runId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.delete(agents).where(eq(agents.id, agent!.id));
    const persisted = await service.get({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: created.version.id,
    });
    expect(persisted).toMatchObject({
      createdByType: "agent",
      createdById: agent!.id,
    });
  });

  it("activates one version at a time and pins new cases to their starting version", async () => {
    const fixture = await seedLinearPipeline();
    const versions = pipelineGraphVersionService(db);
    const cases = pipelineService(db);
    const actor = { type: "user" as const, userId: "board-user" };
    const firstDraft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor,
    });
    const firstActivation = await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: firstDraft.version.id,
      expectedActiveVersionId: null,
      actor,
    });
    expect(firstActivation.changed).toBe(true);
    expect(firstActivation.version.status).toBe("active");
    expect(firstActivation.version.activatedAt).toBeInstanceOf(Date);

    await db.update(pipelineStages)
      .set({ position: 300 })
      .where(eq(pipelineStages.id, fixture.stages[0]!.id));
    await expect(cases.ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "stale-topology-case",
      title: "Stale topology case",
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "pipeline_graph_activation_stale" },
    });
    await db.update(pipelineStages)
      .set({ position: 100 })
      .where(eq(pipelineStages.id, fixture.stages[0]!.id));
    await expect(cases.ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "wrong-entry-case",
      title: "Wrong entry case",
      stageKey: "done",
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pipeline_graph_entry_mismatch",
        entryNodeKey: "work",
      },
    });

    const firstCase = await cases.ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "first-case",
      title: "First case",
      actor,
    });
    expect(firstCase.case.graphVersionId).toBe(firstDraft.version.id);
    await expect(cases.updateStage({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      stageId: fixture.stages[0]!.id,
      patch: { position: 125 },
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "pipeline_graph_topology_pinned" },
    });
    await expect(cases.createStage({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      key: "unversioned",
      name: "Unversioned",
      kind: "working",
      position: 150,
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "pipeline_graph_topology_pinned" },
    });
    const [unversionedStage] = await db.insert(pipelineStages).values({
      pipelineId: fixture.pipeline.id,
      key: "unversioned",
      name: "Unversioned",
      kind: "working",
      position: 150,
    }).returning();
    await expect(cases.transitionCase({
      companyId: fixture.companyId,
      caseId: firstCase.case.id,
      toStageKey: "unversioned",
      expectedVersion: firstCase.case.version,
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "pinned_graph_transition_not_allowed" },
    });
    await db.delete(pipelineStages).where(eq(pipelineStages.id, unversionedStage!.id));

    await db.delete(pipelineTransitions).where(eq(pipelineTransitions.pipelineId, fixture.pipeline.id));
    const completedFirstCase = await cases.transitionCase({
      companyId: fixture.companyId,
      caseId: firstCase.case.id,
      toStageKey: "done",
      expectedVersion: firstCase.case.version,
      actor,
    });
    expect(completedFirstCase.case.terminalKind).toBe("done");
    await db.insert(pipelineTransitions).values({
      pipelineId: fixture.pipeline.id,
      fromStageId: fixture.stages.find((stage) => stage.key === "work")!.id,
      toStageId: fixture.stages.find((stage) => stage.key === "done")!.id,
      label: "complete",
    });

    await db.update(pipelineStages)
      .set({ name: "Implementation" })
      .where(eq(pipelineStages.id, fixture.stages[0]!.id));
    const secondDraft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor,
    });
    await expect(versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: secondDraft.version.id,
      expectedActiveVersionId: null,
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pipeline_graph_activation_conflict",
        currentActiveVersionId: firstDraft.version.id,
      },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: secondDraft.version.id,
      expectedActiveVersionId: firstDraft.version.id,
      actor,
    });

    const [firstPersisted, secondPersisted] = await Promise.all([
      versions.get({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        versionId: firstDraft.version.id,
      }),
      versions.get({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        versionId: secondDraft.version.id,
      }),
    ]);
    expect(firstPersisted.status).toBe("retired");
    expect(firstPersisted.retiredAt).toBeInstanceOf(Date);
    expect(secondPersisted.status).toBe("active");
    await expect(versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: firstDraft.version.id,
      expectedActiveVersionId: secondDraft.version.id,
      actor,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "pipeline_graph_version_retired" },
    });

    const secondCase = await cases.ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "second-case",
      title: "Second case",
      actor,
    });
    expect(secondCase.case.graphVersionId).toBe(secondDraft.version.id);
    expect(firstCase.case.graphVersionId).toBe(firstDraft.version.id);

    await expect(
      db.delete(pipelines).where(eq(pipelines.id, fixture.pipeline.id)),
    ).resolves.toBeDefined();
  });

  it("pins outcome-rich graphs when the live topology represents each node pair once", async () => {
    const fixture = await seedLinearPipeline();
    const actor = { type: "user" as const, userId: "board-user" };
    await db.update(pipelines)
      .set({ enforceTransitions: true })
      .where(eq(pipelines.id, fixture.pipeline.id));
    const adopted = await pipelineGraphVersionService(db).adoptDefinition({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      definition: {
        ...linearDefinition,
        edges: [
          { fromNodeKey: "work", toNodeKey: "done", outcome: "capacity_restored" },
          { fromNodeKey: "work", toNodeKey: "done", outcome: "capacity_unavailable" },
        ],
      },
      expectedActiveVersionId: null,
      expectedActiveDefinitionHash: null,
      idempotencyKey: "adopt-outcome-rich-pair",
      actor,
    });

    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "outcome-rich-case",
      title: "Outcome-rich case",
      actor,
    });
    expect(ingested.case.graphVersionId).toBe(adopted.version.id);

    const started = await pipelineGraphRunService(db).start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "start-outcome-rich-case",
      actor,
    });
    const completed = await pipelineGraphRunService(db).transition({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 1,
      idempotencyKey: "complete-outcome-rich-case",
      outcome: "capacity_unavailable",
      checkpoint: { reason: "capacity remained unavailable" },
      actor,
    });
    expect(completed.run.status).toBe("succeeded");
    const [completedCase] = await db.select().from(pipelineCases)
      .where(eq(pipelineCases.id, ingested.case.id));
    expect(completedCase!.terminalKind).toBe("done");

    await db.delete(pipelineTransitions)
      .where(eq(pipelineTransitions.pipelineId, fixture.pipeline.id));
    await expect(pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "missing-live-pair-case",
      title: "Missing live pair case",
      actor,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "pipeline_graph_activation_stale" },
    });
  });

  it("exposes preview, idempotent persist, bounded list, and immutable get routes", async () => {
    const fixture = await seedLinearPipeline();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    app.use(errorHandler);
    const http = request(app);

    const preview = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/compile-preview`)
      .send({ entryNodeKey: "work" });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ ok: true, definitionHash: expect.any(String) });

    const first = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/versions`)
      .send({ entryNodeKey: "work" });
    expect(first.status).toBe(201);
    expect(first.headers.location).toContain(first.body.version.id);

    const replay = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/versions`)
      .send({ entryNodeKey: "work" });
    expect(replay.status).toBe(200);
    expect(replay.body.version.id).toBe(first.body.version.id);

    const activated = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/versions/${first.body.version.id}/activate`)
      .send({ expectedActiveVersionId: null });
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({
      changed: true,
      version: { id: first.body.version.id, status: "active" },
    });
    const activationReplay = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/versions/${first.body.version.id}/activate`)
      .send({ expectedActiveVersionId: null });
    expect(activationReplay.status).toBe(200);
    expect(activationReplay.body.changed).toBe(false);

    const adoptionBody = {
      definition: first.body.version.definition,
      expectedActiveVersionId: first.body.version.id,
      expectedActiveDefinitionHash: first.body.version.definitionHash,
      requiredAssignmentSchemaVersion: 1,
      idempotencyKey: "route-adopt",
    };
    const adoption = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send(adoptionBody);
    expect(adoption.status).toBe(200);
    expect(adoption.body).toMatchObject({
      changed: false,
      replayed: false,
      wakeBehavior: "none",
      version: {
        id: first.body.version.id,
        definitionHash: first.body.version.definitionHash,
        status: "active",
      },
    });
    const adoptionReplay = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send(adoptionBody);
    expect(adoptionReplay.status).toBe(200);
    expect(adoptionReplay.body).toMatchObject({
      adoptionId: adoption.body.adoptionId,
      replayed: true,
    });
    const assignmentRequirementConflict = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send({
        ...adoptionBody,
        requiredAssignmentSchemaVersion: undefined,
      });
    expect(assignmentRequirementConflict.status).toBe(409);
    expect(assignmentRequirementConflict.body.details).toMatchObject({
      code: "pipeline_graph_adoption_idempotency_conflict",
    });

    const staleAdoption = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send({
        ...adoptionBody,
        expectedActiveVersionId: null,
        expectedActiveDefinitionHash: null,
        idempotencyKey: "route-stale",
      });
    expect(staleAdoption.status).toBe(409);
    expect(staleAdoption.body.details).toMatchObject({ code: "pipeline_graph_adoption_conflict" });

    const invalidAdoption = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send({ ...adoptionBody, unsupported: true });
    expect(invalidAdoption.status).toBe(400);

    const unsupportedAssignmentSchema = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send({
        ...adoptionBody,
        requiredAssignmentSchemaVersion: 2,
        idempotencyKey: "route-unsupported-assignment-schema",
      });
    expect(unsupportedAssignmentSchema.status).toBe(422);
    expect(unsupportedAssignmentSchema.body.details).toMatchObject({
      code: "pipeline_graph_assignment_schema_unsupported",
      requiredAssignmentSchemaVersion: 2,
      supportedAssignmentSchemaVersions: [1],
    });

    const driftedDefinition = {
      ...first.body.version.definition,
      nodes: first.body.version.definition.nodes.map((node: { key: string; name: string }) =>
        node.key === "work" ? { ...node, name: "Changed work" } : node),
    };
    const idempotencyConflict = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send({ ...adoptionBody, definition: driftedDefinition });
    expect(idempotencyConflict.status).toBe(409);
    expect(idempotencyConflict.body.details).toMatchObject({
      code: "pipeline_graph_adoption_idempotency_conflict",
    });

    const [otherCompany] = await db.insert(companies).values({
      name: "Route Other Co",
      issuePrefix: `R${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const [otherAgent] = await db.insert(agents).values({
      companyId: otherCompany!.id,
      name: "Route Other Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const crossTenantTarget = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send({
        ...adoptionBody,
        idempotencyKey: "route-cross-tenant",
        definition: {
          ...first.body.version.definition,
          nodes: first.body.version.definition.nodes.map((node: { key: string }) =>
            node.key === "work"
              ? { ...node, config: { dispatchEnabled: true, targetAgentId: otherAgent!.id } }
              : node),
        },
      });
    expect(crossTenantTarget.status).toBe(422);
    expect(crossTenantTarget.body.details).toMatchObject({
      code: "pipeline_graph_target_agent_company_mismatch",
    });

    const deniedApp = express();
    deniedApp.use(express.json());
    deniedApp.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "outsider",
        source: "session",
        companyIds: [],
        isInstanceAdmin: false,
      };
      next();
    });
    deniedApp.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    deniedApp.use(errorHandler);
    const denied = await request(deniedApp)
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/adoptions`)
      .send(adoptionBody);
    expect(denied.status).toBe(404);

    const listed = await http
      .get(`/api/pipelines/${fixture.pipeline.id}/graph/versions?limit=1`);
    expect(listed.status).toBe(200);
    expect(listed.body.versions).toHaveLength(1);
    expect(listed.body.nextCursor).toBeNull();

    const oversizedCursor = Buffer.from("2147483648", "utf8").toString("base64url");
    const invalidCursor = await http
      .get(`/api/pipelines/${fixture.pipeline.id}/graph/versions?cursor=${oversizedCursor}`);
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.details).toMatchObject({ code: "invalid_cursor" });

    for (const alias of ["MQ==", "MQ=", "M%Q", "M Q", " MQ "]) {
      const noncanonicalCursor = await http
        .get(`/api/pipelines/${fixture.pipeline.id}/graph/versions`)
        .query({ cursor: alias });
      expect(noncanonicalCursor.status).toBe(400);
      expect(noncanonicalCursor.body.details).toMatchObject({ code: "invalid_cursor" });
    }

    const invalidPipeline = await http
      .post("/api/pipelines/not-a-uuid/graph/compile-preview")
      .send({ entryNodeKey: "work" });
    expect(invalidPipeline.status).toBe(400);
    expect(invalidPipeline.body.details).toMatchObject({ code: "validation" });

    const invalidActivation = await http
      .post(`/api/pipelines/${fixture.pipeline.id}/graph/versions/not-a-uuid/activate`)
      .send({ expectedActiveVersionId: null });
    expect(invalidActivation.status).toBe(400);
    expect(invalidActivation.body.details).toMatchObject({ code: "validation" });

    const fetched = await http
      .get(`/api/pipelines/${fixture.pipeline.id}/graph/versions/${first.body.version.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.definitionHash).toBe(preview.body.definitionHash);
  });

  it("starts one pinned run and saves replay-safe CAS checkpoints", async () => {
    const fixture = await seedLinearPipeline();
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "runtime-case",
      title: "Runtime case",
      actor: { type: "user", userId: "board-user" },
    });
    const runs = pipelineGraphRunService(db);
    const startInput = {
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "start:runtime-case",
      checkpoint: { attempt: 0 },
      actor: { type: "user" as const, userId: "board-user" },
    };
    const [left, right] = await Promise.all([runs.start(startInput), runs.start(startInput)]);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run.id).toBe(right.run.id);
    expect(left.run.graphVersionId).toBe(draft.version.id);
    expect(left.run.currentNodeKey).toBe("work");
    expect(left.run.revision).toBe(1);
    expect(left.committed).toEqual({ revision: 1, checkpoint: { attempt: 0 } });

    await expect(runs.start({ ...startInput, idempotencyKey: "start:other" })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_run_already_active" },
    });
    await expect(runs.start({ ...startInput, checkpoint: { attempt: 1 } })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_run_idempotency_conflict" },
    });

    const checkpointInput = {
      companyId: fixture.companyId,
      runId: left.run.id,
      expectedRevision: 1,
      idempotencyKey: "checkpoint:1",
      checkpoint: { attempt: 1, proof: "reviewed" },
      actor: { type: "user" as const, userId: "board-user" },
    };
    const saved = await runs.checkpoint(checkpointInput);
    expect(saved.changed).toBe(true);
    expect(saved.run.revision).toBe(2);
    expect(saved.event.sequence).toBe(2);
    const replay = await runs.checkpoint(checkpointInput);
    expect(replay.changed).toBe(false);
    expect(replay.event.id).toBe(saved.event.id);
    expect(replay.committed).toEqual({
      revision: 2,
      checkpoint: { attempt: 1, proof: "reviewed" },
    });

    await expect(runs.checkpoint({
      ...checkpointInput,
      idempotencyKey: "checkpoint:stale",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_run_revision_conflict", currentRevision: 2 },
    });
    await expect(runs.checkpoint({
      ...checkpointInput,
      checkpoint: { attempt: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_event_idempotency_conflict" },
    });
    expect((await runs.listEvents({
      companyId: fixture.companyId,
      runId: left.run.id,
    })).map((event) => [event.sequence, event.type, event.payload.checkpoint])).toEqual([
      [1, "run_started", { attempt: 0 }],
      [2, "checkpoint_saved", { attempt: 1, proof: "reviewed" }],
    ]);
  });

  it("executes one exact-subject effect and fences graph transition on its durable receipt", async () => {
    const fixture = await seedLinearPipeline();
    const [effectExecutor] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Trusted effect executor",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db
      .update(pipelineTransitions)
      .set({ label: "merged" })
      .where(eq(pipelineTransitions.pipelineId, fixture.pipeline.id));
    const [cancelledStage] = await db.insert(pipelineStages).values({
      pipelineId: fixture.pipeline.id,
      key: "cancelled",
      name: "Cancelled",
      kind: "cancelled",
      position: 300,
    }).returning();
    await db.insert(pipelineTransitions).values({
      pipelineId: fixture.pipeline.id,
      fromStageId: fixture.stages.find((stage) => stage.key === "work")!.id,
      toStageId: cancelledStage!.id,
      label: "head_changed",
    });
    const keyId = "botinsky.github-merge.v1";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_EFFECT_EXECUTOR_KEYS_JSON = JSON.stringify({
      [keyId]: {
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        controllerBuildIds: [`git:${"e".repeat(40)}`],
      },
    });
    const attest = (
      action: "request" | "claim" | "complete" | "fail",
      subjectHash: string,
      actionHash: string,
    ) => {
      const body = {
        keyId,
        controllerBuildId: `git:${"e".repeat(40)}`,
        subjectHash,
        action,
        actionHash,
      };
      return {
        ...body,
        signature: sign(
          null,
          Buffer.from(pipelineGraphExecutorAttestationMessage(body)),
          privateKey,
        ).toString("base64"),
      };
    };
    await db
      .update(pipelineStages)
      .set({
        config: {
          requiredEffectType: "github.merge",
          requiredEffectOutcomes: ["merged"],
          requiredAuthorityClass: "none",
          effectExecutorType: "user",
          effectExecutorId: "board-user",
        },
      })
      .where(eq(pipelineStages.id, fixture.stages.find((stage) => stage.key === "work")!.id));
    await expect(pipelineGraphVersionService(db).createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "pipeline_graph_effect_policy_invalid" },
    });
    await db
      .update(pipelineStages)
      .set({
        config: {
          requiredEffectType: "github.merge",
          requiredEffectOutcomes: ["merged"],
          requiredAuthorityClass: "merge.exact_sha",
          effectExecutorType: "agent",
          effectExecutorId: effectExecutor!.id,
          effectExecutorKeyId: keyId,
          targetAgentId: effectExecutor!.id,
        },
      })
      .where(eq(pipelineStages.id, fixture.stages.find((stage) => stage.key === "work")!.id));
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "effect-case",
      title: "Effect case",
      actor: { type: "user", userId: "board-user" },
    });
    const runs = pipelineGraphRunService(db);
    const started = await runs.start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "start:effect-case",
      actor: { type: "user", userId: "board-user" },
    });
    const effects = pipelineGraphEffectService(db);
    const subject = {
      effectType: "github.merge",
      targetRef: { repository: "quratus/meteorapp", headSha: "a".repeat(40) },
      payloadHash: "b".repeat(64),
    };
    const subjectHash = pipelineGraphEffectSubjectHash(subject);
    const requestInput = {
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 1,
      ...subject,
      authorityReceipt: {
        kind: "actor",
        subjectHash,
        decidedByUserId: "board-user",
      },
      executorAttestation: attest(
        "request",
        subjectHash,
        pipelineGraphEffectActionHash({ subjectHash }),
      ),
      idempotencyKey: "merge:exact-head",
      retryPolicy: { maxAttempts: 2 },
      actor: { type: "user" as const, userId: "board-user" },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    app.use(errorHandler);
    await expect(effects.request({
      ...requestInput,
      idempotencyKey: "merge:authority-bypass",
      authorityReceipt: { kind: "none", subjectHash },
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "effect_authority_receipt_invalid" },
    });
    await expect(effects.request({
      ...requestInput,
      idempotencyKey: "merge:unsigned-controller",
      executorAttestation: {
        ...requestInput.executorAttestation,
        signature: Buffer.from("not the private controller").toString("base64"),
      },
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "effect_executor_attestation_invalid" },
    });
    const wrongBuildBody = {
      ...requestInput.executorAttestation,
      controllerBuildId: `git:${"f".repeat(40)}`,
      signature: "",
    };
    const { signature: _ignored, ...wrongBuildUnsigned } = wrongBuildBody;
    await expect(effects.request({
      ...requestInput,
      idempotencyKey: "merge:unapproved-controller-build",
      executorAttestation: {
        ...wrongBuildUnsigned,
        signature: sign(
          null,
          Buffer.from(pipelineGraphExecutorAttestationMessage(wrongBuildUnsigned)),
          privateKey,
        ).toString("base64"),
      },
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "effect_executor_attestation_invalid" },
    });
    const created = await request(app)
      .post(`/api/graph-runs/${started.run.id}/effect-attempts`)
      .send({
        schemaVersion: 1,
        expectedRevision: requestInput.expectedRevision,
        effectType: requestInput.effectType,
        targetRef: requestInput.targetRef,
        payloadHash: requestInput.payloadHash,
        authorityReceipt: requestInput.authorityReceipt,
        executorAttestation: requestInput.executorAttestation,
        idempotencyKey: requestInput.idempotencyKey,
        retryPolicy: requestInput.retryPolicy,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.headers.location).toBe(`/api/effect-attempts/${created.body.effectAttempt.id}`);
    const requested = created.body as Awaited<ReturnType<typeof effects.request>>;
    const replay = await effects.request(requestInput);
    expect(replay.created).toBe(false);
    expect(replay.effectAttempt.id).toBe(requested.effectAttempt.id);
    const sameSubject = await effects.request({
      ...requestInput,
      idempotencyKey: "merge:duplicate-key",
    });
    expect(sameSubject.effectAttempt.id).toBe(requested.effectAttempt.id);
    const concurrent = await Promise.all([
      effects.request({ ...requestInput, idempotencyKey: "merge:concurrent-a" }),
      effects.request({ ...requestInput, idempotencyKey: "merge:concurrent-b" }),
    ]);
    expect(concurrent.map((result) => result.effectAttempt.id)).toEqual([
      requested.effectAttempt.id,
      requested.effectAttempt.id,
    ]);
    const staleSubject = {
      ...subject,
      payloadHash: "d".repeat(64),
    };
    const staleSubjectHash = pipelineGraphEffectSubjectHash(staleSubject);
    const staleAttempt = await effects.request({
      ...requestInput,
      ...staleSubject,
      authorityReceipt: {
        kind: "actor",
        subjectHash: staleSubjectHash,
        decidedByUserId: "board-user",
      },
      executorAttestation: attest(
        "request",
        staleSubjectHash,
        pipelineGraphEffectActionHash({ subjectHash: staleSubjectHash }),
      ),
      idempotencyKey: "merge:stale-boundary",
    });

    await expect(runs.transition({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 1,
      idempotencyKey: "transition:premature",
      outcome: "merged",
      checkpoint: {},
      actor: { type: "user", userId: "board-user" },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "graph_effect_receipt_required" },
    });

    const claimed = await effects.claim({
      companyId: fixture.companyId,
      effectAttemptId: requested.effectAttempt.id,
      executorType: "agent",
      executorId: effectExecutor!.id,
      leaseSeconds: 120,
      executorAttestation: attest(
        "claim",
        subjectHash,
        pipelineGraphEffectActionHash({ leaseSeconds: 120, retryReconciliation: null }),
      ),
    });
    await expect(effects.claim({
      companyId: fixture.companyId,
      effectAttemptId: requested.effectAttempt.id,
      executorType: "agent",
      executorId: "untrusted-agent",
      leaseSeconds: 120,
      executorAttestation: attest(
        "claim",
        subjectHash,
        pipelineGraphEffectActionHash({ leaseSeconds: 120, retryReconciliation: null }),
      ),
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "effect_executor_mismatch" },
    });
    const providerReceipt = {
      subjectHash,
      effectType: subject.effectType,
      payloadHash: subject.payloadHash,
      targetRefHash: pipelineGraphEffectTargetRefHash(subject.targetRef),
      providerOperationId: "github:merge:c",
      mergeCommitSha: "c".repeat(40),
    };
    await expect(effects.complete({
      companyId: fixture.companyId,
      effectAttemptId: claimed.id,
      leaseToken: randomUUID(),
      executorType: "agent",
      executorId: effectExecutor!.id,
      providerReceipt,
      executorAttestation: attest(
        "complete",
        subjectHash,
        pipelineGraphEffectActionHash(providerReceipt),
      ),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "effect_lease_fenced" },
    });
    const failureEvidence = { reason: "transient provider timeout" };
    await effects.fail({
      companyId: fixture.companyId,
      effectAttemptId: claimed.id,
      leaseToken: claimed.leaseToken!,
      executorType: "agent",
      executorId: effectExecutor!.id,
      failureEvidence,
      executorAttestation: attest(
        "fail",
        subjectHash,
        pipelineGraphEffectActionHash(failureEvidence),
      ),
    });
    await expect(effects.claim({
      companyId: fixture.companyId,
      effectAttemptId: claimed.id,
      executorType: "agent",
      executorId: effectExecutor!.id,
      leaseSeconds: 120,
      executorAttestation: attest(
        "claim",
        subjectHash,
        pipelineGraphEffectActionHash({ leaseSeconds: 120, retryReconciliation: null }),
      ),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "effect_retry_reconciliation_required" },
    });
    const retryReconciliation = {
      subjectHash,
      outcome: "not_applied" as const,
      checkedAt: new Date().toISOString(),
    };
    const reclaimed = await effects.claim({
      companyId: fixture.companyId,
      effectAttemptId: claimed.id,
      executorType: "agent",
      executorId: effectExecutor!.id,
      leaseSeconds: 120,
      retryReconciliation,
      executorAttestation: attest(
        "claim",
        subjectHash,
        pipelineGraphEffectActionHash({ leaseSeconds: 120, retryReconciliation }),
      ),
    });
    await expect(effects.complete({
      companyId: fixture.companyId,
      effectAttemptId: reclaimed.id,
      leaseToken: reclaimed.leaseToken!,
      executorType: "agent",
      executorId: effectExecutor!.id,
      providerReceipt: { providerOperationId: "forged" },
      executorAttestation: attest(
        "complete",
        subjectHash,
        pipelineGraphEffectActionHash({ providerOperationId: "forged" }),
      ),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "effect_provider_receipt_invalid" },
    });
    const completed = await effects.complete({
      companyId: fixture.companyId,
      effectAttemptId: reclaimed.id,
      leaseToken: reclaimed.leaseToken!,
      executorType: "agent",
      executorId: effectExecutor!.id,
      providerReceipt,
      executorAttestation: attest(
        "complete",
        subjectHash,
        pipelineGraphEffectActionHash(providerReceipt),
      ),
    });
    expect(completed.status).toBe("succeeded");

    const transitionedResponse = await request(app)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 1,
        idempotencyKey: "transition:after-effect",
        outcome: "merged",
        checkpoint: {},
        effectAttemptId: completed.id,
      });
    expect(transitionedResponse.status, JSON.stringify(transitionedResponse.body)).toBe(200);
    const transitioned = transitionedResponse.body as Awaited<ReturnType<typeof runs.transition>>;
    expect(transitioned.run.status).toBe("succeeded");
    await expect(effects.claim({
      companyId: fixture.companyId,
      effectAttemptId: staleAttempt.effectAttempt.id,
      executorType: "agent",
      executorId: effectExecutor!.id,
      leaseSeconds: 120,
      executorAttestation: attest(
        "claim",
        staleSubjectHash,
        pipelineGraphEffectActionHash({ leaseSeconds: 120, retryReconciliation: null }),
      ),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "effect_graph_boundary_stale" },
    });
    expect(transitioned.event.payload).toMatchObject({
      effectReceipt: {
        effectAttemptId: completed.id,
        effectType: "github.merge",
        subjectHash,
        providerReceipt: {
          subjectHash,
          effectType: "github.merge",
          payloadHash: subject.payloadHash,
          targetRefHash: pipelineGraphEffectTargetRefHash(subject.targetRef),
          providerOperationId: "github:merge:c",
          mergeCommitSha: "c".repeat(40),
        },
      },
    });
    const redirectedCase = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "effect-head-changed",
      title: "Changed head",
      actor: { type: "user", userId: "board-user" },
    });
    const redirectedRun = await runs.start({
      companyId: fixture.companyId,
      caseId: redirectedCase.case.id,
      idempotencyKey: "start:effect-head-changed",
      actor: { type: "user", userId: "board-user" },
    });
    const redirected = await runs.transition({
      companyId: fixture.companyId,
      runId: redirectedRun.run.id,
      expectedRevision: 1,
      idempotencyKey: "transition:head-changed",
      outcome: "head_changed",
      checkpoint: { reason: "provider head moved" },
      actor: { type: "user", userId: "board-user" },
    });
    expect(redirected.run.status).toBe("cancelled");
  });

  it("enforces graph-run tenant foreign keys and route UUID validation", async () => {
    const fixture = await seedLinearPipeline();
    const [otherCompany] = await db.insert(companies).values({
      name: "Other runtime company",
      issuePrefix: `R${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "tenant-case",
      title: "Tenant case",
      actor: { type: "user", userId: "board-user" },
    });
    const secondCase = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "tenant-case-two",
      title: "Tenant case two",
      actor: { type: "user", userId: "board-user" },
    });
    const sameKeyResults = await Promise.allSettled([
      pipelineGraphRunService(db).start({
        companyId: fixture.companyId,
        caseId: ingested.case.id,
        idempotencyKey: "company-wide-key",
        actor: { type: "user", userId: "board-user" },
      }),
      pipelineGraphRunService(db).start({
        companyId: fixture.companyId,
        caseId: secondCase.case.id,
        idempotencyKey: "company-wide-key",
        actor: { type: "user", userId: "board-user" },
      }),
    ]);
    expect(sameKeyResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = sameKeyResults.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        status: 409,
        details: { code: "graph_run_idempotency_conflict" },
      },
    });
    await expect(db.insert(pipelineGraphRuns).values({
      companyId: otherCompany!.id,
      pipelineId: fixture.pipeline.id,
      graphVersionId: draft.version.id,
      caseId: ingested.case.id,
      startIdempotencyKey: "cross-tenant",
      currentNodeKey: "work",
      startedByType: "user",
      startedById: "board-user",
    })).rejects.toThrow();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    app.use(errorHandler);
    const response = await request(app)
      .get("/api/graph-runs/not-a-uuid");
    expect(response.status).toBe(400);
    expect(response.body.details).toMatchObject({ code: "validation" });
    const invalidCase = await request(app)
      .post("/api/cases/not-a-uuid/graph-runs")
      .send({ idempotencyKey: "invalid-case" });
    expect(invalidCase.status).toBe(400);
    expect(invalidCase.body.details).toMatchObject({ code: "validation" });
  });

  it("commits pinned terminal transitions once and advances the case atomically", async () => {
    const fixture = await seedLinearPipeline();
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "terminal-transition",
      title: "Terminal transition",
      actor: { type: "user", userId: "board-user" },
    });
    const runs = pipelineGraphRunService(db);
    const started = await runs.start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "start:terminal",
      actor: { type: "user", userId: "board-user" },
    });
    const outcome = draft.version.definition.edges[0]!.outcome;
    const input = {
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 1,
      idempotencyKey: "transition:done",
      outcome,
      checkpoint: { proof: "reviewed" },
      actor: { type: "user" as const, userId: "board-user" },
    };
    await expect(pipelineService(db).transitionCase({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: { type: "user", userId: "board-user" },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "case_graph_run_active", graphRunId: started.run.id },
    });
    await expect(runs.transition({
      ...input,
      idempotencyKey: "transition:invalid",
      outcome: "not-an-edge",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "graph_transition_not_allowed" },
    });
    expect((await runs.get({
      companyId: fixture.companyId,
      runId: started.run.id,
    })).revision).toBe(1);
    expect(await db.select().from(pipelineGraphWakeOutbox)).toHaveLength(0);
    const committed = await runs.transition(input);
    expect(committed).toMatchObject({
      changed: true,
      redirected: false,
      run: { status: "succeeded", currentNodeKey: "done", revision: 2 },
    });
    const replay = await runs.transition(input);
    expect(replay.changed).toBe(false);
    expect(replay.committed).toEqual(committed.committed);
    await expect(runs.transition({ ...input, checkpoint: { proof: "different" } })).rejects
      .toMatchObject({ status: 409, details: { code: "graph_event_idempotency_conflict" } });
    const [pipelineCase] = await db.select().from(pipelineCases)
      .where(eq(pipelineCases.id, ingested.case.id));
    expect(pipelineCase).toMatchObject({ terminalKind: "done", version: 2 });
    expect((await runs.listEvents({
      companyId: fixture.companyId,
      runId: started.run.id,
    })).map((event) => event.type)).toEqual([
      "run_started",
      "transition_committed",
      "run_succeeded",
    ]);
    expect((await db.select().from(pipelineCaseEvents)
      .where(eq(pipelineCaseEvents.caseId, ingested.case.id)))
      .map((event) => event.type)).toContain("transitioned");
    expect(await db.select().from(pipelineGraphWakeOutbox)).toHaveLength(0);
  });

  it("lists active runs and atomically catches a completed linked issue across review without an intermediate wake", async () => {
    const fixture = await seedReviewedPipeline();
    const actor = { type: "user" as const, userId: "board-user" };
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor,
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor,
    });
    const cases = await Promise.all(["catch-up-a", "catch-up-b"].map((caseKey) =>
      pipelineService(db).ingestCase({
        companyId: fixture.companyId,
        pipelineId: fixture.pipeline.id,
        caseKey,
        title: caseKey,
        actor,
      })));
    const runs = pipelineGraphRunService(db);
    const started = await Promise.all(cases.map((ingested, index) => runs.start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: `reviewed-graph:start:${index}`,
      actor,
    })));

    const firstPage = await runs.listForPipeline({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      statuses: ["running"],
      limit: 1,
      cursor: null,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await runs.listForPipeline({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      statuses: ["running"],
      limit: 1,
      cursor: decodePipelineGraphRunCursor(firstPage.nextCursor!),
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
    expect(secondPage.nextCursor).toBeNull();

    const [linkedIssue] = await db.insert(issues).values({
      companyId: fixture.companyId,
      title: "Already completed and independently approved",
      status: "done",
      executionState: {
        status: "completed",
        lastDecisionOutcome: "approved",
      },
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: fixture.companyId,
      caseId: cases[0]!.case.id,
      issueId: linkedIssue!.id,
      role: "work",
    });
    const issueStateHash = graphReconciliationIssueStateHash(linkedIssue!);
    const input = {
      companyId: fixture.companyId,
      runId: started[0]!.run.id,
      expectedRevision: 1,
      expectedCaseVersion: 1,
      linkedIssueId: linkedIssue!.id,
      expectedIssueStateHash: issueStateHash,
      idempotencyKey: "reviewed-graph:catch-up",
      outcomes: ["complete", "approve"],
      checkpoint: {
        controllerBuild: "test-build",
        evidence: "linked_issue_completed_and_approved",
      },
      reason: "Reconcile the pinned graph with the completed linked work issue",
      actor,
    };
    await expect(runs.catchUp({
      ...input,
      idempotencyKey: "reviewed-graph:stale-revision",
      expectedRevision: 2,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_run_revision_conflict" },
    });
    await expect(runs.catchUp({
      ...input,
      idempotencyKey: "reviewed-graph:stale-issue",
      expectedIssueStateHash: "0".repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_reconciliation_issue_conflict" },
    });

    const [left, right] = await Promise.all([runs.catchUp(input), runs.catchUp(input)]);
    const changed = [left, right].find((result) => result.changed);
    const replay = [left, right].find((result) => !result.changed);
    expect(changed).toMatchObject({
      changed: true,
      wakeBehavior: "none",
      traversedOutcomes: ["complete", "approve"],
      run: {
        graphVersionId: draft.version.id,
        status: "succeeded",
        currentNodeKey: "done",
        revision: 3,
      },
    });
    expect(replay).toMatchObject({
      changed: false,
      wakeBehavior: "none",
      run: { status: "succeeded", currentNodeKey: "done", revision: 3 },
    });
    const [pipelineCase] = await db.select().from(pipelineCases)
      .where(eq(pipelineCases.id, cases[0]!.case.id));
    expect(pipelineCase).toMatchObject({
      terminalKind: "done",
      version: 3,
    });
    expect((await runs.listEvents({
      companyId: fixture.companyId,
      runId: started[0]!.run.id,
    })).map((event) => event.type)).toEqual([
      "run_started",
      "transition_committed",
      "transition_committed",
      "run_succeeded",
    ]);
    expect(await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.runId, started[0]!.run.id))).toHaveLength(0);
  });

  it("carries explicit node responsibility into transition and resume wakes", async () => {
    const fixture = await seedLinearPipeline();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: fixture.companyId,
      name: "Allowlisted graph worker",
      role: "engineer",
    });
    const [reviewStage] = await db.insert(pipelineStages).values({
      pipelineId: fixture.pipeline.id,
      key: "review",
      name: "Review",
      kind: "review",
      position: 150,
      config: {
        responsibilityOwner: "independent_reviewer",
        responsibilityInstruction: "Review the linked issue and commit an explicit graph outcome.",
        dispatchEnabled: true,
        targetAgentId,
        requireApproval: false,
        approveToStageKey: "done",
        rejectToStageKey: "work",
      },
    }).returning();
    await db.insert(pipelineTransitions).values([
      {
        pipelineId: fixture.pipeline.id,
        fromStageId: fixture.stages.find((stage) => stage.key === "work")!.id,
        toStageId: reviewStage!.id,
        label: "review",
      },
      {
        pipelineId: fixture.pipeline.id,
        fromStageId: reviewStage!.id,
        toStageId: fixture.stages.find((stage) => stage.key === "done")!.id,
        label: "approve",
      },
    ]);
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "allowlisted-responsibility",
      title: "Allowlisted responsibility",
      actor: { type: "user", userId: "board-user" },
    });
    const cancelHeartbeatRun = vi.fn(async () => null);
    const runs = pipelineGraphRunService(db, { cancelHeartbeatRun });
    const started = await runs.start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "allowlisted:start",
      actor: { type: "user", userId: "board-user" },
    });
    await runs.transition({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 1,
      idempotencyKey: "allowlisted:review",
      outcome: "review",
      checkpoint: { review_revision: 1 },
      actor: { type: "user", userId: "board-user" },
    });
    await runs.setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 2,
      idempotencyKey: "allowlisted:pause",
      paused: true,
      reason: "exercise resume routing",
      actor: { type: "user", userId: "board-user" },
    });
    await runs.setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 3,
      idempotencyKey: "allowlisted:resume",
      paused: false,
      reason: "resume the same responsible reviewer",
      actor: { type: "user", userId: "board-user" },
    });

    const wakeRows = await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.runId, started.run.id));
    expect(wakeRows).toHaveLength(2);
    for (const wake of wakeRows) {
      expect(wake).toMatchObject({
        targetNodeKey: "review",
        payload: {
          responsibilityOwner: "independent_reviewer",
          responsibilityInstruction: "Review the linked issue and commit an explicit graph outcome.",
          dispatchEnabled: true,
          targetAgentId,
          graphAssignment: {
            schemaVersion: 1,
            graphVersionId: draft.version.id,
            runId: started.run.id,
            caseId: ingested.case.id,
            nodeKey: "review",
            nodeKind: "review",
            responsibilityOwner: "independent_reviewer",
            targetAgentId,
            instruction: "Review the linked issue and commit an explicit graph outcome.",
            allowedOutcomes: ["approve"],
            completion: {
              method: "POST",
              path: `/api/graph-runs/${started.run.id}/transitions`,
            },
          },
        },
      });
    }

    const [wrongAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Wrong graph worker",
      role: "engineer",
    }).returning();
    await expect(runs.transition({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 4,
      idempotencyKey: "allowlisted:wrong-agent",
      outcome: "approve",
      checkpoint: { reviewed: true },
      actor: { type: "agent", agentId: wrongAgent!.id, runId: randomUUID() },
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "graph_assignment_agent_mismatch" },
    });

    const [resumeWake] = wakeRows.filter((wake) => wake.payload.reason === "run_resumed");
    const [staleAttempt] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: 3,
        targetNodeKey: "review",
        graphAssignment: resumeWake!.payload.graphAssignment,
      },
    }).returning();
    await expect(runs.transition({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 4,
      idempotencyKey: "allowlisted:stale-attempt",
      outcome: "approve",
      checkpoint: { reviewed: true },
      actor: { type: "agent", agentId: targetAgentId, runId: staleAttempt!.id },
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "graph_assignment_attempt_mismatch" },
    });

    const assignment = resumeWake!.payload.graphAssignment as Record<string, unknown>;
    const [boundAttempt] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: 4,
        targetNodeKey: "review",
        graphAssignment: assignment,
      },
    }).returning();
    await expect(runs.transition({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 4,
      idempotencyKey: "allowlisted:bound-approve",
      outcome: "approve",
      checkpoint: { reviewed: true },
      actor: { type: "agent", agentId: targetAgentId, runId: boundAttempt!.id },
    })).resolves.toMatchObject({
      changed: true,
      run: { status: "succeeded", currentNodeKey: "done", revision: 5 },
    });
    expect(cancelHeartbeatRun).toHaveBeenCalledWith(
      boundAttempt!.id,
      expect.stringContaining("advanced to revision 5"),
    );
  });

  async function seedRouteAuthorityFixture() {
    const fixture = await seedLinearPipeline();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: fixture.companyId,
      name: "Route-bound graph worker",
      role: "engineer",
    });
    const [legacyAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Legacy-assigned but not graph-pinned",
      role: "engineer",
    }).returning();
    const [reviewStage] = await db.insert(pipelineStages).values({
      pipelineId: fixture.pipeline.id,
      key: "review",
      name: "Review",
      kind: "review",
      position: 150,
      config: {
        responsibilityOwner: "independent_reviewer",
        dispatchEnabled: true,
        targetAgentId,
        requireApproval: false,
        approveToStageKey: "done",
        rejectToStageKey: "work",
      },
    }).returning();
    await db.insert(pipelineTransitions).values([
      {
        pipelineId: fixture.pipeline.id,
        fromStageId: fixture.stages.find((stage) => stage.key === "work")!.id,
        toStageId: reviewStage!.id,
        label: "review",
      },
      {
        pipelineId: fixture.pipeline.id,
        fromStageId: reviewStage!.id,
        toStageId: fixture.stages.find((stage) => stage.key === "done")!.id,
        label: "approve",
      },
    ]);
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const runs = pipelineGraphRunService(db);
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: `route-authority-${randomUUID().slice(0, 8)}`,
      title: "Route authority",
      actor: { type: "user", userId: "board-user" },
    });
    const started = await runs.start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: `route-authority:start:${ingested.case.id}`,
      actor: { type: "user", userId: "board-user" },
    });
    await runs.transition({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 1,
      idempotencyKey: `route-authority:review:${started.run.id}`,
      outcome: "review",
      checkpoint: { review_revision: 1 },
      actor: { type: "user", userId: "board-user" },
    });
    const [wake] = await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.runId, started.run.id));
    const graphAssignment = wake!.payload.graphAssignment as Record<string, unknown>;
    return { fixture, versions, runs, targetAgentId, legacyAgent: legacyAgent!, started, graphAssignment };
  }

  type RouteActor =
    | { type: "agent"; agentId: string; runId: string; companyId: string }
    | { type: "board"; userId: string };

  function buildPipelineRouteApp(db: ReturnType<typeof createDb>, actor: RouteActor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor.type === "agent"
        ? {
          type: "agent",
          agentId: actor.agentId,
          companyId: actor.companyId,
          runId: actor.runId,
          source: "agent_key",
        }
        : { type: "board", userId: actor.userId, source: "local_implicit" };
      next();
    });
    app.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    app.use(errorHandler);
    return app;
  }

  it("lets a graph-assigned agent commit its exact transition through the route without pipelines:write, while every other binding fails closed", async () => {
    const { fixture, targetAgentId, legacyAgent, started, graphAssignment } =
      await seedRouteAuthorityFixture();

    // A legacy-issue "assignee" that is not the current graph-pinned target
    // agent must never gain transition authority from that stale projection.
    const legacyIssueId = randomUUID();
    await db.insert(issues).values({
      id: legacyIssueId,
      companyId: fixture.companyId,
      title: "Stale legacy assignment",
      status: "in_review",
      assigneeAgentId: legacyAgent.id,
    });
    const legacyApp = buildPipelineRouteApp(db, {
      type: "agent",
      agentId: legacyAgent.id,
      companyId: fixture.companyId,
      runId: randomUUID(),
    });
    const legacyAttempt = await request(legacyApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 2,
        idempotencyKey: "route-authority:legacy-agent",
        outcome: "approve",
        checkpoint: { reviewed: true },
      });
    expect(legacyAttempt.status).toBe(403);
    expect(legacyAttempt.body.details).toMatchObject({ code: "pipeline_write_forbidden" });

    // The exact pinned target agent, but with no heartbeat run bound to the
    // assignment at all, must also fail closed.
    const noHeartbeatApp = buildPipelineRouteApp(db, {
      type: "agent",
      agentId: targetAgentId,
      companyId: fixture.companyId,
      runId: randomUUID(),
    });
    const noHeartbeatAttempt = await request(noHeartbeatApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 2,
        idempotencyKey: "route-authority:no-heartbeat",
        outcome: "approve",
        checkpoint: { reviewed: true },
      });
    expect(noHeartbeatAttempt.status).toBe(403);
    expect(noHeartbeatAttempt.body.details).toMatchObject({ code: "pipeline_write_forbidden" });

    // Bind a real heartbeat run to the current assignment.
    const [boundAttempt] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: 2,
        targetNodeKey: "review",
        graphAssignment,
      },
    }).returning();
    const boundApp = buildPipelineRouteApp(db, {
      type: "agent",
      agentId: targetAgentId,
      companyId: fixture.companyId,
      runId: boundAttempt!.id,
    });

    // A disallowed outcome fails closed even though identity and heartbeat
    // binding both match.
    const badOutcome = await request(boundApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 2,
        idempotencyKey: "route-authority:bad-outcome",
        outcome: "not-an-edge",
        checkpoint: { reviewed: true },
      });
    expect(badOutcome.status).toBe(403);
    expect(badOutcome.body.details).toMatchObject({ code: "pipeline_write_forbidden" });

    // A stale/foreign revision fails closed.
    const staleRevision = await request(boundApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 99,
        idempotencyKey: "route-authority:stale-revision",
        outcome: "approve",
        checkpoint: { reviewed: true },
      });
    expect(staleRevision.status).toBe(403);
    expect(staleRevision.body.details).toMatchObject({ code: "pipeline_write_forbidden" });

    // Exact current agent + exact bound heartbeat + allowed outcome commits,
    // despite this agent never holding a pipelines:write grant.
    const committed = await request(boundApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 2,
        idempotencyKey: "route-authority:approve",
        outcome: "approve",
        checkpoint: { reviewed: true },
      });
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({
      changed: true,
      run: { status: "succeeded", currentNodeKey: "done", revision: 3 },
    });

    // Duplicate/replayed delivery of the exact same request commits at most
    // once and returns the prior result — no second wake, no second mutation.
    const replay = await request(boundApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 2,
        idempotencyKey: "route-authority:approve",
        outcome: "approve",
        checkpoint: { reviewed: true },
      });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ changed: false });
    expect(replay.body.committed).toEqual(committed.body.committed);
    expect(await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.runId, started.run.id))).toHaveLength(1);

    // The run is now terminal; the same agent cannot transition again.
    const terminalAttempt = await request(boundApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 2,
        idempotencyKey: "route-authority:post-terminal",
        outcome: "approve",
        checkpoint: { reviewed: true },
      });
    expect(terminalAttempt.status).toBe(403);
    expect(terminalAttempt.body.details).toMatchObject({ code: "pipeline_write_forbidden" });

    // A cross-company caller cannot reach this run at all, regardless of grants.
    const [otherCompany] = await db.insert(companies).values({
      name: "Other Route Co",
      issuePrefix: `X${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const crossCompanyApp = buildPipelineRouteApp(db, {
      type: "agent",
      agentId: targetAgentId,
      companyId: otherCompany!.id,
      runId: boundAttempt!.id,
    });
    const crossCompanyAttempt = await request(crossCompanyApp)
      .post(`/api/graph-runs/${started.run.id}/transitions`)
      .send({
        expectedRevision: 2,
        idempotencyKey: "route-authority:cross-company",
        outcome: "approve",
        checkpoint: { reviewed: true },
      });
    expect(crossCompanyAttempt.status).toBe(404);

    // Human/operator behavior is completely unchanged: the board actor still
    // goes through (and here satisfies) the pre-existing pipelines:write gate.
    const boardApp = buildPipelineRouteApp(db, { type: "board", userId: "board-user" });
    const secondCase = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "route-authority-human",
      title: "Route authority human path",
      actor: { type: "user", userId: "board-user" },
    });
    const secondRun = await pipelineGraphRunService(db).start({
      companyId: fixture.companyId,
      caseId: secondCase.case.id,
      idempotencyKey: "route-authority-human:start",
      actor: { type: "user", userId: "board-user" },
    });
    const humanTransition = await request(boardApp)
      .post(`/api/graph-runs/${secondRun.run.id}/transitions`)
      .send({
        expectedRevision: 1,
        idempotencyKey: "route-authority-human:complete",
        outcome: "complete",
        checkpoint: { proof: "reviewed" },
      });
    expect(humanTransition.status).toBe(200);
    expect(humanTransition.body).toMatchObject({
      changed: true,
      run: { status: "succeeded", currentNodeKey: "done" },
    });

    // A board actor without any grant is still denied exactly as before.
    const [ungrantedCompany] = await db.insert(companies).values({
      name: "Ungranted Board Co",
      issuePrefix: `U${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const ungrantedFixture = await seedLinearPipeline(ungrantedCompany!.id);
    const ungrantedDraft = await pipelineGraphVersionService(db).createDraft({
      companyId: ungrantedFixture.companyId,
      pipelineId: ungrantedFixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "unprivileged-user" },
    });
    await pipelineGraphVersionService(db).activate({
      companyId: ungrantedFixture.companyId,
      pipelineId: ungrantedFixture.pipeline.id,
      versionId: ungrantedDraft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "unprivileged-user" },
    });
    const ungrantedCase = await pipelineService(db).ingestCase({
      companyId: ungrantedFixture.companyId,
      pipelineId: ungrantedFixture.pipeline.id,
      caseKey: "ungranted-case",
      title: "Ungranted case",
      actor: { type: "user", userId: "unprivileged-user" },
    });
    const ungrantedRun = await pipelineGraphRunService(db).start({
      companyId: ungrantedFixture.companyId,
      caseId: ungrantedCase.case.id,
      idempotencyKey: "ungranted:start",
      actor: { type: "user", userId: "unprivileged-user" },
    });
    const unprivilegedBoardApp = express();
    unprivilegedBoardApp.use(express.json());
    unprivilegedBoardApp.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "unprivileged-user",
        source: "session",
        companyIds: [ungrantedFixture.companyId],
      };
      next();
    });
    unprivilegedBoardApp.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    unprivilegedBoardApp.use(errorHandler);
    const unprivilegedAttempt = await request(unprivilegedBoardApp)
      .post(`/api/graph-runs/${ungrantedRun.run.id}/transitions`)
      .send({
        expectedRevision: 1,
        idempotencyKey: "ungranted:complete",
        outcome: "complete",
        checkpoint: { proof: "reviewed" },
      });
    expect(unprivilegedAttempt.status).toBe(403);
    expect(unprivilegedAttempt.body.details).toMatchObject({ code: "pipeline_write_forbidden" });
  });

  it("derives assignment_authorized only from durable state and never from the request body", async () => {
    const { fixture, targetAgentId, started, graphAssignment } = await seedRouteAuthorityFixture();
    const [boundAttempt] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: 2,
        targetNodeKey: "review",
        graphAssignment,
      },
    }).returning();
    const baseInput = {
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 2,
      idempotencyKey: "predicate:base",
      outcome: "approve",
      checkpoint: { reviewed: true },
      actor: { type: "agent" as const, agentId: targetAgentId, runId: boundAttempt!.id },
    };

    await expect(resolveGraphTransitionAssignmentAuthorization(db, baseInput))
      .resolves.toEqual({ authorized: true });

    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      actor: { type: "user", userId: "board-user" },
    })).resolves.toMatchObject({ authorized: false, code: "graph_assignment_actor_not_agent" });

    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:missing-run",
      runId: randomUUID(),
    })).resolves.toMatchObject({ authorized: false, code: "graph_run_not_found" });

    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:wrong-company",
      companyId: randomUUID(),
    })).resolves.toMatchObject({ authorized: false, code: "graph_run_not_found" });

    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:stale-revision",
      expectedRevision: 99,
    })).resolves.toMatchObject({ authorized: false, code: "graph_run_revision_conflict" });

    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:bad-outcome",
      outcome: "not-an-edge",
    })).resolves.toMatchObject({ authorized: false, code: "graph_transition_not_allowed" });

    const [otherAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Other predicate agent",
      role: "engineer",
    }).returning();
    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:wrong-agent",
      actor: { type: "agent", agentId: otherAgent!.id, runId: boundAttempt!.id },
    })).resolves.toMatchObject({ authorized: false, code: "graph_assignment_agent_mismatch" });

    const [staleHeartbeat] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: 1,
        targetNodeKey: "work",
        graphAssignment: { ...graphAssignment, id: `${started.run.id}:1:work` },
      },
    }).returning();
    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:stale-attempt",
      actor: { type: "agent", agentId: targetAgentId, runId: staleHeartbeat!.id },
    })).resolves.toMatchObject({ authorized: false, code: "graph_assignment_attempt_mismatch" });

    const [cancelledHeartbeat] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgentId,
      invocationSource: "automation",
      status: "cancelled",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: 2,
        targetNodeKey: "review",
        graphAssignment,
      },
    }).returning();
    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:cancelled-heartbeat",
      actor: { type: "agent", agentId: targetAgentId, runId: cancelledHeartbeat!.id },
    })).resolves.toMatchObject({ authorized: false, code: "graph_assignment_attempt_mismatch" });

    // Terminal run: commit the real transition first, then prove a further
    // attempt against the now-succeeded run fails closed even naming the
    // previously-valid revision.
    const runsService = pipelineGraphRunService(db);
    await runsService.transition(baseInput);
    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      idempotencyKey: "predicate:terminal",
    })).resolves.toMatchObject({ authorized: false, code: "graph_run_not_running" });

    // Idempotent replay of the exact original committed request is
    // authorized regardless of the run's now-advanced state.
    await expect(resolveGraphTransitionAssignmentAuthorization(db, baseInput))
      .resolves.toEqual({ authorized: true });

    // Replaying the same idempotency key with a materially different
    // request is a conflict, not a silent allow.
    await expect(resolveGraphTransitionAssignmentAuthorization(db, {
      ...baseInput,
      checkpoint: { reviewed: false },
    })).resolves.toMatchObject({ authorized: false, code: "graph_event_idempotency_conflict" });
  });

  it("atomically wakes a configured entry-node owner when a graph run starts", async () => {
    const fixture = await seedLinearPipeline();
    const [targetAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Entry graph worker",
      role: "engineer",
    }).returning();
    await db.update(pipelineStages)
      .set({
        config: {
          responsibilityOwner: "implementer",
          responsibilityInstruction: "Implement the linked issue and submit a graph outcome.",
          acceptanceCriteria: ["The changed behavior is verified"],
          dispatchEnabled: true,
          targetAgentId: targetAgent!.id,
        },
      })
      .where(eq(pipelineStages.id, fixture.stages.find((stage) => stage.key === "work")!.id));
    const draft = await pipelineGraphVersionService(db).createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await pipelineGraphVersionService(db).activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "entry-wake",
      title: "Entry wake",
      actor: { type: "user", userId: "board-user" },
    });

    const started = await pipelineGraphRunService(db).start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "entry-wake:start",
      actor: { type: "user", userId: "board-user" },
    });

    expect((await pipelineGraphRunService(db).listEvents({
      companyId: fixture.companyId,
      runId: started.run.id,
    })).map((event) => event.type)).toEqual(["run_started", "wake_requested"]);
    const [wake] = await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.runId, started.run.id));
    expect(wake).toMatchObject({
      targetNodeKey: "work",
      payload: {
        reason: "run_started",
        dispatchEnabled: true,
        targetAgentId: targetAgent!.id,
        graphAssignment: {
          id: `${started.run.id}:1:work`,
          runRevision: 1,
          nodeKey: "work",
          responsibilityOwner: "implementer",
          acceptanceCriteria: ["The changed behavior is verified"],
          allowedOutcomes: ["complete"],
        },
      },
    });
  });

  it("serializes graph start against the legacy case transition authority", async () => {
    const fixture = await seedLinearPipeline();
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "start-transition-race",
      title: "Start transition race",
      actor: { type: "user", userId: "board-user" },
    });
    let startPromise: Promise<unknown> = Promise.resolve();
    let legacyPromise: Promise<unknown> = Promise.resolve();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
        "pipeline-graph-run:case:" + ingested.case.id
      }, 0))`);
      startPromise = pipelineGraphRunService(db).start({
        companyId: fixture.companyId,
        caseId: ingested.case.id,
        idempotencyKey: "start:race",
        actor: { type: "user", userId: "board-user" },
      });
      legacyPromise = pipelineService(db).transitionCase({
        companyId: fixture.companyId,
        caseId: ingested.case.id,
        toStageKey: "done",
        expectedVersion: 1,
        actor: { type: "user", userId: "board-user" },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    const results = await Promise.allSettled([startPromise, legacyPromise]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [pipelineCase] = await db.select().from(pipelineCases)
      .where(eq(pipelineCases.id, ingested.case.id));
    const graphRuns = await db.select().from(pipelineGraphRuns)
      .where(eq(pipelineGraphRuns.caseId, ingested.case.id));
    if (graphRuns.length === 1) {
      expect(pipelineCase).toMatchObject({ terminalKind: null, version: 1 });
      expect(graphRuns[0]).toMatchObject({ currentNodeKey: "work", status: "running" });
    } else {
      expect(pipelineCase).toMatchObject({ terminalKind: "done", version: 2 });
    }
  });

  it("redirects cycle exhaustion and fences wake delivery receipts", async () => {
    const fixture = await seedLinearPipeline();
    const [reviewStage] = await db.insert(pipelineStages).values({
      pipelineId: fixture.pipeline.id,
      key: "review",
      name: "Review",
      kind: "review",
      position: 150,
      config: {
        approveToStageKey: "done",
        rejectToStageKey: "work",
        requireApproval: false,
      },
    }).returning();
    const workStage = fixture.stages.find((stage) => stage.key === "work")!;
    await db.insert(pipelineTransitions).values([
      {
        pipelineId: fixture.pipeline.id,
        fromStageId: workStage.id,
        toStageId: reviewStage!.id,
        label: "review",
      },
      {
        pipelineId: fixture.pipeline.id,
        fromStageId: reviewStage!.id,
        toStageId: workStage.id,
        label: "revise",
      },
    ]);
    const versions = pipelineGraphVersionService(db);
    const draft = await versions.createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      cycleContracts: [{
        key: "implementation-review",
        nodeKeys: ["work", "review"],
        maxIterations: 3,
        noProgressLimit: 1,
        progressField: null,
        exitNodeKeys: ["done"],
      }],
      actor: { type: "user", userId: "board-user" },
    });
    await versions.activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "cycle-redirect",
      title: "Cycle redirect",
      actor: { type: "user", userId: "board-user" },
    });
    const runs = pipelineGraphRunService(db);
    const started = await runs.start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "start:cycle",
      actor: { type: "user", userId: "board-user" },
    });
    const move = async (
      expectedRevision: number,
      outcome: string,
      key: string,
      actor = { type: "user" as const, userId: "board-user" },
      leaseToken?: string,
    ) =>
      runs.transition({
        companyId: fixture.companyId,
        runId: started.run.id,
        expectedRevision,
        idempotencyKey: key,
        outcome,
        checkpoint: { score: 10, accessToken: "must-not-leak" },
        leaseToken,
        actor,
      });
    await move(1, "review", "cycle:review:1");
    await move(2, "revise", "cycle:revise:1");
    await move(3, "review", "cycle:review:2");
    const claimed = await pipelineService(db).claimCase({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      actor: { type: "user", userId: "lease-owner" },
    });
    await expect(move(4, "revise", "cycle:revise:wrong-owner")).rejects.toMatchObject({
      status: 409,
      details: { code: "lease_held" },
    });
    expect((await runs.get({
      companyId: fixture.companyId,
      runId: started.run.id,
    })).revision).toBe(4);
    const redirected = await move(
      4,
      "revise",
      "cycle:revise:2",
      { type: "user", userId: "lease-owner" },
      claimed.leaseToken!,
    );
    expect(redirected).toMatchObject({
      changed: true,
      redirected: true,
      run: { status: "paused", currentNodeKey: "review", revision: 5 },
      committed: {
        interruption: { code: "cycle_no_progress" },
        responsibilityOwner: "graph_owner",
      },
    });
    const outbox = await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.runId, started.run.id))
      .orderBy(pipelineGraphWakeOutbox.createdAt);
    expect(outbox).toHaveLength(4);
    expect(outbox.at(-1)).toMatchObject({
      status: "pending",
      targetNodeKey: "review",
      payload: { responsibilityOwner: "graph_owner", dispatchEnabled: false },
    });
    const diagnostics = await runs.diagnostics({
      companyId: fixture.companyId,
      runId: started.run.id,
      now: new Date(started.run.startedAt.getTime() + 1_000),
    });
    expect(diagnostics).toMatchObject({
      graph: {
        versionId: draft.version.id,
        version: draft.version.version,
        schemaVersion: 1,
        definitionHash: draft.version.definitionHash,
      },
      current: {
        node: { key: "review", kind: "review" },
        responsibilityOwner: "review",
        targetAgentId: null,
        checkpoint: {
          present: true,
          keys: ["accessToken", "runtimeInterruption", "score"],
        },
        redirect: {
          responsibilityOwner: "graph_owner",
          reason: "cycle_no_progress",
        },
        interruption: { code: "cycle_no_progress" },
      },
      wakeDelivery: {
        statusCounts: { pending: 4 },
        pending: 4,
        claimed: 0,
        dispatched: 0,
        failed: 0,
        cancelled: 0,
        averageDispatchLatencyMs: null,
        latestReceipt: null,
      },
      kpis: {
        elapsedMs: 1_000,
        transitionCount: 3,
        checkpointCount: 0,
        redirectCount: 1,
        wakeRequestCount: 4,
        lastOutcome: "revise",
        terminalOutcome: null,
      },
    });
    expect(diagnostics.trajectory).toHaveLength(9);
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak");
    await expect(runs.diagnostics({
      companyId: randomUUID(),
      runId: started.run.id,
    })).rejects.toMatchObject({ status: 404 });
    await db.update(pipelineGraphRuns)
      .set({ currentNodeKey: "missing-from-pinned-graph" })
      .where(eq(pipelineGraphRuns.id, started.run.id));
    await expect(runs.diagnostics({
      companyId: fixture.companyId,
      runId: started.run.id,
    })).resolves.toMatchObject({
      current: { node: null },
      invariants: [{ code: "current_node_missing" }],
    });
    await db.update(pipelineGraphRuns)
      .set({ currentNodeKey: "review" })
      .where(eq(pipelineGraphRuns.id, started.run.id));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    app.use(errorHandler);
    const diagnosticsResponse = await request(app)
      .get(`/api/graph-runs/${started.run.id}/diagnostics`);
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsResponse.body).toMatchObject({
      run: { id: started.run.id, status: "paused" },
      graph: { versionId: draft.version.id },
      current: {
        node: { key: "review" },
        redirect: { reason: "cycle_no_progress" },
      },
      kpis: {
        transitionCount: 3,
        redirectCount: 1,
        lastOutcome: "revise",
      },
    });
    expect(JSON.stringify(diagnosticsResponse.body)).not.toContain("must-not-leak");

    const [diagnosticsAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Diagnostics agent",
      role: "engineer",
    }).returning();
    const agentApp = express();
    agentApp.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: diagnosticsAgent!.id,
        companyId: fixture.companyId,
        source: "agent_key",
      };
      next();
    });
    agentApp.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    agentApp.use(errorHandler);
    const deniedDiagnostics = await request(agentApp)
      .get(`/api/graph-runs/${started.run.id}/diagnostics`);
    expect(deniedDiagnostics.status).toBe(403);
    expect(deniedDiagnostics.body.details).toMatchObject({
      code: "graph_diagnostics_operator_required",
    });

    await runs.setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 5,
      idempotencyKey: "cycle:resume",
      paused: false,
      reason: "operator repaired responsibility",
      actor: { type: "user", userId: "board-user" },
    });
    const resumedDiagnostics = await runs.diagnostics({
      companyId: fixture.companyId,
      runId: started.run.id,
    });
    expect(resumedDiagnostics).toMatchObject({
      run: { status: "running", revision: 6 },
      current: { redirect: null, interruption: null },
    });

    const dispatcher = pipelineGraphOutboxService(db);
    await expect(dispatcher.claim({
      companyId: randomUUID(),
      workerId: "wrong-company-worker",
      limit: 1,
    })).resolves.toEqual([]);
    await expect(dispatcher.dispatchPending({
      companyId: fixture.companyId,
      workerId: "disabled-worker",
      enabled: false,
      wakeup: async () => {
        throw new Error("disabled dispatcher should not call heartbeat");
      },
    })).resolves.toEqual({ claimed: 0, dispatched: 0, retried: 0 });
    await expect(dispatcher.dispatchPending({
      companyId: fixture.companyId,
      workerId: "default-off-worker",
      enabled: true,
      wakeup: async () => {
        throw new Error("default-off outbox rows should not call heartbeat");
      },
    })).resolves.toEqual({ claimed: 0, dispatched: 0, retried: 0 });

    const firstClaim = await dispatcher.claim({
      companyId: fixture.companyId,
      workerId: "worker-a",
      limit: 1,
      leaseMs: 1_000,
    });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({ status: "claimed", attemptCount: 1 });
    const receipt = { heartbeatRunId: randomUUID(), accepted: true };
    await expect(dispatcher.acknowledge({
      companyId: randomUUID(),
      outboxId: firstClaim[0]!.id,
      claimToken: firstClaim[0]!.claimToken!,
      receipt,
    })).rejects.toMatchObject({ status: 404 });
    const acknowledged = await dispatcher.acknowledge({
      companyId: fixture.companyId,
      outboxId: firstClaim[0]!.id,
      claimToken: firstClaim[0]!.claimToken!,
      receipt,
    });
    expect(acknowledged).toMatchObject({ status: "dispatched", dispatchReceipt: receipt });
    const replay = await dispatcher.acknowledge({
      companyId: fixture.companyId,
      outboxId: firstClaim[0]!.id,
      claimToken: firstClaim[0]!.claimToken!,
      receipt,
    });
    expect(replay.dispatchReceipt).toEqual(receipt);
    await expect(dispatcher.acknowledge({
      companyId: fixture.companyId,
      outboxId: firstClaim[0]!.id,
      claimToken: randomUUID(),
      receipt: { accepted: false },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_wake_receipt_conflict" },
    });

    const expiredAt = new Date(Date.now() + 1_000);
    const expiring = await dispatcher.claim({
      companyId: fixture.companyId,
      workerId: "worker-a",
      limit: 1,
      leaseMs: 1_000,
      now: expiredAt,
    });
    const reclaimed = await dispatcher.claim({
      companyId: fixture.companyId,
      workerId: "worker-b",
      limit: 1,
      leaseMs: 1_000,
      now: new Date(expiredAt.getTime() + 2_000),
    });
    expect(reclaimed[0]!.id).toBe(expiring[0]!.id);
    expect(reclaimed[0]!.claimToken).not.toBe(expiring[0]!.claimToken);
    await expect(dispatcher.release({
      companyId: randomUUID(),
      outboxId: reclaimed[0]!.id,
      claimToken: reclaimed[0]!.claimToken!,
      error: "wrong company",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "graph_wake_claim_stale" },
    });
    await expect(dispatcher.release({
      companyId: fixture.companyId,
      outboxId: expiring[0]!.id,
      claimToken: expiring[0]!.claimToken!,
      error: "stale worker",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "graph_wake_claim_stale" },
    });

    await dispatcher.release({
      companyId: fixture.companyId,
      outboxId: reclaimed[0]!.id,
      claimToken: reclaimed[0]!.claimToken!,
      error: "test releases reclaimed crash-replay lease",
    });

    const [otherCompany] = await db.insert(companies).values({
      name: "Wrong Target Co",
      issuePrefix: `W${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const [otherCompanyAgent] = await db.insert(agents).values({
      companyId: otherCompany!.id,
      name: "Wrong-company agent",
      role: "engineer",
    }).returning();
    const [crossCompanyTarget] = await db
      .select()
      .from(pipelineGraphWakeOutbox)
      .where(and(
        eq(pipelineGraphWakeOutbox.status, "pending"),
        sql`${pipelineGraphWakeOutbox.payload} ->> 'runRevision' = '6'`,
      ))
      .limit(1);
    await db.update(pipelineGraphWakeOutbox)
      .set({
        payload: {
          ...crossCompanyTarget!.payload,
          dispatchEnabled: true,
          targetAgentId: otherCompanyAgent!.id,
        },
      })
      .where(eq(pipelineGraphWakeOutbox.id, crossCompanyTarget!.id));
    const crossCompanyWakeup = vi.fn();
    await expect(dispatcher.dispatchPending({
      companyId: fixture.companyId,
      workerId: "cross-company-dispatcher",
      enabled: true,
      limit: 1,
      wakeup: crossCompanyWakeup,
    })).resolves.toEqual({ claimed: 1, dispatched: 0, retried: 0 });
    expect(crossCompanyWakeup).not.toHaveBeenCalled();
    const [rejectedCrossCompanyTarget] = await db
      .select()
      .from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.id, crossCompanyTarget!.id));
    expect(rejectedCrossCompanyTarget).toMatchObject({
      status: "failed",
      dispatchReceipt: null,
      lastError: "Graph wake target agent does not belong to the outbox company",
    });

    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: fixture.companyId,
      name: "Graph target agent",
      role: "engineer",
    });
    const dispatchable = crossCompanyTarget!;
    const [linkedWorkIssue] = await db.insert(issues).values({
      companyId: fixture.companyId,
      title: "Graph-dispatched work",
      status: "todo",
      priority: "high",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: fixture.companyId,
      caseId: dispatchable.caseId,
      issueId: linkedWorkIssue!.id,
      role: "work",
    });
    await db.update(pipelineGraphWakeOutbox)
      .set({
        status: "pending",
        lastError: null,
        payload: {
          ...Object.fromEntries(
            Object.entries(dispatchable.payload).filter(([key]) => key !== "graphAssignment"),
          ),
          dispatchEnabled: true,
          targetAgentId,
        },
      })
      .where(eq(pipelineGraphWakeOutbox.id, dispatchable.id));
    const heartbeatRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const wakeCalls: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    const delivered = await dispatcher.dispatchPending({
      companyId: fixture.companyId,
      workerId: "dispatcher-a",
      enabled: true,
      limit: 1,
      wakeup: async (agentId, opts) => {
        wakeCalls.push({ agentId, opts });
        return { id: heartbeatRunId, wakeupRequestId };
      },
    });
    expect(delivered).toEqual({ claimed: 1, dispatched: 1, retried: 0 });
    expect(wakeCalls).toMatchObject([{
      agentId: targetAgentId,
      opts: {
        source: "automation",
        triggerDetail: "system",
        reason: "pipeline_graph_wake",
        idempotencyKey: dispatchable!.idempotencyKey,
        contextSnapshot: {
          pipelineGraphWake: true,
          graphRunId: dispatchable!.runId,
          graphEventId: dispatchable!.eventId,
          pipelineCaseId: dispatchable!.caseId,
          targetNodeKey: dispatchable!.targetNodeKey,
          graphAssignment: {
            runId: dispatchable!.runId,
            runRevision: dispatchable!.payload.runRevision,
            caseId: dispatchable!.caseId,
            nodeKey: dispatchable!.targetNodeKey,
            targetAgentId,
            issueId: linkedWorkIssue!.id,
          },
          issueId: linkedWorkIssue!.id,
          taskId: linkedWorkIssue!.id,
        },
        payload: {
          issueId: linkedWorkIssue!.id,
          taskId: linkedWorkIssue!.id,
        },
      },
    }]);
    const [dispatchedRow] = await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.id, dispatchable!.id));
    expect(dispatchedRow).toMatchObject({
      status: "dispatched",
      dispatchReceipt: {
        accepted: true,
        heartbeatRunId,
        wakeupRequestId,
        issueId: linkedWorkIssue!.id,
      },
    });

    await runs.setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 6,
      idempotencyKey: "cycle:pause-for-retry-test",
      paused: true,
      reason: "prepare retry fixture",
      actor: { type: "user", userId: "board-user" },
    });
    await runs.setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 7,
      idempotencyKey: "cycle:resume-for-retry-test",
      paused: false,
      reason: "prepare retry fixture",
      actor: { type: "user", userId: "board-user" },
    });
    const [retryable] = await db
      .select()
      .from(pipelineGraphWakeOutbox)
      .where(and(
        eq(pipelineGraphWakeOutbox.status, "pending"),
        sql`${pipelineGraphWakeOutbox.payload} ->> 'runRevision' = '8'`,
      ))
      .limit(1);
    await db.update(pipelineGraphWakeOutbox)
      .set({
        payload: {
          ...retryable!.payload,
          dispatchEnabled: true,
          targetAgentId,
        },
      })
      .where(eq(pipelineGraphWakeOutbox.id, retryable!.id));
    const retryNow = new Date(Date.now() + 10_000);
    await expect(dispatcher.dispatchPending({
      companyId: fixture.companyId,
      workerId: "dispatcher-b",
      enabled: true,
      limit: 1,
      now: retryNow,
      retryDelayMs: 60_000,
      wakeup: async () => {
        throw new Error("temporary heartbeat outage");
      },
    })).resolves.toEqual({ claimed: 1, dispatched: 0, retried: 1 });
    const [retriedRow] = await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.id, retryable!.id));
    expect(retriedRow).toMatchObject({
      status: "pending",
      lastError: "temporary heartbeat outage",
    });
    expect(retriedRow!.availableAt.getTime()).toBe(retryNow.getTime() + 60_000);
  });

  it("cancels graph work, pending wakes, and accepted heartbeat runs idempotently", async () => {
    const fixture = await seedLinearPipeline();
    const draft = await pipelineGraphVersionService(db).createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await pipelineGraphVersionService(db).activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "cancel-race",
      title: "Cancel race",
      actor: { type: "user", userId: "board-user" },
    });
    const [targetAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Cancellation target",
      role: "engineer",
    }).returning();
    const started = await pipelineGraphRunService(db).start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "cancel-race:start",
      actor: { type: "user", userId: "board-user" },
    });
    await pipelineGraphRunService(db).setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 1,
      idempotencyKey: "cancel-race:pause",
      paused: true,
      reason: "prepare controlled cancellation",
      actor: { type: "user", userId: "board-user" },
    });
    await pipelineGraphRunService(db).setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 2,
      idempotencyKey: "cancel-race:resume",
      paused: false,
      reason: "create a pending graph wake",
      actor: { type: "user", userId: "board-user" },
    });
    const [claimedWake] = await pipelineGraphOutboxService(db).claim({
      companyId: fixture.companyId,
      workerId: "cancel-race-dispatcher",
      limit: 1,
    });
    expect(claimedWake).toMatchObject({ status: "claimed" });
    const [acceptedHeartbeatRun] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgent!.id,
      invocationSource: "automation",
      status: "queued",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: 3,
      },
    }).returning();
    const cancelHeartbeatRun = vi.fn(async () => null);
    const runs = pipelineGraphRunService(db, { cancelHeartbeatRun });
    const cancelled = await runs.cancel({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 3,
      idempotencyKey: "cancel-race:cancel",
      reason: "operator stopped unsafe trajectory",
      actor: { type: "user", userId: "board-user" },
    });
    expect(cancelled).toMatchObject({
      changed: true,
      run: { status: "cancelled", revision: 4 },
      event: { type: "run_cancelled" },
      cancelledHeartbeatRunCount: 1,
    });
    expect(cancelHeartbeatRun).toHaveBeenCalledWith(
      acceptedHeartbeatRun!.id,
      expect.stringContaining("operator stopped unsafe trajectory"),
    );
    const wakeRows = await db.select().from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.runId, started.run.id));
    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0]).toMatchObject({
      status: "cancelled",
      claimToken: null,
      claimedBy: null,
      claimExpiresAt: null,
    });
    await expect(pipelineGraphOutboxService(db).release({
      companyId: fixture.companyId,
      outboxId: claimedWake!.id,
      claimToken: claimedWake!.claimToken!,
      error: "late dispatcher failure",
    })).resolves.toMatchObject({ status: "cancelled" });

    const replay = await runs.cancel({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 3,
      idempotencyKey: "cancel-race:cancel",
      reason: "operator stopped unsafe trajectory",
      actor: { type: "user", userId: "board-user" },
    });
    expect(replay).toMatchObject({
      changed: false,
      run: { status: "cancelled", revision: 4 },
      cancelledHeartbeatRunCount: 1,
    });
    expect(cancelHeartbeatRun).toHaveBeenCalledTimes(2);
    await expect(runs.cancel({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: 3,
      idempotencyKey: "cancel-race:cancel",
      reason: "different request",
      actor: { type: "user", userId: "board-user" },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "graph_event_idempotency_conflict" },
    });

    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: targetAgent!.id,
        companyId: fixture.companyId,
        source: "agent_key",
      };
      next();
    });
    agentApp.use("/api", pipelineRoutes(db, {
      graphHeartbeat: { cancelRun: async () => null },
    }));
    agentApp.use(errorHandler);
    const denied = await request(agentApp)
      .post(`/api/graph-runs/${started.run.id}/cancel`)
      .send({
        expectedRevision: 4,
        idempotencyKey: "cancel-race:agent-cancel",
        reason: "agent must not control cancellation",
      });
    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({
      code: "graph_control_operator_required",
    });
  });

  it("revokes an accepted graph wake synchronously when the graph revision pauses", async () => {
    const fixture = await seedLinearPipeline();
    const draft = await pipelineGraphVersionService(db).createDraft({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      entryNodeKey: "work",
      actor: { type: "user", userId: "board-user" },
    });
    await pipelineGraphVersionService(db).activate({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      actor: { type: "user", userId: "board-user" },
    });
    const ingested = await pipelineService(db).ingestCase({
      companyId: fixture.companyId,
      pipelineId: fixture.pipeline.id,
      caseKey: "pause-revokes-wake",
      title: "Pause revokes wake",
      actor: { type: "user", userId: "board-user" },
    });
    const [targetAgent] = await db.insert(agents).values({
      companyId: fixture.companyId,
      name: "Revision target",
      role: "engineer",
    }).returning();
    const started = await pipelineGraphRunService(db).start({
      companyId: fixture.companyId,
      caseId: ingested.case.id,
      idempotencyKey: "pause-revokes-wake:start",
      actor: { type: "user", userId: "board-user" },
    });
    const [acceptedHeartbeatRun] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: targetAgent!.id,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: {
        pipelineGraphWake: true,
        graphRunId: started.run.id,
        graphRunRevision: started.run.revision,
      },
    }).returning();
    const cancelHeartbeatRun = vi.fn(async () => null);
    const paused = await pipelineGraphRunService(db, { cancelHeartbeatRun }).setPaused({
      companyId: fixture.companyId,
      runId: started.run.id,
      expectedRevision: started.run.revision,
      idempotencyKey: "pause-revokes-wake:pause",
      paused: true,
      reason: "operator paused the graph",
      actor: { type: "user", userId: "board-user" },
    });

    expect(paused.run).toMatchObject({ status: "paused", revision: 2 });
    expect(cancelHeartbeatRun).toHaveBeenCalledOnce();
    expect(cancelHeartbeatRun).toHaveBeenCalledWith(
      acceptedHeartbeatRun!.id,
      expect.stringContaining("paused at revision 2"),
    );
  });
});
