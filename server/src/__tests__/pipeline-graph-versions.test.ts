import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  pipelineCases,
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
    await db.delete(heartbeatRuns);
    await db.delete(pipelineCases);
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
});
