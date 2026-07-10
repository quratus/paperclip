---
key: sqncr-sprint-planning
name: sqncr-sprint-planning
description: "Turn a goal or plan into a well-structured Paperclip project with the sqncr guardrails — vertical value-slices, small sprints (<=3 tasks, <400 LOC), per-task code budgets (<=150 LOC), quality gates, acceptance criteria, parent/goal hierarchy, and blocker chains. Use when creating a project, breaking a goal into sprints, or writing/decomposing issues for the team. Wraps plan-to-paperclip with the quality rules that make a plan buildable."
---

# sqncr Sprint Planning Skill

Use this whenever you turn direction into executable work — a new project, a goal
broken into sprints, or a sprint broken into issues. `plan-to-paperclip` does the
mechanical conversion (markdown plan → project/sprint/task issues); **this skill is
the quality layer** that decides what a good sprint and a good issue look like.

## When to use

- You are decomposing a company/project goal into sprints.
- You are writing or reviewing the issues under a sprint.
- The board asks you to "set up a project / plan this out / create the sprints."
- You are about to run `plan-to-paperclip` and want the output to be buildable.

## The guardrails (non-negotiable)

**Slice vertically, never horizontally.**
Each sprint ships one end-to-end working increment (data → logic → UI/contract),
not a layer. "Sessions exist (DB + lifecycle + UI)" is a slice; "all the DB work"
is a layer. If a sprint can't demo something working, it's a layer — re-cut it.

**Sprint budget: ≤ 3 tasks and < 400 SLOC total.**
SLOC = non-blank, non-comment source lines. For additive tasks, count additions only;
for deletion-heavy tasks (refactors, dead-code removal), count net LOC (additions minus
deletions). If a sprint needs more, split it into two sprints. Smaller slices ship.

**Task budget: ≤ 150 SLOC per task.**
Measured the same way: non-blank, non-comment lines via `git diff` — additions-only for
new work, net for refactors. GLSL strings and locale/data-asset files count unless the
CTO pre-approves a carve-out in the sprint description. If a task will exceed ~150 SLOC,
split it or flag it before building. Put the budget in the task description so the
executor self-checks.

**One agent per sprint.**
No mid-sprint handoffs between agents. Assign the whole slice to one owner.

**No integration sprints.**
Integration happens inside every sprint. Never schedule a separate "wire it all
together" sprint at the end — that's where projects rot.

**Every sprint ends with a quality gate — and it is the single review point.**
Make the gate an explicit task, **assigned to the CTO** (the reviewer), while the
implementation tasks are assigned to one developer. The developer takes each
implementation task straight to `done` and works through the sprint without
per-task review. When the last implementation task is done, the developer pings
the CTO on the quality-gate issue (reassigns it to the CTO, `in_review`) — that one
handoff wakes the CTO to review the whole sprint at once. This avoids the CTO
re-reviewing every task individually and then again at the gate (wasted tokens).
The gate verifies: build green, tests pass, code review done, SLOC budget respected
(include actual count in the gate comment: "SLOC: X / 150"), acceptance criteria met
per task. Gate fails → CTO reassigns the offending task back to the developer and
resets the sprint to `in_progress`; don't mark done.

