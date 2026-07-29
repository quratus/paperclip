import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showroomRoutes } from "../routes/showrooms.js";

const mockIssues = vi.hoisted(() => ({
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
  defaultsPayload: { title: "Costa review", targetUrl: "https://review.example.test/app", projectId: null, triageAgentId: "charles-1" },
  expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
};

function app() {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([showroom])), limit: () => Promise.resolve([{ id: "charles-1" }]) }) }) }),
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
    mockIssues.create.mockResolvedValue({ id: "triage-1", identifier: "OPS-13" });
    mockStorage.putFile.mockResolvedValue({
      provider: "local",
      objectKey: "issues/issue-1/showroom-feedback/screenshot.png",
      contentType: "image/png",
      byteSize: 68,
      sha256: "a".repeat(64),
      originalFilename: "showroom-feedback.png",
    });
  });

  it("creates a Charles-owned intake without changing suggested source work", async () => {
    const response = await request(app())
      .post(`/api/showrooms/${token}/feedback`)
      .send({
        submissionId: "7f8eaa6b-fb17-46c1-bdae-c6a89479e0b6",
        text: "The approval area is unclear.",
        viewport: { width: 1440, height: 900 },
        context: { screen: "Approval", section: "Decision card", sourceIssueId: "17ef2c4b-1ed2-4cf8-9f4d-d7bdb0d33b13" },
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ identifier: "OPS-13" });
    expect(mockIssues.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      assigneeAgentId: "charles-1",
      status: "todo",
      description: expect.stringContaining("- Suggested work item: 17ef2c4b-1ed2-4cf8-9f4d-d7bdb0d33b13"),
    }));
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

  it("mints a link bound to the company CEO for triage", async () => {
    const response = await request(app())
      .post("/api/companies/company-1/showrooms")
      .set("host", "paperclip.test")
      .send({ title: "Costa review", targetUrl: "https://review.example.test/app", expiresInHours: 24 });

    expect(response.status).toBe(201);
  });

  it("attaches an explicitly supplied screenshot to the intake issue", async () => {
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
      issueId: "triage-1",
      issueCommentId: null,
      contentType: "image/png",
    }));
  });
});
