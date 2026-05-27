---
name: release
description: Cut a new release — bump version, tag, push, monitor CI, and report results.
---

Cut a new release — bump version, tag, push, monitor CI, and report results.

## Step 1: Pre-flight checks

Verify the release environment is ready:

```bash
# Must be on main with a clean tree
git branch --show-current
git status --porcelain
```

**Abort if:**
- Not on `main` — switch first or confirm with the user
- Working tree is dirty — commit or stash first

Confirm the release script exists:

```bash
ls scripts/release.sh
```

Show the current version:

```bash
grep '^version' sipag/Cargo.toml | head -1
```

## Step 2: Determine bump type

Check `$ARGUMENTS` for the bump type.

- If `$ARGUMENTS` contains `patch`, `minor`, `major`, or an explicit semver like `1.2.3`, use that.
- If `$ARGUMENTS` is empty or unclear, ask the user:
  - **patch** — bug fixes, docs, small tweaks
  - **minor** — new features, backward-compatible changes
  - **major** — breaking changes

## Step 3: Run the release script

Execute the release script, piping `n` to skip its built-in workflow monitoring (we do our own richer monitoring in Step 4):

```bash
echo "n" | scripts/release.sh <bump>
```

If the script fails, show the error and stop.

After success, extract the new version and tag from the output.

## Step 4: Monitor the release workflow

Poll the GitHub Actions release workflow until it completes (10-minute timeout):

```bash
# Check every 15 seconds
gh run list --workflow=release.yml --limit=1 --json status,conclusion,databaseId,url --jq '.[0]'
```

While polling, show the user:
- Current status (queued, in_progress, completed)
- Elapsed time
- Individual job statuses when available:
  ```bash
  gh run view <run-id> --json jobs --jq '.jobs[] | "\(.name): \(.status) \(.conclusion // "")"'
  ```

**If the workflow fails**, show the failure URL and stop.

## Step 5: Report results

On success, print a summary:

```
Release v<version> shipped successfully.

- GitHub Release: https://github.com/<owner>/<repo>/releases/tag/v<version>
- Workflow run:   <workflow-url>

To upgrade locally:
  brew update && brew upgrade sipag
```
