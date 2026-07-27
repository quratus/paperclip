import { describe, expect, it } from "vitest";
import { resolveAdmissionRedirectOwner } from "./issue-admission-redirect.js";

function agent(input: {
  id: string;
  reportsTo?: string | null;
  status?: string;
}) {
  return {
    id: input.id,
    companyId: "company-1",
    name: input.id,
    role: "general",
    title: null,
    icon: null,
    status: input.status ?? "idle",
    reportsTo: input.reportsTo ?? null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("resolveAdmissionRedirectOwner", () => {
  it("routes to the direct eligible manager", () => {
    const manager = agent({ id: "manager" });
    const denied = agent({ id: "implementer", reportsTo: manager.id });
    expect(resolveAdmissionRedirectOwner(denied.id, [denied, manager])?.id).toBe(manager.id);
  });

  it("walks past a paused manager to an eligible ancestor", () => {
    const cto = agent({ id: "cto" });
    const manager = agent({ id: "manager", reportsTo: cto.id, status: "paused" });
    const denied = agent({ id: "implementer", reportsTo: manager.id });
    expect(resolveAdmissionRedirectOwner(denied.id, [denied, manager, cto])?.id).toBe(cto.id);
  });

  it("does not drift through a cyclic or broken org chain", () => {
    const denied = agent({ id: "implementer", reportsTo: "manager" });
    const manager = agent({ id: "manager", reportsTo: denied.id });
    expect(resolveAdmissionRedirectOwner(denied.id, [denied, manager])).toBeNull();
    expect(resolveAdmissionRedirectOwner(denied.id, [denied])).toBeNull();
  });
});
