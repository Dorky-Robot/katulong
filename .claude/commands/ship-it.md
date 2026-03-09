Commit, push, create a PR, run review agents, fix issues, and merge for katulong.

## Step 1: Prepare the branch

Check the current git state:

```bash
git status
git branch --show-current
```

**If on main/master:**
1. Create a feature branch from the changes:
   ```bash
   git checkout -b <descriptive-branch-name>
   ```
2. Stage and commit all changes with a clear commit message.

**If on a feature branch:**
1. Stage and commit any uncommitted changes.
2. If there are no uncommitted changes, continue to Step 2.

## Step 2: Push and create (or update) the PR

```bash
git push -u origin <branch-name>
```

Check if a PR already exists for this branch:

```bash
gh pr view <branch-name> --json number,url 2>/dev/null
```

**If no PR exists**, create one:

```bash
gh pr create --title "<concise title>" --body "$(cat <<'EOF'
## Summary

<1-3 bullet points describing the changes>

## Test plan

- [ ] `npm test` passes (unit + integration)
- [ ] Manual verification of changed functionality
EOF
)"
```

**If a PR already exists**, note its number and continue.

## Step 3: Review-fix loop

Repeat until all agents approve:

### 3a. Gather the diff

```bash
gh pr diff <PR-number>
```

Also fetch the PR description for context:

```bash
gh pr view <PR-number> --json title,body
```

### 3b. Identify changed files

List all files changed in the diff. Read the full content of each changed file (not just the diff hunks) so reviewers have complete context.

### 3c. Launch review agents in parallel

Send a **single message** with Task tool calls so they run concurrently. Each agent receives the PR description, full diff, and full contents of changed files.

Launch these review agents:

1. **Security reviewer** (`security-reviewer` agent) — Scan for auth bypass, injection risks, credential leaks, session hijacking, path traversal, XSS, header trust, WebSocket origin validation. This app provides direct terminal access — any auth bypass is a full shell vulnerability.

2. **Architecture reviewer** (`architecture-reviewer` agent) — Check layer boundaries (server.js vs lib/ vs public/), module responsibilities, API contracts, ripple effects on callers.

3. **Correctness reviewer** (`correctness-reviewer` agent) — Check for logic errors, async bugs (missing await), race conditions, resource leaks, TOCTOU bugs, broken callers.

4. **Code quality reviewer** (`code-quality-reviewer` agent) — Evaluate naming, complexity, duplication, dead code, error messages, consistency with adjacent code, API design.

5. **Vision alignment reviewer** (`vision-reviewer` agent) — Check alignment with katulong's vision: simplicity, self-contained, security by default, zero-config, Unix philosophy. Flag feature creep, unnecessary dependencies, scope deviation.

Each agent must end with a verdict:

```
VERDICT: APPROVE
VERDICT: APPROVE_WITH_NOTES
VERDICT: REQUEST_CHANGES
```

### 3d. Compile and post the review

Combine all agent responses into a review summary:

```
## Review Summary for PR #<N>

### Security
<verdict> — <key findings or "No issues">

### Architecture
<verdict> — <key findings or "No issues">

### Correctness
<verdict> — <key findings or "No issues">

### Code Quality
<verdict> — <key findings or "No issues">

### Vision Alignment
<verdict> — <key findings or "No issues">

### Overall
<APPROVE / APPROVE_WITH_NOTES / REQUEST_CHANGES>
<1-2 sentence summary>
```

Post as a PR comment:

```bash
gh pr comment <PR-number> --body "$(cat <<'REVIEW_EOF'
<the review summary>
REVIEW_EOF
)"
```

### 3e. Fix any issues

If any agent returned `REQUEST_CHANGES`:
1. Fix the issues they identified.
2. Run `npm test` to ensure nothing is broken.
3. Commit and push the fixes.
4. Return to step 3a.

To prevent infinite loops: if the same issue appears in 3 consecutive review rounds, stop, post a comment explaining the unresolved issue, and ask the user for guidance.

If all agents returned `APPROVE` or `APPROVE_WITH_NOTES`, continue to Step 4.

## Step 4: Merge

```bash
gh pr merge <PR-number> --squash --delete-branch
```

Switch back to main and clean up:

```bash
BRANCH=$(git branch --show-current)
git checkout main && git pull && git branch -d "$BRANCH"
```

Print the merged PR URL.
