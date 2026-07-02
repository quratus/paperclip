---
name: team-coordination
description: CTO delegation workflows for the sqncr agent team. Covers vertical slice assignment, code review, and lean team coordination. For the CTO agent only.
---

# Team Coordination Skill

## When to Use

Use this skill when:
- You need to delegate a build task to The Implementer
- You are reviewing work from The Implementer, Watchdog, or Repo Janitor
- You need to coordinate a vertical slice handoff
- You need to enforce code budget compliance

## sqncr Agent Status

| Agent | Role | Status |
|-------|------|--------|
| Charles (CEO) | Strategy, delegation to CTO | Active |
| The CTO (you) | Architecture, specs, review, small slices | Active |
| The Implementer | Full-stack vertical slices | Active |
| Golem | Knowledge graph queries, reasoning | Active |
| Watchdog | Security patrol, automated hygiene fixes | Active |
| Repo Janitor | Repository hygiene, dependency updates | Active |

## 1. Task Routing

Before delegating, determine assignment based on scope:

| Task Type | Route To | Examples |
|-----------|----------|----------|
| Small vertical slice (≤ 3 tasks, < 400 LOC) | The Implementer | Build signal detector end-to-end: Cypher query → hook → UI card |
| Large feature (> 400 LOC) | Split into vertical slices, assign each to The Implementer | Dashboard redesign split into: vitals hero, IQ breakdown, attention queue |
| Security hygiene, credential scans | Watchdog | Daily patrol, `.env` drift fix, secret removal |
| README drift, stale branches, changelog | Repo Janitor | Weekly sweep, dependency grouping, merge branch cleanup |
| Architecture, cross-cutting decisions | Do directly | Schema design, tech stack decisions, system design |

**Rule:** If a task spans backend + frontend, it is ONE vertical slice assigned to The Implementer. Do NOT split by layer.

**Code budget check:** Before delegation, verify the issue has a max LOC limit. If it does not, add one. Default: 150 LOC per task, 400 LOC per slice.

## 2. Assignment Protocol

Every assignment to The Implementer MUST include:

```markdown
## Slice
[One end-to-end feature with acceptance criteria]

## Context
[What the implementer needs to know about the project, feature, or system]

## Spec
[API shapes, component specs, data models, exact file paths]

## Files
- Read: [paths to read for background]
- Write: [paths to write output to — aim for ≤ 2 files]

## Code Budget
- Max LOC: [number, default 150]
- Max files: [number, default 2]
- No new abstraction layers unless 3+ callers exist

## Quality Checks
- [ ] [Specific acceptance criterion 1]
- [ ] [Specific acceptance criterion 2]
- [ ] [Build/lint/type check passes]
- [ ] [LOC within budget]
- [ ] Clean tree at handoff: code AND its tests in the SAME commit (`git status --porcelain` empty for AC-required paths)
- [ ] Completion comment states per-task SLOC (non-blank/non-comment)

## If Blocked
Report back with:
1. What you attempted
2. What failed
3. What you need to continue
Do NOT improvise or work around the blocker.
```

## 3. Code Review Workflow

After The Implementer delivers:

### Quick Review (single file, small change)
1. Read the output
2. Check against acceptance criteria
3. **Check LOC budget** — reject if exceeded without pre-approval
4. Approve or request specific revision

### Full Review (feature, multi-file)
1. Read all changed files
2. Trace data flow end to end
3. Check types, error handling, edge cases
4. **Verify no generic abstractions were invented** (routers, hooks, design tokens with < 3 callers)
5. Spawn a review specialist if high-stakes (pattern blindness defense)
6. Approve, request revision, or reject with specific feedback

## 4. Vertical Slice Flow

### Phase 1: Spec — CTO writes exact API shapes + component contract
### Phase 2: Build — assign The Implementer the full slice (query + route + hook + component)
### Phase 3: Review — CTO checks end-to-end data flow + code budget
### Phase 4: Merge — The Implementer commits; CTO verifies in shared worktree

**No separate design phase for slices < 400 LOC.** The Implementer makes UI decisions inline. For large UI-heavy features, add design requirements to the spec.

## 5. Utility Agent Coordination

### Watchdog
- Receives security/hygiene issues directly from CTO
- Can fix LOW-severity issues directly (README drift, debug logs, `.env.example` gaps)
- Escalates CRITICAL/HIGH findings to CTO — does not patch infrastructure or auth

### Repo Janitor
- Runs weekly sweep on schedule
- Fixes README drift and stale merged branches directly
- Proposes dependency updates and changelogs — does not execute without CTO approval

