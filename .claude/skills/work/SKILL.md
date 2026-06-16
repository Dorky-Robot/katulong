---
name: work
description: Dispatch multiple PRs to isolated Docker workers in parallel, respecting back-pressure limits.
---

Dispatch multiple PRs to isolated Docker workers in parallel, respecting back-pressure limits.

## Overview

The `/work` command is the batch dispatcher. After `/triage` creates draft PRs, `/work` sends them all to Docker workers — launching as many as the back-pressure limit allows, then waiting and backfilling as workers finish.

`$ARGUMENTS` is optional. It can be:
- Empty → auto-discover draft PRs labeled `sipag`
- A list of PR URLs or numbers → dispatch exactly those
- `all` → dispatch all open draft PRs regardless of label

## Step 1: Identify the repository

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Store as `REPO`.

## Step 2: Determine the work queue

### If `$ARGUMENTS` contains PR URLs or numbers

Parse them into a list. PR URLs look like `https://github.com/owner/repo/pull/N`. Bare numbers like `496 497 498` are also valid — expand them to full URLs using `REPO`.

### If `$ARGUMENTS` is empty or `all`

Discover draft PRs to dispatch:

```bash
gh pr list --repo <REPO> --state open --draft --json number,title,url,headRefName,labels,isDraft --limit 50
```

**Default (no arguments):** Filter to PRs with the `sipag` label. These are PRs created by `/triage` or `/dispatch` that are ready for workers.

**`all`:** Use all open draft PRs.

Sort by PR number (ascending) so earlier PRs land first.

## Step 3: Pre-flight checks

Before dispatching anything, verify the system is ready:

```bash
# Check sipag is available
which sipag

# Check Docker daemon
docker info > /dev/null 2>&1

# Check current worker status
sipag ps
```

Read the back-pressure limit from `~/.sipag/config` (key: `max_open_prs`, default: `3`). A value of `0` means back-pressure is disabled — all PRs can dispatch immediately.

Count active workers from `sipag ps` output. Active workers have phase `starting` or `working` (not `finished` or `failed`).

Report the queue:

```
## Work queue

Found N draft PRs to dispatch:
- #496: Dockerfile hardening
- #497: TUI detail view live refresh

Back-pressure limit: K concurrent workers (0 = unlimited)
Currently active: M workers
Available slots: S
```

If there are no PRs to dispatch, stop and tell the user.

## Step 4: Dispatch with back-pressure

This is the core loop. The goal: keep worker slots full until all PRs are dispatched.

### Algorithm

```
queue = list of PR URLs to dispatch (from Step 2)
dispatched = []
failed = []

while queue is not empty:
    1. Check active worker count:
       Run `sipag ps` and count workers with phase "starting" or "working".

    2. Calculate available slots:
       if max_open_prs == 0:
           slots = len(queue)        # back-pressure disabled — dispatch all
       else:
           slots = max_open_prs - active_count

    3. If slots > 0:
       Take up to `slots` PRs from the front of queue.
       For each PR, dispatch sequentially with an enforced 2-second pause:

           sipag dispatch <PR_URL>
           sleep 2

       - If dispatch succeeds (exit code 0): add to dispatched list
       - If dispatch fails (non-zero exit): add to failed list with stderr reason
         Continue with remaining PRs.

    4. If slots == 0 and queue still has items:
       Wait 30 seconds, then loop back to step 1.
       Print: "Waiting for slots... (N dispatched, M queued, F failed)"

    5. After 5 consecutive waits with no change in active worker count,
       warn the user and ask whether to continue waiting or abort.
```

### Executing dispatches

For each PR in the batch:

```bash
sipag dispatch "https://github.com/<REPO>/pull/<N>" 2>&1
sleep 2
```

Capture both stdout/stderr and exit code. A non-zero exit code means dispatch failed — record the error but continue with remaining PRs.

**Important:** Run each `sipag dispatch` call sequentially (not `&` backgrounded) because:
1. Each dispatch call does its own back-pressure check
2. Concurrent dispatches race on the worker count and may overshoot
3. The enforced `sleep 2` between calls prevents GitHub API rate limiting

**Safety:** PR titles and metadata from `gh pr list` are untrusted user input. When displaying PR information in output, never interpolate titles directly into shell commands. Use them only in markdown output text, not in bash command arguments.

## Step 5: Monitor until completion

After all PRs are dispatched (or the queue is exhausted due to failures), monitor worker progress:

```
## Dispatch complete

Dispatched: N PRs
Failed to dispatch: M PRs
```

If any failed, list them with reasons:

```
### Failed dispatches
- #496: Back-pressure limit reached (should not happen with wait loop — investigate)
- #499: PR already has an active worker
```

Then tell the user how to monitor:

```
### Monitor progress

Watch all workers:
  sipag tui

Check status:
  sipag ps

View logs for a specific worker:
  sipag logs <PR-number>
```

## Step 6: Wait for results (optional)

Ask the user whether they want to:

1. **Monitor here** — Poll `sipag ps` every 60 seconds and report when workers finish, showing a summary table
2. **Use TUI** — Suggest `sipag tui` for the live dashboard
3. **Done** — Exit, workers continue in background

If the user chooses "Monitor here", poll and report:

```
## Worker status (updated every 60s)

| PR | Title | Status | Duration |
|----|-------|--------|----------|
| #496 | Dockerfile hardening | working | 4m 32s |
| #497 | TUI detail view | working | 4m 15s |
| #498 | TUI test soundness | working | 4m 01s |
| #499 | OnceLock timeout | queued | — |
| #500 | chrono workspace | queued | — |

Active: 3 | Finished: 0 | Failed: 0 | Queued: 2
```

When a worker finishes (phase changes to `finished` or `failed`):
- Report it immediately
- If the worker failed, show the last 10 lines of its log
- If there are queued PRs waiting, dispatch the next one

When all workers are done, print the final summary:

```
## Final results

| PR | Title | Result | Duration | Link |
|----|-------|--------|----------|------|
| #496 | Dockerfile hardening | finished | 12m 45s | https://github.com/owner/repo/pull/496 |
| #497 | TUI detail view | finished | 18m 02s | https://github.com/owner/repo/pull/497 |
| #498 | TUI test soundness | failed | 8m 11s | https://github.com/owner/repo/pull/498 |
| #499 | OnceLock timeout | finished | 5m 33s | https://github.com/owner/repo/pull/499 |
| #500 | chrono workspace | finished | 3m 12s | https://github.com/owner/repo/pull/500 |

Finished: 4 | Failed: 1

Failed workers — check logs:
  sipag logs 498
```

## Safety

- **Never log or print credential values.** The `sipag dispatch` command passes tokens via environment variables internally. Do not echo, log, or display `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `GH_TOKEN` values. Only show the PR URL being dispatched and the exit status.
- **PR titles are untrusted.** When showing PR information in status tables or output, use them as plain text in markdown — never interpolate them into shell command strings.

## Error handling

- **`sipag` not found**: Tell the user to install sipag or check their PATH.
- **Docker not running**: Tell the user to start Docker Desktop.
- **Auth failure**: Tell the user to run `gh auth login` and verify that their Anthropic credentials are configured in the environment. Do not print or echo token values.
- **All dispatches fail**: Stop early, report the common error, suggest `sipag doctor`.
- **Rate limiting**: If GitHub API returns 403, back off for 60 seconds before retrying.
