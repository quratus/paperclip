import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyChange, classifyFile } from "./classify-change.mjs";

const policy = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "change-policy.json"), "utf8"),
);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "classify-change.mjs");
const file = (path, status = "M", added = 10, deleted = 5) => ({ path, status, added, deleted });
const tierOf = (path, status, added, deleted) => classifyFile(file(path, status, added, deleted), policy).tier;
const runCli = (args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });

test("flags Paperclip schema, auth, execution, adapter, CI, and lockfile surfaces as critical", () => {
  assert.equal(tierOf("packages/db/src/schema/issues.ts"), "critical");
  assert.equal(tierOf("server/src/auth/session.ts"), "critical");
  assert.equal(tierOf("server/src/routes/issues.ts"), "critical");
  assert.equal(tierOf("server/src/services/recovery/missing-disposition.ts"), "critical");
  assert.equal(tierOf("packages/adapters/codex-local/src/index.ts"), "critical");
  assert.equal(tierOf(".github/workflows/pr.yml"), "critical");
  assert.equal(tierOf("pnpm-lock.yaml"), "critical");
});

test("flags the classifier and policy as critical", () => {
  assert.equal(tierOf("scripts/classify-change.mjs"), "critical");
  assert.equal(tierOf("scripts/change-policy.json"), "critical");
});

test("flags UI components, CSS, images, and Storybook visual assets as design", () => {
  assert.equal(tierOf("ui/src/pages/IssuesPage.tsx"), "design");
  assert.equal(tierOf("ui/src/index.css"), "design");
  assert.equal(tierOf("ui/public/paperclip-thinking.svg"), "design");
  assert.equal(tierOf("tests/storybook-visual/playwright.config.ts"), "design");
});

test("defaults docs, tests, catalog content, and isolated helper logic to non-critical", () => {
  assert.equal(tierOf("README.md"), "non-critical");
  assert.equal(tierOf("server/src/__tests__/issue-checkout.test.ts"), "non-critical");
  assert.equal(tierOf("packages/teams-catalog/catalog/bundled/company-defaults/team.json"), "non-critical");
  assert.equal(tierOf("scripts/release-lib.test.mjs"), "non-critical");
  assert.equal(tierOf("server/src/lib/formatIssueTitle.ts", "A", 40, 0), "non-critical");
});

test("escalates whole-file rewrites and source deletions", () => {
  assert.equal(tierOf("server/src/lib/small-helper.ts", "M", 220, 120), "critical");
  assert.equal(tierOf("server/src/lib/old-helper.ts", "D", 0, 25), "critical");
  assert.equal(tierOf("doc/old-note.md", "D", 0, 25), "non-critical");
});

test("aggregates routing deterministically across non-critical, design, and critical changes", () => {
  assert.deepEqual(
    classifyChange({ files: [file("README.md"), file("server/src/lib/new-helper.ts", "A", 8, 0)] }, policy),
    {
      classification: "non-critical",
      routing: "auto",
      requiresHumanApproval: false,
      requiresConformance: false,
      fileCount: 2,
      reasons: [
        { file: "README.md", tier: "non-critical", rule: "non-critical \\.(md|mdx|txt)$" },
        { file: "server/src/lib/new-helper.ts", tier: "non-critical", rule: "non-core-change" },
      ],
    },
  );

  assert.equal(classifyChange({ files: [file("ui/src/pages/IssuePage.tsx")] }, policy).requiresConformance, true);
  assert.equal(classifyChange({ files: [file("packages/db/src/schema/issues.ts")] }, policy).routing, "human");
});

test("breaking subjects and explicit human-review labels force critical routing", () => {
  assert.equal(
    classifyChange({ files: [file("README.md")], subjects: ["feat(api)!: drop issue field"] }, policy).classification,
    "critical",
  );
  assert.equal(
    classifyChange({ files: [file("README.md")], labels: ["human-review"] }, policy).routing,
    "human",
  );
});

test("CLI fails closed when the base ref cannot be resolved", () => {
  const result = runCli(["--base", "refs/does-not-exist", "--head", "HEAD", "--no-artifact"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /classify-change: ERROR:/);
  assert.match(result.stderr, /git rev-parse --verify refs\/does-not-exist\^\{commit\} failed/);
  assert.doesNotMatch(result.stdout, /CLASSIFICATION=non-critical ROUTING=auto/);
});

test("CLI rejects empty diffs unless explicitly allowed", () => {
  const rejected = runCli(["--base", "HEAD", "--head", "HEAD", "--no-artifact"]);

  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /No changed files found for HEAD\.\.\.HEAD/);
  assert.doesNotMatch(rejected.stdout, /CLASSIFICATION=non-critical ROUTING=auto/);

  const allowed = runCli(["--base", "HEAD", "--head", "HEAD", "--no-artifact", "--allow-empty"]);

  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /classify-change: 0 file\(s\) for HEAD\.\.\.HEAD/);
  assert.match(allowed.stdout, /CLASSIFICATION=non-critical ROUTING=auto/);
});
