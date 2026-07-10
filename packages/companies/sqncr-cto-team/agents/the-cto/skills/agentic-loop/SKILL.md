---
key: agentic-loop
name: agentic-loop
description: "Run a multi-cycle autonomous improvement loop: ROUTE a goal through gbrain, DECOMPOSE into sprint tasks, EXECUTE on heartbeats, DECOUPLED-CHECK with a fresh session, and LOOP-CONTROL until done or escalated. Use when an objective needs iterative agent-driven progress with external memory and honest grading."
---

# Agentic Loop Skill

Use when an objective cannot be completed in a single heartbeat and requires multiple
cycles of generate → validate → decide → iterate. This skill governs the full loop
lifecycle: from routing the goal to declaring it complete or escalating it.

## When to use

- A goal needs multi-sprint autonomous execution with minimal human oversight.
- An issue has a measurable rubric and may need multiple iterations to pass it.
- You are orchestrating a project via the goal → project → sprint → task hierarchy.

---

## Stage 1 — ROUTE

Ground the goal before acting.

1. Pull what we know from gbrain (`gbrain:query "<goal>"` + traverse linked pages).
2. Draft 2–3 candidate approaches. For each: scope, risks, measurable success signal.
3. Write a machine-checkable rubric (see Rubric/Task-Contract Schema below).
4. Present to human: approaches + rubric draft. **Human Checkpoint #1** — agree the route before decomposing. Do not proceed past this stage without explicit sign-off.
5. Record the agreed route and rubric in the brain before moving to DECOMPOSE.
6. Call `node ~/workspace/brain-platform/scripts/gate.mjs --create --loop-issue-id <id> --summary "<route title>"`. Record the approval-id printed to stdout in a brain note. Do NOT proceed to Stage 2 (DECOMPOSE) until woken with PAPERCLIP_APPROVAL_STATUS=approved.

**Goal-size guard.** If the rubric would trivially pass on iteration 1 (no natural miss potential), the goal is too small — re-route to a harder goal before human sign-off.

---

## Stage 2 — DECOMPOSE

Turn the agreed route into executable work.

**Pre-decompose child-check (mandatory, idempotency guard).** Before creating any
issues, check whether child issues already exist for the sprint/parent:

```
GET /api/companies/{companyId}/issues?parentId={sprintId}&limit=1
```

- If children exist → skip decomposition entirely. Log a comment:
  `[decompose-guard] Children already exist for {sprintId} — skipping decompose to avoid duplicates.`
- If no children exist → proceed with decomposition.

This guard is re-entrant safe: re-running DECOMPOSE on a sprint that already has
children is a no-op. Without it, two concurrent heartbeats can both pass the
parent-check and create duplicate issue trees (retro SQN-1433).

- Apply `sqncr-sprint-planning` guardrails: vertical slices, ≤ 3 tasks per sprint,
  < 400 SLOC per sprint, ≤ 150 SLOC per task, quality gate as final task.
- Each task carries its rubric: the task contract is the rubric from ROUTE, narrowed
  to what this task specifically changes.
- Wire blockers via `blockedByIssueIds` so Paperclip auto-wakes on resolution.
- External state only: Paperclip issues + brain + git. No in-memory state crosses
  heartbeat boundaries.

---

## Stage 3 — EXECUTE

Agents take tasks on heartbeats; one context-window each.

0. Verify gate: `node ~/workspace/brain-platform/scripts/gate.mjs --check --approval-id <recorded-approval-id>`. If it exits non-zero, post a comment that EXECUTE is gated pending Julius approval and exit the heartbeat.

**Mechanism required (enforced at QG).** Invoke `node scripts/loop-control.mjs --task-id $TASK_ID --iteration N`. Do NOT evaluate the rubric yourself. `loop-control.mjs` spawns an isolated blind evaluator automatically. If you post a verdict without invoking `loop-control.mjs`, the QG auto-fails — there will be no `## LoopTrace` entry in the issue comments.

- Checkout the task. Read the rubric. Do the work. Commit to git with Co-Author tag.
- Log progress to external memory: comment on the issue, update brain if new knowledge.
- On completion, post a completion comment stating SLOC and how each rubric criterion
  was met. Do not self-grade pass/fail — that is DECOUPLED-CHECK's job.
- If blocked mid-task: set status `blocked`, comment the blocker, escalate.

---

## Stage 4 — DECOUPLED-CHECK

A fresh session grades the work. The generator never grades its own output.

**Isolation rule:** a fresh session sees only `{task, rubric, artifacts}` — never the
generator's reasoning, planning comments, or intermediate notes. If the checker can see
how the generator thought, the check is invalid.

**Verdict format (required):**

```json
{
  "pass": true | false,
  "reasons": ["criterion A: met because ...", "criterion B: NOT met because ..."],
  "iteration": 1
}
```

