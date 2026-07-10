---
name: visual-ui-verify
description: See and verify UI with real screenshots, not just code. Use the shot tool to capture the running Brain Platform desktop app (the primary target) or any web UI, then Read the PNG to inspect layout, spacing, states, and regressions before approving or shipping.
---

# Visual UI Verify

Reading code does not tell you whether a UI is correct. Spacing collapses, a flex child
overflows, an empty state never renders, a dark-on-dark contrast bug hides in plain sight —
none of it shows up in a diff. This skill lets you **actually see the rendered UI** and judge
it with your eyes, then attach the evidence.

You already have the tools: a shell (to run `shot`) and image-capable file reading
(Read / ReadMediaFile). This is the workflow.

## The tool: `shot`

`shot` is a shared screenshot CLI for all SQNCR agents (`~/bin/shot`, works from any directory).
It prints absolute PNG path(s), one per line. You then **Read that PNG** to see the UI.

Shots are written to `$TMPDIR/agent-shots/`, pruned after 1 hour, and hard-swept daily by a
launchd job (`ai.sqncr.shot-cleanup`). They are **session-scratch, never permanent** — capture
freely, they are not committed and do not accumulate. Do not copy shots into the repo or the brain.

## Primary target: the Brain Platform desktop app (Electron)

This is what the team builds and what you verify most. The app must be **running** (dev server,
or the packaged `/Applications/Brain Platform.app`).

```bash
shot              # capture the Brain Platform app (main window + widget)
shot --dashboard  # just the main dashboard window
shot --widget     # just the floating widget
```

Two backends, auto-selected — you do not choose:
1. **Embedded capture** (`webContents.capturePage`): permission-free, works even if the window is
   hidden or occluded, and can target dashboard vs. widget precisely. Active when the app runs in
   dev, or packaged with `BRAIN_SHOT=1`.
2. **OS window capture** (fallback): used when the embedded server is not reachable (e.g. the plain
   packaged build). Captures the app's on-screen windows. **macOS Screen-Recording permission for
   the Terminal host is granted**, so this works — the window just has to be visible (not minimized).

If `shot` reports no Brain Platform windows, the app is not running or is minimized — start it /
un-minimize it, then re-shoot.

### Capture the RIGHT worktree (critical — you verify a branch, not "the app")

There can be several brain-platform git worktrees (one per branch). The in-app capture server uses
a single global port, so only **one** running instance is unambiguously capturable. Before you
trust a screenshot, make sure the live app is the worktree you mean to verify.

- **`shot` tells you what it captured.** On every Brain Platform shot it prints a stderr line, e.g.
  `# Brain Platform: dev build — worktree /Users/.../brain-platform [feat/SQN-559-companion-core]`.
  If it warns that **multiple instances** are running, the target is ambiguous — fix it before trusting pixels.
- **`brain-open` launches the worktree you choose**, as the single live instance:
  ```bash
  brain-open                      # the worktree containing your $PWD, else the main checkout
  brain-open feat/SQN-559-companion-core   # by branch
  brain-open /path/to/worktree    # by path
  brain-open --list               # list worktrees + which one (if any) is currently live
  ```
  It stops other dev instances, starts the chosen worktree (the first dev start rebuilds native
  modules, ~1-2 min), waits for the capture server, then tells you to `shot`. Use it whenever the
  live app is the wrong branch, nothing is running, or `shot` reported ambiguity.

**The rule:** verify your branch's build. Run `brain-open <your-branch>` (or confirm `shot`'s
worktree line already matches it), *then* capture.

## Any other desktop app

```bash
shot --list             # list capturable windows + permission status
shot --app "Some App"   # capture every on-screen window of that app
shot --window <id>      # one window by id (from --list)
shot --screen           # whole screen
```

These use OS capture (permission is granted). The window must be visible.

## Web UIs (secondary — for the React frontend / any URL)

```bash
shot --url http://localhost:3000               # headless, no window needed
shot --url http://localhost:3000 --size 390x844   # mobile breakpoint
```

Headless browser, permission-free, no visible window. Use it when the thing under test is a web
page rather than the desktop app. For the desktop app, prefer the `shot` / `--dashboard` /
`--widget` paths above.

## The workflow

1. **Get the UI on screen.** Launch the Brain Platform app (or the dev server / web page).
2. **Capture.** `shot` (or `--dashboard` / `--widget`, or `--app "<name>"`, or `--url <url>`).
3. **See it.** Read the printed PNG path as an image. Actually look at it.
4. **Judge against intent.** Compare to the spec / acceptance criteria / design. Check:
   - Layout: alignment, spacing, overflow, truncation, clipped or off-screen elements.
   - States: loading, empty, error, success — drive the app into each and capture it, not just the happy path.
   - Detail: typography, contrast, hover/focus affordances.
   - Regression: did this change break a neighboring view? Shoot that view too.
5. **Decide & show.** Attach the PNG path(s) in your deliverable / review comment and state what
   you saw. "Looks fine from the code" is not verification. A screenshot you looked at is.

## When to use this (do not skip)

- **Implementer:** before you mark any UI task `done`. Your quality signature is visual and
  detail-obsessed — back it with a shot of the running app. Include the screenshot path in your
  chat delivery and the issue comment. Capture every state you claim to handle.
- **CTO:** at any quality gate that touches UI. Do not pass UI work on code review alone — pull up
  the running app with `shot` and look. If it does not match the spec, fail the gate with the shot
  attached as evidence.
- Before/after any visual change, to prove the change and catch collateral regressions.

## Notes

- The app must be running and (for OS capture) its window visible. Embedded capture also handles
  hidden windows but needs the app launched with the capture server (dev or `BRAIN_SHOT=1`).
- `shot --url` only renders what the URL serves — make sure the server is up and the route exists,
  or you capture an error page (still useful: capture it and report it).
- Never put a shot path forward as "done" without having Read it yourself first.
