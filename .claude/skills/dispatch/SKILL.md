---
name: dispatch
description: Create a well-scoped PR and dispatch it to an isolated Docker worker for implementation.
---

Create a well-scoped PR and dispatch it to an isolated Docker worker for implementation.

## Step 1: Analyze open issues

Launch the issue-analyst agent to cluster open issues and recommend the highest-impact PR:

```
Use the issue-analyst agent to analyze open issues for this repository.
```

Review the recommendation. Adjust scope if needed — prefer smaller, cohesive PRs over large multi-concern ones.

## Step 2: Create a branch and PR

Based on the analysis, create a branch and draft PR with full architectural context:

```bash
# Create a descriptive branch
git checkout -b sipag/<short-description>
git push -u origin sipag/<short-description>

# Create a draft PR with the implementation plan
gh pr create --draft --title "<concise title>" --body "## Assignment

<Describe what the worker should implement. Be specific about:>
- Which files to modify and why
- The approach to take
- What tests to add or update
- Any constraints or gotchas

## Issues addressed

Closes #N — <why this issue is addressed by this PR>
Closes #M — <why>

## Out of scope

<What NOT to do — helps the worker stay focused>
"
```

The PR description is the worker's complete assignment. Make it thorough — the worker will read it verbatim.

## Step 3: Dispatch the worker

```bash
sipag dispatch https://github.com/owner/repo/pull/N
```

## Step 4: Monitor progress

Check worker status:

```bash
sipag ps
```

Or launch the interactive dashboard:

```bash
sipag tui
```

View worker logs:

```bash
sipag logs <PR-number>
```
