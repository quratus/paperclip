import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexEnvironmentTestRuntimeEnv } from "./test.js";

const { prepareManagedCodexHomeMock } = vi.hoisted(() => ({
  prepareManagedCodexHomeMock: vi.fn(),
}));

vi.mock("./codex-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-home.js")>();
  return {
    ...actual,
    prepareManagedCodexHome: prepareManagedCodexHomeMock,
  };
});

describe("buildCodexEnvironmentTestRuntimeEnv", () => {
  const oldPaperclipHome = process.env.PAPERCLIP_HOME;
  const oldPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  afterEach(() => {
    prepareManagedCodexHomeMock.mockReset();
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldPaperclipInstanceId;
  });

  it("uses explicit CODEX_HOME from adapter env", async () => {
    const explicitHome = path.join(os.tmpdir(), "paperclip-explicit-codex-home");

    const result = await buildCodexEnvironmentTestRuntimeEnv(
      { env: { CODEX_HOME: explicitHome } },
      "company-1",
    );

    expect(result.effectiveCodexHome).toBe(explicitHome);
    expect(result.env.CODEX_HOME).toBe(explicitHome);
    expect(result.runtimeEnv.CODEX_HOME).toBe(explicitHome);
    expect(prepareManagedCodexHomeMock).not.toHaveBeenCalled();
  });

  it("uses the per-company managed CODEX_HOME by default", async () => {
    process.env.PAPERCLIP_HOME = path.join(os.tmpdir(), "paperclip-home-for-codex-test");
    process.env.PAPERCLIP_INSTANCE_ID = "instance-a";
    const managedHome = path.join(
      process.env.PAPERCLIP_HOME,
      "instances",
      process.env.PAPERCLIP_INSTANCE_ID,
      "companies",
      "company-1",
      "codex-home",
    );
    prepareManagedCodexHomeMock.mockResolvedValue(managedHome);

    const result = await buildCodexEnvironmentTestRuntimeEnv({}, "company-1");

    expect(result.effectiveCodexHome).toBe(managedHome);
    expect(result.env.CODEX_HOME).toBe(managedHome);
    expect(result.runtimeEnv.CODEX_HOME).toBe(managedHome);
    expect(result.runtimeEnv.PATH?.split(path.delimiter)).toContain(path.join(os.homedir(), ".local", "bin"));
    expect(prepareManagedCodexHomeMock).toHaveBeenCalledOnce();
  });
});
