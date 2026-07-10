---
key: plan-to-paperclip
name: plan-to-paperclip
description: >
  Convert a planning-mode markdown file into a Paperclip project with a full
  issue hierarchy (plan -> sprints -> tasks) and plan documents.
tools: Bash
---

# Plan-to-Paperclip Skill

Convert a Claude Code or Kimi Code planning-mode markdown file into a
structured Paperclip project with issues, sprints, and plan documents.

## Preconditions

1. Paperclip must be running at `http://localhost:3100` (default).
2. The `${ORG_SLUG}` company must exist (used as default).
3. Planning files live in `~/.claude/plans/` or `~/.kimi/plans/`.

## Workflow

### Step 1 — Scan for the latest plan

Run the scan tool to find the most recent plan file:

```bash
node "${BRIDGE_DIR}/scan-plan.js" --source auto
```

- For Claude: reads `~/.claude/plans/INDEX.md`, prefers `active` status, falls back to newest mtime.
- For Kimi: reads `~/.kimi/plans/`, picks newest `.md` by mtime.
- Output: JSON with `filePath`, `source`, `subject`, `status`.

### Step 2 — Parse the plan into structured JSON

```bash
node "${BRIDGE_DIR}/parse-plan.js" --file "<filePath-from-step-1>"
```

Output: JSON with `title`, `overview`, `sprints[]`, each sprint containing `tasks[]`.

### Step 3 — Check for gaps

Pipe the parsed plan into the gap checker:

```bash
node "${BRIDGE_DIR}/parse-plan.js" --file "<filePath>" | node "${BRIDGE_DIR}/check-gaps.js"
```

- If `clear: false`, list the gaps to the user and **stop**. Ask for clarification.
- If `clear: true`, proceed.

### Step 4 — Resolve Paperclip IDs

```bash
node "${BRIDGE_DIR}/resolve-ids.js" \
  --company ${ORG_SLUG} \
  --project-name "<plan-title>" \
  --goal-name "<optional-goal>" \
  --assignee-names "The Backend Dev,The Frontend Dev"
```

Output: JSON with `companyId`, `projectId`, `goalId`, `agentIds`.

- If `projectId` is null, the project does not exist yet — create it in Step 5.
- Default assignee: `The Backend Dev` (or whichever agent matches the plan domain).

### Step 5 — Create project (if missing)

If `projectId` was null in Step 4:

```bash
node "${BRIDGE_DIR}/create-project.js" \
  --company-id <companyId> \
  --name "<plan-title>" \
  --description "<overview>" \
  --goal-ids <goalId>
```

Capture the returned `projectId`.

### Step 6 — Create issue hierarchy

Build the issue tree:

```bash
node "${BRIDGE_DIR}/create-issues.js" \
  --company-id <companyId> \
  --project-id <projectId> \
  --goal-id <goalId> \
  --assignee-id <agentId> \
  --plan-json '<parsed-plan-json>'
```

This creates:
- 1 top-level issue = the plan title
- N sprint issues = children of top-level
- M task issues = children of sprint issues

Output: JSON with `topLevelIssueId`, `topLevelIdentifier`, and `created[]` list.

### Step 7 — Attach plan documents

Attach the full plan body as a `plan` document to the top-level issue:

```bash
node "${BRIDGE_DIR}/attach-plan.js" \
  --issue-id <topLevelIssueId> \
  --title "Implementation Plan" \
  --body "<full-markdown-body>"
```

Optionally attach sprint-specific plan snippets to sprint issues if the user requests it.

### Step 8 — Report summary

Respond to the user with:
- Project name and link (`/<prefix>/projects/<project-id>`)
- Top-level issue identifier and link
- Number of sprints and tasks created
- Any gaps that were auto-filled (e.g., default assignee)

## Defaults

| Parameter | Default |
|-----------|---------|
| Company | `${ORG_SLUG}` |
| Plan source | Auto-detect (Claude plans preferred if active) |
| Status for new issues | `todo` |
| Priority for top-level | `high` |
| Priority for sprints/tasks | `medium` |

## Gaps that stop conversion

The following trigger user clarification:
- Missing or "Untitled" plan title
- Zero sprints detected
- Sprint with zero tasks
- Task with unclear/missing title

## One-shot command

If the plan is known to be clear, run all steps in sequence:

```bash
PLAN=$(node "${BRIDGE_DIR}/scan-plan.js" --source auto | jq -r .filePath)
PARSED=$(node "${BRIDGE_DIR}/parse-plan.js" --file "$PLAN")
GAPS=$(echo "$PARSED" | node "${BRIDGE_DIR}/check-gaps.js")
# ...continue only if gaps.clear == true
```
