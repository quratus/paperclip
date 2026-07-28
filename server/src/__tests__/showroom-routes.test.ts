import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showroomRoutes } from "../routes/showrooms.js";

const mockIssues = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  create: vi.fn(),
  createAttachment: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockStorage = vi.hoisted(() => ({ putFile: vi.fn() }));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssues,
  logActivity: mockLogActivity,
}));

const token = "pcp_showroom_test-token";
const now = new Date();
const showroom = {
  id: "showroom-1",
  companyId: "company-1",
  defaultsPayload: { title: "Costa review", targetUrl: "https://review.example.test/app", projectId: null },
  expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
};

function app() {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([showroom])) }) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "showroom-1", expiresAt: showroom.expiresAt }]) }) }),
  };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = { type: "board", userId: "user-1", source: "local_implicit" };
    next();
  });
  server.use("/api", showroomRoutes(db as never, mockStorage as never));
  server.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: { message: error.message } });
  });
  return server;
}

describe("showroom feedback routing", () => {
  beforeEach(() => {
    Object.values(mockIssues).forEach((mock) => mock.mockReset());
    mockLogActivity.mockReset();
    mockStorage.putFile.mockReset();
    mockIssues.getById.mockResolvedValue({ id: "issue-1", companyId: "company-1", identifier: "OPS-12", status: "done" });
    mockIssues.update.mockResolvedValue({ id: "issue-1", companyId: "company-1", identifier: "OPS-12", status: "todo" });
    mockIssues.addComment.mockResolvedValue({ id: "comment-1" });
    mockStorage.putFile.mockResolvedValue({
      provider: "local",
      objectKey: "issues/issue-1/showroom-feedback/screenshot.png",
      contentType: "image/png",
      byteSize: 68,
      sha256: "a".repeat(64),
      originalFilename: "showroom-feedback.png",
    });
  });

  it("adds contextual feedback to matched work and reopens completed work", async () => {
    const response = await request(app())
      .post(`/api/showrooms/${token}/feedback`)
      .send({
        submissionId: "7f8eaa6b-fb17-46c1-bdae-c6a89479e0b6",
        text: "The approval area is unclear.",
        viewport: { width: 1440, height: 900 },
        context: { screen: "Approval", section: "Decision card", sourceIssueId: "17ef2c4b-1ed2-4cf8-9f4d-d7bdb0d33b13" },
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ identifier: "OPS-12", routed: true, reopened: true });
    expect(mockIssues.update).toHaveBeenCalledWith("issue-1", { status: "todo" });
    expect(mockIssues.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("- Section: Decision card"),
      {},
      expect.objectContaining({ authorType: "system" }),
    );
    expect(mockIssues.create).not.toHaveBeenCalled();
  });

  it("mints an expiring public review link for an authenticated company user", async () => {
    const response = await request(app())
      .post("/api/companies/company-1/showrooms")
      .set("host", "paperclip.test")
      .send({ title: "Costa review", targetUrl: "https://review.example.test/app", expiresInHours: 24 });

    expect(response.status).toBe(201);
    expect(response.body.url).toMatch(/^http:\/\/paperclip\.test\/showroom\/pcp_showroom_/);
    expect(response.body.expiresAt).toBeTruthy();
  });

  it("creates a human-triage issue when no same-company source work is available", async () => {
    mockIssues.getById.mockResolvedValue({ id: "other-company-work", companyId: "company-2", status: "done" });
    mockIssues.create.mockResolvedValue({ id: "triage-1", identifier: "OPS-13" });

    const response = await request(app())
      .post(`/api/showrooms/${token}/feedback`)
      .send({
        submissionId: "3219d411-d429-47dd-8dc9-5f3494044b21",
        text: "The approval area is unclear.",
        viewport: { width: 1440, height: 900 },
        context: { sourceIssueId: "17ef2c4b-1ed2-4cf8-9f4d-d7bdb0d33b13" },
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ identifier: "OPS-13", routed: false, reopened: false });
    expect(mockIssues.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ status: "backlog" }));
  });

  it("attaches an explicitly supplied screenshot to the routed feedback comment", async () => {
    const response = await request(app())
      .post(`/api/showrooms/${token}/feedback`)
      .send({
        submissionId: "c59fce25-9f88-4cd4-a74a-b28e8fecb543",
        text: "This control needs more explanation.",
        viewport: { width: 1440, height: 900 },
        context: { sourceIssueId: "17ef2c4b-1ed2-4cf8-9f4d-d7bdb0d33b13" },
        screenshotDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+Gyr7AAAAAElFTkSuQmCC",
      });

    expect(response.status).toBe(201);
    expect(mockStorage.putFile).toHaveBeenCalledOnce();
    expect(mockIssues.createAttachment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      issueCommentId: "comment-1",
      contentType: "image/png",
    }));
  });
});