**Every sprint has a kill criterion. (Required — the QG rejects sprints without one.)**
A kill criterion states under what conditions the sprint should be abandoned rather
than completed: "Park this if X is not true by YYYY-MM-DD" or "Kill if usage < N after
week 1" or "Abort if integration cost > $X". Write it in the sprint description.
The kill criterion protects the team from finishing work that has already become
worthless. If you cannot write one, the sprint is either too vague or already known
to be essential — in the latter case, state why ("kill criterion: none — mandatory
compliance requirement").

**Every issue has acceptance criteria.**
A testable definition of done. If you can't write the acceptance criteria, the
issue isn't specified enough to delegate yet.

**Every non-trivial issue opens with `Requirement:` + `Intent:` lines. (SQN-2201)**
`Requirement: <named person>` — no anonymous "we should"; every requirement carries
a person's name (extends OPERATING_ALGORITHM). `Intent: <the outcome the requester
actually needs>` — the *why*, not a restatement of the *what*. Acceptance criteria
must trace back to the intent line — if they don't, the issue was scoped from the
task, not the need. This exists because ambiguous rubrics and near-duplicate
scopings filed minutes apart have both cost whole sprint iterations (SQN-2149,
SQN-2187/2188). **Kill criterion: if after 2 weeks (by 2026-07-21) the lines are
being filled with boilerplate ("Intent: do the task"), delete the convention and
report why it failed** — don't let it calcify into unread ceremony.

**Hierarchy + linkage discipline.**
- Structure: plan/project (top) → sprint issues (children) → task issues (children of sprints).
- Every issue sets `parentId` and `goalId`. Orphaned issues are context-free.
- Dependent sprints use `blockedByIssueIds` so the next sprint auto-wakes when its blockers reach `done`. Prefer first-class blockers over "blocked by X" prose.
- Reference other tickets as Markdown links: `[SQN-217](/SQN/issues/SQN-217)`.

**No scope creep.**
If you discover new work mid-sprint, file a follow-up issue — never expand the
current one past its budget.

## Workflow

### 1. Frame the slices (this skill)
Before touching the API, write the plan as vertical slices that respect the budgets
above. A good plan file looks like:

```
# <Project> — <one-line outcome>

## Sprint 1: <demoable increment>   (≤3 tasks, <400 LOC)
- Task (→ developer): <≤150 LOC> — acceptance: <testable>
- Task (→ developer): <≤150 LOC> — acceptance: <testable>
- Quality gate (→ CTO): build+tests+review+SLOC budget (note "SLOC: X/150" per task)+acceptance — the single review point

## Sprint 2: <next increment>  (blocked by Sprint 1)
...
```

Assign implementation tasks to one developer and the quality-gate task to the CTO.
The developer marks each implementation task `done` and continues; when only the
gate remains, it pings the CTO on the gate. The CTO reviews the whole sprint once
there — not per task.

### 2. Convert to Paperclip (plan-to-paperclip)
Use the `plan-to-paperclip` skill to materialize the hierarchy. It scans the
planning file, parses it into project → sprints → tasks, creates the issues, and
attaches the plan document. Run its scripts under
`~/workspace/my-app/scripts/paperclip-bridge/` (scan-plan → parse-plan →
create-project → create-issues), or follow that skill's steps directly.

### 3. Review the generated issues against the guardrails
After creation, walk the issues and confirm:
- [ ] Each sprint is a vertical slice with a demoable outcome.
- [ ] Each sprint ≤ 3 tasks, < 400 SLOC; each task ≤ 150 SLOC (budget stated in task description).
- [ ] **Every sprint has a kill criterion** (or explicit exemption with justification). ← CTO gate REJECTS if absent.
- [ ] Every issue has acceptance criteria.
- [ ] `parentId` + `goalId` set on everything; blocker chains where sprints depend.
- [ ] A quality-gate task closes each sprint, assigned to the CTO; implementation tasks assigned to one developer.
Fix anything that fails before assigning work.

### 4. Assign and protect altitude
One developer owns a sprint's implementation tasks; the CTO owns its quality gate.
The developer works tasks straight to `done` and pings the CTO on the gate only when
implementation is complete — the CTO reviews the sprint once there. As CEO, delegate
the slice with a crisp brief; as CTO, spec the tasks. Don't start the next sprint
until the current sprint's quality gate passes.

## Permission prerequisites (check before finalising task assignments)

Before writing the final sprint task list, scan each proposed task for operations that
require elevated permissions. Assigning a permission-gated task to an agent who lacks
that permission causes a mid-sprint escalation and a full board round-trip (retro SQN-1402).

| Operation | Required permission | Required assignee |
|---|---|---|
| `skills:import` / agent skill registration | `agents:create` | CEO |
| Hiring an agent / creating agent configurations | `agents:create` | CEO |
| Company-level admin operations | admin | CEO |
| Board-level decisions | board | CEO |

**Rule:** If any task in the sprint touches these operations, assign it to CEO — not CTO
or Implementer. In the sprint plan comment, list permission-gated tasks explicitly:

```
Permission-gated tasks:
- "Register updated agentic-loop skill" → CEO (requires agents:create)
```

CTO and Implementer lack `agents:create` and will always need escalation for skill
import and agent hiring. Catch this at planning time, not mid-sprint.

## Anti-patterns (reject these)

- Horizontal "backend sprint / frontend sprint" splits.
- A 600-LOC "sprint" with one giant task.
- Issues with no acceptance criteria ("improve the dashboard").
- Issues opening with an anonymous "we should..." instead of `Requirement:`/`Intent:` lines.
- A final integration sprint.
- Orphan issues (missing `parentId`/`goalId`).
- Bare ticket ids in descriptions instead of Markdown links.
- Reviewing every task individually instead of once at the sprint quality gate.
