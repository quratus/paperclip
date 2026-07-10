---
key: specification-mode
name: specification-mode
description: Charles's discovery gate for board-derived product ideas. BEFORE any feature is specced, scoped into the production pipeline, or built, interrogate it — user value, product value, fit vs. separate-product, evidence — and produce a discovery doc with a recommendation. Never let an idea jump from a Telegram voice message straight to a buildable issue.
---

# Specification Mode

A board conversation (the Telegram "Brain Board") produces raw ideas and decisions. Most are
half-formed: "we should add X", "what if the brain did Y". Left unchecked, these become production
issues with no context, no validated value, and no scope — and the production pipeline clogs with
features nobody deeply needed.

**Specification Mode is the gate.** When a product-relevant board item lands (e.g. an issue in the
`Specs` project), you do NOT scope it, delegate it, or open production work. You run discovery first,
then bring a recommendation to Julius. Julius decides whether it graduates. You command the product
team; you do **not** command the product *roadmap* out of a voice note.

## Hard Rules

- **Never** create production issues, delegate to the Implementer, or open a project from a `Specs`
  item until Julius has signed off on the discovery doc.
- **Never** assume the idea is worth building. Default posture is skeptical: most ideas should be
  parked or killed, not built.
- **Always** end with an explicit recommendation and the open questions only Julius can answer.
- Ask **one cluster of questions at a time** in the issue thread; wait for answers. Discovery is a
  conversation with Julius, not a form you fill in alone.
- A spec is the *output* of discovery, never the input. Do not write implementation specs here — that
  is the `spec-writer` skill's job, and only after graduation.

## When To Use

- A new item appears in the `Specs` project (board-derived product idea).
- Julius or the board asks "should we build X?" and the answer isn't obviously yes.
- Any time an idea would otherwise go straight from conversation to production.

## The Discovery Process

Work the item's issue thread. Capture everything in the issue's `discovery` document
(`PUT /api/issues/{id}/documents/discovery`), not the description.

### Phase 1 — Restate the raw idea

Quote the originating board snippet (it's linked from the brain digest). In one sentence: "Someone
proposed that we ___." Resist interpreting it yet. If you can't tell what was actually proposed, that
itself is the first question for Julius.

### Phase 2 — Interrogate the value (ask Julius)

Post these as a focused question cluster. Do not proceed until answered.

**User value**
- Who is the user, specifically? (which ICP — non-technical founder? us internally?)
- What job are they trying to do that they can't do today, or can't do well?
- How do they solve it now (workaround, competitor, nothing)? How painful is that, really?
- Is this a vitamin or a painkiller?

**Product value**
- Does this strengthen the *core* of the Brain Platform (knowledge base + Guardian org layer), or is
  it adjacent?
- Does it deepen something we already do, or add a new surface? (New surfaces are expensive — justify.)
- How would we know it worked? What's the one metric or signal that moves?

**Strategic fit**
- Does this fit the current milestone (v2.0 release-readiness / shippable DMG), or does it compete
  with it for attention? If it competes, why now?
- Is this a feature of the Brain Platform, or is it actually a **separate product**? (See Phase 3.)

### Phase 3 — Fit vs. separate-product test

Force the question explicitly. An idea is a *separate product* (and should NOT clutter the Brain
Platform) if any of these hold:
- It serves a different user than the Brain Platform's ICP.
- It has its own pricing / sales motion.
- It could be ripped out and sold/used standalone with little loss.
- Building it inside the Brain Platform would distort the platform's core story.

State a verdict: **feature of the platform** | **separate product** | **internal tooling** | **unclear**.

### Phase 4 — Cost & alternatives (your judgment as CTO)

- Rough build cost (S / M / L) and which layers it touches.
- What does NOT change — the anti-scope.
- Cheapest version that would still deliver the value (the "thinnest slice").
- At least one alternative, including "do nothing" and why that might be right.

### Phase 5 — Recommendation

End the discovery doc with one of:

- **GRADUATE** — value is validated and it fits. Propose the thinnest slice and the acceptance signal.
  Only after Julius approves do you hand to `spec-writer` → `sqncr-sprint-planning` for production.
- **SEPARATE PRODUCT** — promising but doesn't belong in the platform. Park it as its own concept for
  Julius, do not build inside the platform.
- **PARK** — plausible but not now (wrong milestone, weak evidence). Keep the discovery doc; revisit.
- **DROP** — vitamin, poor fit, or better alternative exists. Say so plainly.

Then reassign the issue back to Julius (`assigneeUserId`), status `in_review`, with a comment that
links the discovery doc and states the recommendation in one line. **Do not mark it done. Do not
build.**

## Output Shape (discovery document)

```
# Discovery — <idea>

## Raw idea
> <quoted board snippet> (source: <brain digest path / issue link>)

## User value
- user / job / current workaround / painkiller-or-vitamin

## Product value
- core-or-adjacent / deepen-or-new-surface / success signal

## Strategic fit
- milestone fit / competes-with-what

## Fit verdict
feature | separate product | internal tooling | unclear — because ...

## Cost & alternatives
- size / layers / anti-scope / thinnest slice / alternatives (incl. do-nothing)

## Recommendation
GRADUATE | SEPARATE PRODUCT | PARK | DROP — one-line rationale
Open questions for Julius: ...
```

## Relationship to other skills

- `specification-mode` (this) → validates **whether** to build. Output: discovery doc + recommendation.
- `spec-writer` → defines **how** to build. Only after GRADUATE + Julius sign-off.
- `sqncr-sprint-planning` → breaks the approved spec into guarded sprints/issues.

The order is non-negotiable: discovery → Julius sign-off → spec → sprint plan → production.
