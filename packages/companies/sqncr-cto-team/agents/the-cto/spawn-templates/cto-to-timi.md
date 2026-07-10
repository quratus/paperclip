# CTO → Timi Delegation Template

Use this template when assigning breadth/scale work to Timi (Kimi k2.6).

## Agent
- **Name:** Timi
- **Model:** Kimi k2.6
- **Strengths:** Large context, parallel reads, bulk changes, backend CRUD, migrations, codebase archaeology
- **Weaknesses:** Nuanced UI polish, animation finesse, "should we build this?" judgment

## Slice
[One end-to-end feature or bulk task with acceptance criteria]

## Context
[What Timi needs to know about the project, feature, or system]

## Spec
[Exact shapes, file paths, before/after rules, expected outputs]

## Files
- Read: [paths to read for background]
- Write: [paths to write output to — aim for ≤ 2 files; for bulk tasks, list the root files/patterns]

## Code Budget
- Max LOC: [number, default 150 per task]
- Max files: [number, default 2 for depth; larger allowed for true bulk tasks]
- No new abstraction layers unless 3+ callers exist

## Model Fit
This task is assigned to Timi because it is: [bulk refactor / backend CRUD / large-context analysis / migration / other breadth work].

## Boundaries
- Do NOT change: [schema, API contracts, UI polish decisions, etc.]
- Keep assigned to The Implementer (Sonnet 4.6): [any depth/nuance work]

## Quality Checks
- [ ] [Specific acceptance criterion 1]
- [ ] [Specific acceptance criterion 2]
- [ ] [Build/lint/type check passes]
- [ ] [LOC within budget]
- [ ] [No generic abstractions invented]

## If Blocked
Report back with:
1. What you attempted
2. What failed
3. What you need to continue
Do NOT improvise or work around the blocker.
