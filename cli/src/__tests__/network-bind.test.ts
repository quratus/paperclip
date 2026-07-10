import { describe, expect, it, vi } from "vitest";
import { resolveRuntimeBind, validateConfiguredBindMode } from "@paperclipai/shared";
import { buildPresetServerConfig } from "../config/server-bind.js";

// Keep Tailscale detection hermetic: simulate a host without Tailscale so the
// "no tailscale address available" fallback assertions don't pick up a real
// tailnet IP when the dev/CI machine happens to be on a tailnet. Every other
// execFileSync call passes through unchanged.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: ((file: string, args?: unknown, options?: unknown) => {
      if (file === "tailscale") throw new Error("tailscale unavailable (mocked)");
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
    }) as typeof actual.execFileSync,
  };
});

describe("network bind helpers", () => {
  it("rejects non-loopback bind modes in local_trusted", () => {
    expect(
      validateConfiguredBindMode({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bind: "lan",
        host: "0.0.0.0",
      }),
    ).toContain("local_trusted requires server.bind=loopback");
  });

  it("resolves tailnet bind using the detected tailscale address", () => {
    const resolved = resolveRuntimeBind({
      bind: "tailnet",
      host: "127.0.0.1",
      tailnetBindHost: "100.64.0.8",
    });

    expect(resolved.errors).toEqual([]);
    expect(resolved.host).toBe("100.64.0.8");
  });

  it("requires a custom bind host when bind=custom", () => {
    const resolved = resolveRuntimeBind({
      bind: "custom",
      host: "127.0.0.1",
    });

    expect(resolved.errors).toContain("server.customBindHost is required when server.bind=custom");
  });

  it("stores the detected tailscale address for tailnet presets", () => {
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("100.64.0.8");

    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
  });

  it("falls back to loopback when no tailscale address is available for tailnet presets", () => {
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("127.0.0.1");
  });
});
