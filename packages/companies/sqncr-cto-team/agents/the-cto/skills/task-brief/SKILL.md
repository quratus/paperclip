---
key: task-brief
name: task-brief
description: "Compile a task into a precise, executable brief on a cheap model BEFORE any expensive model run, any delegation to another agent, or any autonomous loop. A sloppy prompt costs the same credits as a perfect one. Use when about to run Fable/Opus, write an issue for another agent, escalate a blocker, or kick off long autonomous work."
---

# Task Brief — compile before you spend

A frontier-model run bills the same whether the prompt is sharp or sloppy. The
difference is that the sloppy prompt bills **three times** — once per failed
attempt. This skill turns "go fix the search" into something a model (or agent)
can execute in one pass.

## When to compile a brief

- Before ANY run on Fable 5 or Opus 4.8 (see [[model-economy]]).
- Before delegating: an issue assigned to another agent IS a brief — a bad issue
  description makes the *receiving* agent burn the tokens you saved.
- Before starting an autonomous loop or multi-hour run on any tier.
- When escalating a blocker to a higher tier (the "consult" in
  [[model-economy]]'s escalation protocol is a brief about the blocker).
- NOT for small same-session work on a cheap model — a brief that costs more
  than the task is waste. One-session-one-file on Sonnet: just do it.

## The brief format

Compile on **Sonnet 5** (or whatever cheap tier you are). Do the code/file
reconnaissance on the cheap model too — that's the whole point.

```markdown
## Outcome
One sentence: the state of the world when this is done. Not activity — outcome.
("Users can X" / "The release gate fails when Y" — not "improve Z".)

## Acceptance criteria
- [ ] Testable, machine-checkable statements. Each one answerable yes/no by
      running something. If you can't write these, the task is not specified
      enough to spend money on — investigate first.

## Files & entry points
- path/to/file.ts — what role it plays
- The executor should NOT have to rediscover the territory you already scouted.

## Constraints & don'ts
- Branch/target rules, LOC budget, do-not-touch zones, style expectations,
  known traps ("X looks like the cause but isn't — already ruled out").

## Definition of done
Build/tests/verification commands that must pass, and what evidence to report
(command output, not claims — see [[fable-mindset]] §reality-over-intention).

## Stop conditions
When to abort instead of grinding: "if X turns out true, stop and report"
/ "if not done in N turns, stop and write findings". Every autonomous run
needs an abort line, or it will spend your budget proving it can't.

## Out of scope
What NOT to do, explicitly. Scope creep in an autonomous run is unbounded cost.
```

## The self-check (before sending)

1. **Stranger test:** could a competent model with *zero* conversation context
   execute this? If it needs anything you know but didn't write, write it.
2. **Yes/no test:** is every acceptance criterion checkable by running a
   command or looking at one screen? "Works well" fails this test.
3. **Recon done?** Did you list the actual files, or is the expensive model
   going to spend its first 20 minutes doing `grep` a cheap model could have done?
4. **Abort line present?** No stop condition = unbounded spend.
5. **Cheaper-tier test (last):** now that the brief exists — does this still
   need the expensive tier? A good brief frequently downgrades the task. That
   is the brief paying for itself; when in doubt, run it once on Sonnet first.

## Paperclip mesh

An issue that satisfies `sqncr-sprint-planning` (acceptance criteria, LOC budget,
kill criterion) is 80% of a brief already. When writing issues for other agents,
add the missing 20%: **files & entry points** and **known traps**. The kill
criterion of a sprint and the stop condition of a brief are the same idea at
different altitudes.

## Anti-patterns

- "Fix the search" / "make it faster" / "clean this up" sent to a paid tier.
- Acceptance criteria that restate the outcome ("search works better").
- Making the expensive model do reconnaissance a cheap model already did — or
  worse, could have done.
- A 2-page brief for a 20-line task (brief cost > task cost).
- Delegating an issue whose description you wouldn't accept as a brief yourself.

## The chain

[[model-economy]] decides the tier → **task-brief** compiles the run →
[[orchestrator-pattern]] distributes the work → [[fable-mindset]] governs the
executor.
