Run a multi-perspective review on a katulong pull request.

## Step 1: Fetch the PR diff

```bash
gh pr diff <PR-number> --repo dorky-robot/katulong
```

Also fetch the PR description for context:

```bash
gh pr view <PR-number> --repo dorky-robot/katulong --json title,body
```

If `$ARGUMENTS` contains a PR number, use it. If it contains a branch name, find the PR for that branch. If empty, diff the current branch against main.

## Step 2: Identify changed files

List all files changed in the diff. Read the full content of each changed file (not just the diff hunks) so reviewers have complete context.

## Step 3: Launch 5 review agents in parallel

Send a **single message** with 5 Task tool calls so they run concurrently. Each agent receives:

1. The full diff
2. The list of changed files
3. The full content of each changed file

The 5 agents:

1. **Security reviewer** (`security-reviewer` agent) — Scan the diff for: auth bypass (isAuthenticated, isLocalRequest, isPublicPath), session hijacking (cookie flags, token handling), command injection via PTY, path traversal in static serving, XSS, header trust violations, WebSocket origin validation, credential exposure. **CRITICAL**: this app provides direct shell access — any auth bypass is a full terminal vulnerability.

2. **Architecture reviewer** (`architecture-reviewer` agent) — Evaluate: server.js vs lib/ layer boundaries, module responsibility leaks, frontend independence (no server-side templating beyond data-* attributes), API contract changes, ripple effects on callers.

3. **Correctness reviewer** (`correctness-reviewer` agent) — Check: logic errors, async bugs (missing await, unhandled rejections), race conditions (TOCTOU, missing withStateLock), resource leaks (WebSocket, PTY, file descriptors), edge cases (empty input, disconnection mid-operation).

4. **Code quality reviewer** (`code-quality-reviewer` agent) — Evaluate: naming clarity, complexity, duplication, dead code, error message quality, consistency with adjacent code patterns, API design.

5. **Vision alignment reviewer** (`vision-reviewer` agent) — Check alignment with katulong's principles: simplicity, self-contained (no CDN/external deps), security by default, zero-config, Unix philosophy. Flag feature creep, unnecessary dependencies, scope deviation.

Each agent must end its response with exactly one verdict line:

```
VERDICT: APPROVE
VERDICT: APPROVE_WITH_NOTES
VERDICT: REQUEST_CHANGES
```

## Step 4: Synthesize verdicts

Combine all 5 agent responses into a single review summary:

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

### Issues by Severity
#### High
- [list all high severity issues across all reviewers, if any]

#### Medium
- [list all medium severity issues across all reviewers, if any]

#### Low
- [list all low severity issues across all reviewers, if any]
```

## Step 5: Post as PR comment

```bash
gh pr comment <PR-number> --repo dorky-robot/katulong --body "$(cat <<'REVIEW_EOF'
<the review summary>
REVIEW_EOF
)"
```

## Step 6: Fix-review loop

If any agent returned `REQUEST_CHANGES`:
1. Fix every issue found — high, medium, and low.
2. Run `npm test` to ensure nothing is broken.
3. Commit and push fixes.
4. Return to Step 1 and re-review.

Keep looping until all agents return `APPROVE` or `APPROVE_WITH_NOTES`.

To prevent infinite loops: if the same issue appears in 3 consecutive rounds, stop, post a comment explaining the unresolved issue, and ask the user for guidance.

When the review loop completes with APPROVE, post a final comment:

```bash
gh pr comment <PR-number> --body "All review agents approve. Ready to merge."
```
