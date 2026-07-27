import { describe, expect, it } from "vitest";
import { resolveJobCompanyIds } from "./plugin-job-scheduler.js";

describe("company-scoped plugin job routing", () => {
  it("fans company jobs across configured companies and keeps instance jobs singular", () => {
    const result = resolveJobCompanyIds([
      { id: "company-job", pluginId: "plugin-a", scope: "company" },
      { id: "instance-job", pluginId: "plugin-a", scope: "instance" },
      { id: "unconfigured-job", pluginId: "plugin-b", scope: "company" },
    ], [
      { pluginId: "plugin-a", companyId: "company-1" },
      { pluginId: "plugin-a", companyId: "company-2" },
    ]);

    expect(result.get("company-job")).toEqual(["company-1", "company-2"]);
    expect(result.get("instance-job")).toEqual([null]);
    expect(result.get("unconfigured-job")).toEqual([]);
  });
});