- `pass: true` → proceed to LOOP-CONTROL with a passing verdict.
- `pass: false` → each failing reason must be actionable and specific. "Improve X" is
  not a valid reason. "X is missing because Y; fix by doing Z" is valid.
- The checker posts the verdict as a structured comment on the issue before the
  loop-control decision is made.

---

## Stage 5 — LOOP-CONTROL

Decide what happens after each DECOUPLED-CHECK verdict.

**On pass:** mark the task `done`. If all sprint tasks pass their gates, close the
sprint and move to the next, or graduate the goal if all sprints are done.

**On fail:** reopen the task (`todo`), attach the verdict's `reasons` as the new
task description addendum, increment `iteration`. The executor sees the reasons
and must address each one in the next EXECUTE pass.

**Goal-size guard.** If `iteration === 1 && verdict.pass === true`, `loop-control.mjs` emits `GOAL-TOO-SMALL` and blocks the task for re-routing. This is NOT a success.

**Caps and guards (non-negotiable):**
- Iteration cap: default 3 per task. On the 3rd consecutive fail, escalate to human
  rather than iterating again. A fourth automated attempt is not allowed.
- Token/budget cap: if spend exceeds the cycle budget (`per_cycle_budget_tokens`),
  stop, surface the partial result, escalate.
- Goal-drift re-check: at the start of each new sprint cycle, re-read the agreed
  route from the brain. If the accumulated work no longer aligns with the original
  route, pause and flag to human before continuing.
- Escalate to human on: irreversible actions (destructive deploys, schema drops),
  graduation decisions ("ship to users"), stuck loops (iteration cap hit), or any
  action outside the agent's authority.

**SAB 9-layer loop-detection:** apply the Scientific Advisory Board's 9-layer
loop-detection checklist at the start of each new cycle to confirm the loop is
making genuine progress and not oscillating. A cycle that changes nothing measurable
counts as a stuck loop even if it doesn't fail the rubric.

---

## Stage 6 — GROUNDING

Keep the loop anchored to reality.

- Read the brain at ROUTE time to seed the initial approach.
- Re-read relevant brain pages at the start of each sprint (not just the first cycle).
- If the objective involves external technical state (APIs, model capabilities, tool
  behaviour), trigger a recurring agent-space research report to keep that data current.
  Stale tech data leads to routes that were valid when written but are wrong by the
  time they execute.
- Write findings back to the brain after each sprint closes, so future loops start
  with accurate grounding.

---

## Rubric / Task-Contract Schema

Every task in an agentic loop must carry a rubric. A valid rubric contains:

| Field | Rule |
|-------|------|
| `goal_alignment` | One sentence: which part of the agreed route this task serves. |
| `criteria` | Array of verifiable pass/fail criteria. Each must be checkable from artifacts alone. |
| `anti_criteria` | What a passing submission must NOT do (regressions, scope creep). |
| `artifact_location` | Where the checker looks: file path, Paperclip comment, git diff. |

**Verifiable criterion rule:** a criterion is valid if and only if a checker with no
context beyond the artifacts can answer yes/no. "Improve recall" is invalid.
"recall@5 > 0.80 as reported in results.json" is valid.

---

## Principles

**Generator-never-grades-own-work.** The agent that produced the output is
categorically excluded from deciding whether it passed. This is enforced structurally
by DECOUPLED-CHECK, not by asking the generator to be objective.

**HITL → AFK.** Start with human-in-the-loop (HITL) checkpoints. As the loop proves
itself on a class of objective, reduce checkpoints toward autonomous execution (AFK).
Never skip a checkpoint before it has been validated as safe to skip.

**External memory only.** No state lives in an agent's context window across heartbeats.
Everything load-bearing lives in Paperclip (issues, comments, status), the brain
(knowledge, route decisions), and git (artifacts, diffs). A loop that requires an
agent to remember its prior session is a broken loop.

**Honest reporting.** Completion comments state what was done, SLOC, and how each
rubric criterion was met — not a narrative. If a criterion was not met, say so. A
false passing report is worse than a failing report.

**Separation of duties — structural.** The EXECUTE agent invokes `loop-control.mjs`; it never grades its own work. The decoupled-check is a separate blind process — it receives only `{rubric, artifact}`, never the implementation diff.

---

## QG Mechanism Check (mandatory, auto-fail if absent)

At quality-gate time, verify that `loop-control.mjs` was actually invoked:

```bash
node scripts/loop-history.mjs --task-id $TASK_ID --json
```

Required: `iterations.length >= 1`, at least one `## LoopTrace` comment with `event: invoked`.

- A direct audit with no LoopTrace entry = **AUTOMATIC FAIL** regardless of outcome quality.
- An iter-1-PASS without a goal-too-small block = **AUTOMATIC FAIL** (wrong goal size; ROUTE must select a harder goal).
