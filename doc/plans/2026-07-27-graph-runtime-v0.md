# Graph Runtime v0

Status: Slice 0 deployed; Slice 1 implemented and under independent review
Date: 2026-07-28
Target: `quratus/paperclip` (`myfork`)
Product surfaces: standalone Paperclip and Paperclip embedded in Meteor

## Purpose

Turn Paperclip's existing mutable pipeline graph into a trustworthy, version-pinned execution substrate. The first authoritative workflow is gate disposition:

```text
allow → continue
redirect → capable owner → repair → return
interrupt_external → exact prerequisite → resume
```

The immediate regression fixture is SQN-4702: a missing Product Truth Contract must redirect to an eligible product-definition owner and preserve the denied implementer as return owner. It must not produce a refusal-only block or wake the denied implementer.

## Existing foundation

Reuse rather than replace:

- `pipelines`, `pipeline_stages`, `pipeline_transitions`;
- `pipeline_cases` with optimistic `version` and case leases;
- append-only `pipeline_case_events`;
- pipeline automation executions and idempotency keys;
- agent wakeup request infrastructure;
- company-scoped access and activity logging.

Current gaps:

- stage/edge definitions mutate in place while active cases reference them;
- no immutable graph-definition version or hash is pinned to a case;
- no compile rejection for unreachable nodes, dead ends, or uncontracted cycles;
- transition labels are descriptive rather than typed outcomes;
- responsibility redirects and return ownership are not graph-runtime primitives;
- no standalone-versus-embedded conformance fixture.

The named regression currently bypasses pipelines entirely: SQN-4702 has no
`pipeline_case_issue_links` row and no execution policy. Checkout calls
`assertIssueAdmissionContract` directly, returns HTTP 422, and the successful-run
handoff later routes the missing disposition back to the denied implementer.
Graph infrastructure is not allowed to proceed as a separate authoritative path.

## Non-negotiable rules

- Paperclip remains the only execution and graph-state authority.
- Meteor consumes the same Graph API/events; it does not own transitions or run state.
- Every record is company-scoped.
- Schema changes are additive and migration-backed.
- Existing pipeline behavior remains compatible until a pipeline explicitly activates a compiled definition.
- No agent can modify the graph definition governing its current case.
- No raw agent UUID chosen by a model becomes authoritative routing.
- No live agents, customer workflows, deployment, packaging, or upstream mutation in v0.
- Tests stop at shared logic, database/service integration, and API contract layers. DMG/installer testing is out of scope.

## Slice 0 — Typed admission disposition on the real issue path

### Demo outcome

Issue admission produces a typed `allow`, `redirect`, or `interrupt_external`
disposition. A missing Product Truth Contract or execution policy no longer
returns a refusal-only response that leaves the denied agent responsible.

### Atomic tasks

1. Extract a pure typed admission evaluator from the route assertion.
2. Define an admission redirect envelope containing reason, missing requirements,
   required capability, previous/return owner, and resolver version.
3. Resolve the repair owner deterministically from the active manager chain and
   agent invokability; never accept a model-selected agent id.
4. In one transaction, lock the issue, create/reuse an `issue_recovery_actions`
   admission redirect, move the issue to refinement-ready backlog ownership, and
   persist the idempotent canonical manager-wake intent in the recovery action.
5. Return a typed redirect response to the denied checkout caller.
6. When the admission contract becomes valid, resolve the redirect and return
   ownership atomically before implementation checkout.
7. Add a sanitized SQN-4702 replay fixture and ensure successful-run recovery
   cannot route an admission denial back to the denied implementer.
8. Reconcile missing, failed, completed-without-repair, and terminal-coalesced
   wake attempts with compare-and-swap retry claims and bounded board escalation.

### Validation

- Pure allow/redirect tests for every missing admission field and `docs_ops`.
- Route/service tests for same-company manager selection, no candidate,
  concurrent redirect, duplicate request, stale issue state, and return ownership.
- SQN-4702 fixture: denied Implementer Codex2 → The CTO refinement → Implementer
  Codex2 return; source issue never enters generic `blocked`.
- All three admission entry points—checkout, backlog→todo, and non-backlog
  reassignment—produce the same typed redirect behavior.

### Guardrail

If redirect cannot be made atomic with its durable wake intent in the existing
issue/recovery model, stop before changing checkout behavior and implement that
transactional boundary first.

## Slice 1 — Compile immutable draft graph definitions

### Demo outcome

An operator can preview and persist the current stages/transitions of a pipeline
as an immutable, content-addressed **draft** definition. Invalid graphs are
rejected with structured diagnostics. Drafts cannot activate, pin cases, or
change execution behavior in this slice.

### Atomic tasks

1. **Shared graph definition contract and compiler**
   - Define normalized node, edge, cycle-contract, definition, diagnostic, and compile-result types.
   - Canonicalize deterministically in the shared compiler and calculate a
     SHA-256 definition hash at the persistence boundary.
   - Reject duplicate keys, unknown endpoints, missing entry, unreachable nodes, nonterminal dead ends, ambiguous outcome edges, and cycles without contracts.
   - Validate cycle limits and exit edges.
   - Tests cover ordering-invariant hashes and every rejection class.