## 6. Quality Gate Runbook — validate the committed tip, not the working tree

The gate judges what is **committed at HEAD**, not what happens to be sitting in the working tree. A green local test run on a dirty tree is not evidence the sprint is done — it proves the run, not the commit. Recurring failure across SQN-1210 / SQN-1181 / SQN-994 / SQN-975: the code-under-test and the test edits it needs were left uncommitted, so the committed tip was red while the handoff claimed "committed locally".

### Gate order (run in this sequence)

**0. Committed-tip check (precondition — before build/tests).**
   - Run `git status --porcelain`.
   - **Clean tree** → proceed to the rest of the gate.
   - **Dirty tree containing changes the AC requires** (the code-under-test, or the tests that exercise it) → **gate FAIL by default.** Bounce the offending task to the Implementer (`assigneeAgentId` = Implementer, `status` = `in_progress`) with a comment naming the uncommitted AC-required paths. Do not self-fix structural work.
   - **Dirty tree with only unrelated WIP** (e.g. interdependent v2.0 work co-mingled on the branch) → do NOT blindly fail. Isolate first: run the sprint-scoped tests and diff the committed tip vs HEAD (stash-vs-HEAD) to confirm the AC-relevant files are committed. Fail only if an AC-required change is among the uncommitted set. See `[[gate-shared-dirty-tree]]`.
   - **CTO discretion:** you MAY self-commit a *trivial, test-only* fix to make the tip green (as in SQN-1210, commit `1846a0f`), but you MUST note the commit SHA and what it changed in the gate comment. Anything beyond a trivial test fix bounces back.

**1. Brain-shot attachments** — for any task whose AC required screenshots, verify via `GET /api/issues/<task-id>/attachments` that at least one attachment exists. Missing → immediate FAIL, bounce to Implementer.

**2. Build green, tests pass (against the committed tip), code review, acceptance criteria per task.**

**3. SLOC budget** — read the per-task SLOC the completion comment is required to state (non-blank, non-comment). State `SLOC: X / 150` per task in the gate comment. Over budget without pre-approval → FAIL.

**4. Kill-criterion check (mandatory for all sprints).**
   Verify the sprint issue description or its plan document contains a kill criterion — a condition under which the sprint should be parked if unmet by a target date or milestone. Accept any of these forms:
   - `Kill criterion:` or `Kill if:` or `Park if:` followed by a condition
   - A sentence of the form "park/cancel this sprint if [condition] by [date/milestone]"

   If the kill criterion is **absent**:
   - Set status `in_progress` (changes requested), reassign to sprint owner.
   - Comment: "Missing kill criterion. Add a line — e.g. `Kill criterion: park this sprint if [condition] by [date].` Then resubmit."
   - Gate FAIL. Do not proceed to step 5.

   If the kill criterion is **present**: note it verbatim in the gate comment and continue.

**5. Bug-fix behavioral proof (IVX doctrine — mandatory for every bug-fix sprint).**

A bug fix is **not proven** unless the sprint carries at least ONE of:

- **(a) Regression test** — a test that FAILED before the fix and PASSES after it. Verify by reverting the fix hunk, running the suite, confirming failure, then restoring. The test must be committed.
- **(b) BRAIN_SHOT** — a timestamped screenshot attached to the task issue (confirmed via `GET /api/issues/<task-id>/attachments`) showing the fixed behavior in the running app. `[ARTIFACT]`-only attachments do not satisfy this; the shot must show live running state.
- **(c) decoupled-check PASS** — a `decoupled-check.mjs` PASS verdict that names the specific fixed behavior with `[LIVE]` evidence (not `[ARTIFACT]` only).

**If none of (a), (b), or (c) is present → gate FAIL.** Mark the offending task `in_progress`, reassign to the Implementer, and state exactly which proof is missing. "The code looks correct" is not proof.

This step applies **only to bug-fix sprints**. Feature sprints that have no bug fix goal are exempt. When in doubt, treat the sprint as a bug-fix sprint and require proof.

### Task-done protocol (enforce on every implementation task)

- **"done" / "committed locally" requires a CLEAN tree.** The code AND the tests it needs land in the SAME commit. A green local run with a dirty `git status` is explicitly **not done** — it is a bounce.
- The completion comment MUST state per-task **SLOC** (non-blank/non-comment) so the gate catches budget overage without re-counting. No SLOC line → treat as incomplete handoff.

## Spawn Template Reference

Templates in `spawn-templates/`:
- `cto-to-implementer.md` — Full-stack slice delegation
- `cto-to-watchdog.md` — Security patrol delegation
- `cto-to-janitor.md` — Hygiene sweep delegation
