# File link resolution across worktrees

## Status

**Steps 1-3 shipped.** `meta.pane.cwd` is stamped by the 5s pane monitor,
`meta.claude.cwd` is stamped by the same monitor from Claude's per-pid
session JSON, and the frontend resolver reads them from the cached
session object with precedence `meta.claude.cwd → meta.pane.cwd →
relative`. The `/sessions/cwd/:name` route, `getSessionCwd`, and
`getPaneCwd` are retired.

**Step 4 (lsof Claude pid cwd) is still deferred.** An earlier attempt
was reverted — follow-up work should read the revert reasoning before
redoing it. The current fix covers the `cd worktree && claude` flow;
the `claude --add-dir` and in-process `/cd` cases still fall back to
the (possibly stale) pane shell cwd.

## Problem

Clicking a relative file link in the terminal (e.g. `docs/claude-feed-watchlist.md`
printed by Claude Code) opens the document tile at the wrong absolute path when
the Claude session is operating on a git worktree that isn't the shell's `cwd`.

Observed failure: Claude is working inside
`.claude/worktrees/feed-completion-prominent/`, writes
`docs/claude-feed-watchlist.md` in that worktree, and prints the relative path.
Clicking it resolves to `/Users/felixflores/Projects/dorky_robot/katulong/docs/claude-feed-watchlist.md`
(the main checkout) and the file viewer 404s — the file only exists in the
worktree.

## Diagnosis

Resolution path: `public/app.js:166-186` (`onFileLinkClick`) calls
`GET /sessions/cwd/<name>`, which lands in
`lib/session-manager.js:390-394` → `lib/tmux.js:354-360`
(`getPaneCwd`), which runs `tmux display-message -p "#{pane_current_path}"`.

`#{pane_current_path}` tracks the pane's shell cwd (updated by OSC 7 from the
shell's prompt integration). While Claude is running in the foreground the
shell doesn't emit OSC 7, and Claude's Bash tool calls spawn subshells that
never touch the pane shell's cwd. So the pane CWD reflects wherever the shell
was when `claude` launched — not where Claude is actually working.

Two distinct cases fall out:

1. **Shell cwd matches project dir.** User (or `/tee`, `/orchestrate`,
   `/implement-mode`) `cd`'d into the worktree before launching `claude`.
   `pane_current_path` is correct. Current resolver works.
2. **Shell cwd differs from project dir.** User launched `claude` from the
   main checkout with `--add-dir <worktree>`, or equivalent. `pane_current_path`
   points to the main checkout. Current resolver fails.

## Proposed fix

### Step 1 — stamp pane cwd into session meta

`lib/session-child-counter.js:68-96` (`inspectTmuxPane`) already polls each
alive session every 5s via `list-panes -F "#{pane_pid} #{pane_current_command}"`.
Extend the format to include `#{pane_current_path}` and return it alongside
`currentCommand`. No new tmux call.

Add a sibling reconciler to `reconcileClaudePresence` (same file, lines
123-159) — call it `reconcilePaneCwd` — that writes the value into a new meta
namespace: **`meta.pane.cwd`**. Keep it out of `meta.claude` — this is shell
state, not Claude state; `meta.claude` has an ownership contract with the hook
ingest path (`lib/routes/app-routes.js:42-112`) and mixing shell cwd in breaks
that.

Only `setMeta` on change (match the existing pattern in
`reconcileClaudePresence`). `session.setMeta` already triggers `scheduleSave`
and `session-list` broadcast.

### Step 2 — resolve from cached meta

`public/app.js:166-186`: drop the live `api.get("/sessions/cwd/<name>")` call.
Read `meta.pane.cwd` off the already-cached session object (sessions already
carry `meta` via `publicMeta()` in `lib/session-meta-filter.js`). Saves a
round-trip per click and the cache is always fresh because the pane monitor
just broadcast.

### Step 3 — retire the dead route

Grep for other callers of `GET /sessions/cwd/:name` and `getSessionCwd`. If
there are none, delete `lib/session-manager.js:390-394` and the route at
`lib/routes/app-routes.js:724-727`. `getPaneCwd` in `lib/tmux.js` is also
retired: the pane monitor now reads `pane_current_path` via the existing
`list-panes` format string in `inspectTmuxPane`, so the separate helper has
no remaining callers.

### Step 4 (optional) — capture Claude's process cwd

For case 2 above (claude launched with `--add-dir`), the shell cwd isn't
enough. When the pane monitor detects Claude is running
(`isClaudeCommand(currentCommand)` is true), also fetch Claude's process cwd
and stamp it as `meta.claude.cwd`.

macOS has no `/proc`, so:

```
lsof -a -p <claude-pid> -d cwd -Fn
```

The Claude pid is a child of `panePid` (already pgrep'd in
`inspectTmuxPane`). Pick the child whose command matches `isClaudeCommand`.

Resolver precedence becomes: `meta.claude.cwd` → `meta.pane.cwd` → fall
through to the relative path unchanged.

Step 4 is a polish — land steps 1-3 first and validate the common path
(`/tee` / `/orchestrate` spawned sessions, where shell cwd is already the
worktree).

## Non-goals

- **No reactive OSC 7 parser.** 5s polling is fine for this UX; a file link
  click that follows a `cd` within 5s is rare and self-corrects on the next
  tick.
- **No worktree-aware search fallback.** "If the file 404s, search sibling
  worktrees" is tempting but ambiguous when the same path exists in several
  worktrees. Prefer explicit state over heuristics.
- **No client-side project root override UI.** If the meta-based resolution
  still misses, the user can always click the absolute path Claude prints in
  parallel — no need for a dedicated selector.

## Open questions

- Should `meta.pane.cwd` also be persisted across server restarts? Probably
  yes, unlike `meta.claude.*` which is runtime-derived. Check the strip logic
  in `lib/session-manager.js:68-78,780-797`.
- If we add `meta.claude.cwd` in step 4, it needs the same ownership-contract
  treatment as `meta.claude.running`: pane monitor owns it, hook ingest doesn't
  overwrite it.
