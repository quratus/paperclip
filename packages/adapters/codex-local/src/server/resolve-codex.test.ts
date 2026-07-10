import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexPathWithFallbacks, resolveCodexCommand } from "./resolve-codex.js";

describe("resolveCodexCommand", () => {
  it("prepends common Codex install directories to PATH", () => {
    const value = codexPathWithFallbacks("/usr/bin");

    expect(value.split(path.delimiter)).toEqual(
      expect.arrayContaining([
        path.join(os.homedir(), "bin"),
        path.join(os.homedir(), ".local", "bin"),
        path.join(os.homedir(), ".bun", "bin"),
        path.join(os.homedir(), "workspace", "gbrain", "bin"),
        path.join(os.homedir(), ".codex", "packages", "standalone", "current", "bin"),
        "/usr/bin",
      ]),
    );
  });

  it("resolves codex from a fallback-style bin directory when PATH is minimal", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-bin-"));
    const bin = path.join(tmp, "codex");
    await fs.writeFile(bin, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(bin, 0o755);

    await expect(resolveCodexCommand("codex", tmp)).resolves.toBe(bin);
  });

  it("exposes gbrain from the user shim directory when PATH is minimal", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-home-"));
    const binDir = path.join(tmpHome, "bin");
    const gbrain = path.join(binDir, "gbrain");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(gbrain, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(gbrain, 0o755);

    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const value = codexPathWithFallbacks("/usr/bin");
      expect(value.split(path.delimiter)[0]).toBe(binDir);
      await expect(resolveCodexCommand("gbrain", value)).resolves.toBe(gbrain);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