2. **Immutable draft persistence**
   - Add `pipeline_graph_versions` with company/pipeline/version/hash/definition/status/creator/timestamps.
   - Persist only `draft`/`retired` versions; no active pointer or case FK yet.
   - Enforce foreign keys, uniqueness, status checks, and access-path indexes.
   - Generate and validate an additive migration.

3. **Preview contract**
   - `POST /api/pipelines/:pipelineId/graph/compile-preview`.
   - Request: entry node key plus optional cycle contracts.
   - Response: normalized definition and structured diagnostics; no mutation.

4. **Persist draft contract**
   - `POST /api/pipelines/:pipelineId/graph/versions`.
   - Same compile input; the canonical definition hash is the idempotency key.
   - Compile the current pipeline inside a transaction.
   - Reuse an identical hash idempotently; otherwise allocate the next version under a pipeline-scoped lock.
   - Expose list/get endpoints with company access, pagination, permission checks,
     activity logging, and consistent errors.
   - Do not activate, pin, or mutate cases.

### Validation

- Shared compiler unit tests.
- Migration generation and migration policy checks.
- Pipeline service tests for idempotent compile, concurrent version allocation, company isolation, and immutable reads.
- Route tests for authorization, invalid definitions, compile result, and activity entry.
- Package/server typechecks.

### Slice 1 implementation evidence

- Additive migration and database typecheck/migration-safety checks pass.
- Shared compiler plus embedded-Postgres service/API suite: 8 focused tests pass.
- Concurrent identical writes coalesce to one immutable version.
- Composite company/pipeline foreign key rejects cross-tenant persistence at the
  database boundary.
- Full server typecheck adds no new error; three existing
  `blockedByApprovalId` errors remain in `server/src/services/issues.ts`.

## Slice 2 — Activate and enforce pinned transitions

### Demo outcome

A pipeline activates one immutable version through an explicit pointer and
activation event. New cases pin it and transition only along its snapshot.
Activation and pinned enforcement ship together.

### Atomic tasks

1. Add `pipelines.active_graph_version_id`, case graph-version/node keys, and
   company/pipeline-safe references.
2. Add immutable activation with version/activity history and stale-client checks.
3. Resolve transition targets from the pinned snapshot.
4. Block stage/edge deletion or mutation from changing pinned-case semantics.
5. Add per-case event sequence, causal/version metadata, and deterministic reconstruction.
6. Add crash/replay and concurrent-transition fixtures.

### Validation

- Exact event reconstruction tests.
- Duplicate and stale transition tests.
- Cycle-cap, exit-edge, repeated-state, and version-drift tests.

## Slice 3 — Bounded cycles and progress enforcement

### Demo outcome

A pinned case derives cycle counts from its ordered events and exits on pass,
budget, cap, or no progress.

### Atomic tasks

1. Add event-derived cycle counters and path fingerprints.
2. Add typed exhaustion/no-progress outcomes.
3. Enforce token/cost/time/attempt budgets from persisted state.
4. Compose external interruptions with existing interactions/approvals instead of
   creating a second human-in-the-loop store.

### Validation

- Cycle-cap, exit-edge, repeated-state, budget, and external resume tests.

## Slice 4 — Recovery, shadow mode, and portable conformance fixtures

### Demo outcome

Paperclip publishes portable fixtures and shadow comparisons without assigning or
waking agents. Actual Meteor utility-process/Postgres conformance is a separate,
lineage-checked Meteor slice after the Paperclip contract stabilizes.

### Atomic tasks

1. Add transactional outbox reconciliation and side-effect receipts where existing wake infrastructure is insufficient.
2. Inject failures at every stable boundary.
3. Add non-authoritative shadow evaluation and disagreement telemetry.
4. Publish runtime conformance fixtures and pinned runtime diagnostics contract.
5. Publish v0 reliability KPI queries.

### Validation

- Process death, duplicate delivery, timeout, stale lease, schema drift, evaluator failure, and restart fixtures.
- Zero invalid transitions, orphan states, stale-worker commits, and duplicate effects.

## Final definition of done

- The v0 go/no-go criteria in the Brain architecture brief pass.
- Graph state is reconstructable from immutable definition plus typed events/checkpoints.
- SQN-4702 redirects responsibility instead of refusing and returning to the denied owner.
- Existing non-compiled pipelines remain compatible.
- Paperclip publishes the contract/fixtures Meteor must consume without creating
  a second runtime.
- Evidence names targeted commands and explicitly records that DMG/installer and live agent execution were not run.

## Self-review before execution

- Slice 0 is the immediate implementation target because SQN-4702 bypasses the
  pipeline substrate entirely. The compiler may advance only as inert shared
  draft logic until the real admission path is proven.
- UI is excluded because it would force product language before runtime contracts stabilize.
- Responsibility routing is implemented before immutable definitions because a
  refusal-only gate is already causing live ownership deadlocks.
- A new parallel graph subsystem is rejected; existing pipeline semantics are the migration path.
- Kill criterion: stop if Slice 0 cannot use existing issue/recovery/wake records
  without introducing a second ownership state.
- Budget: each implementation commit should remain below roughly 150 net product
  LOC where practical; compiler topology code may exceed that only when tests
  remain separate and no behavior is bundled into it.
