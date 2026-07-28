import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  pipelineCases,
  pipelineCaseEvents,
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
import { pipelineGraphRunService } from "../services/pipeline-graph-runs.js";
import { pipelineGraphOutboxService } from "../services/pipeline-graph-outbox.js";
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
    await db.delete(pipelineGraphWakeOutbox);
    await db.delete(pipelineGraphRunEvents);
    await db.delete(pipelineGraphRuns);
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
    const outbox = await db.select().from(pipelineGraphWakeOutbox);
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
      .where(eq(pipelineGraphWakeOutbox.status, "pending"))
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
    const [dispatchable] = await db
      .select()
      .from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.status, "pending"))
      .limit(1);
    await db.update(pipelineGraphWakeOutbox)
      .set({
        payload: {
          ...dispatchable!.payload,
          dispatchEnabled: true,
          targetAgentId,
        },
      })
      .where(eq(pipelineGraphWakeOutbox.id, dispatchable!.id));
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
      },
    });

    const [retryable] = await db
      .select()
      .from(pipelineGraphWakeOutbox)
      .where(eq(pipelineGraphWakeOutbox.status, "pending"))
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
});
