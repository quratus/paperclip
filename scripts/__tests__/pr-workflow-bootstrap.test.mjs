import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function jobBody(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`\n  ${nextName}:`, start);
  assert.notEqual(start, -1, `missing ${name} job`);
  assert.notEqual(end, -1, `missing ${nextName} boundary`);
  return workflow.slice(start, end);
}

test("PR consumers build server workspace dependencies after install", () => {
  assert.equal(
    packageJson.scripts["ci:build-server-deps"],
    "pnpm --filter '@paperclipai/server^...' build",
  );

  for (const [name, nextName, consumer] of [
    ["typecheck_release_registry", "general_tests", "pnpm run typecheck:build-gaps"],
    ["general_tests", "verify", "pnpm test:run:general"],
    ["verify_serialized_server", "canary_dry_run", "pnpm test:run:serialized"],
    ["e2e", "PLACEHOLDER_END", "pnpm run test:e2e"],
  ]) {
    const body = nextName === "PLACEHOLDER_END"
      ? workflow.slice(workflow.indexOf(`  ${name}:`))
      : jobBody(name, nextName);
    const installIndex = body.indexOf("pnpm install --frozen-lockfile");
    const bootstrapIndex = body.indexOf("pnpm ci:build-server-deps");
    const consumerIndex = body.indexOf(consumer);
    assert.ok(installIndex >= 0, `${name} must install dependencies`);
    assert.ok(bootstrapIndex > installIndex, `${name} must bootstrap after install`);
    assert.ok(consumerIndex > bootstrapIndex, `${name} must consume artifacts after bootstrap`);
  }
});
