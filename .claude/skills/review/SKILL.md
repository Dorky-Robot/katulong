---
name: review
description: Run a multi-perspective review on a pull request — security, architecture, correctness.
---

Run a multi-perspective review on a pull request.

## Step 1: Fetch the PR diff

```bash
gh pr diff <PR-number> --repo <owner/repo>
```

Also fetch the PR description for context:

```bash
gh pr view <PR-number> --repo <owner/repo> --json title,body
```

## Step 2: Launch 4 review agents in parallel

Send a **single message** with 4 Task tool calls so they run concurrently. Each agent receives:

```
You are reviewing PR #<N> in <owner/repo>.

<pr-description>
<the PR title and body>
</pr-description>

<diff>
<the full diff output>
</diff>
```

The 4 agents:

1. **Security reviewer** (`security-reviewer` agent) — Scan the diff for: secrets or tokens, injection risks (SQL, command, path traversal), unsafe deserialization, hardcoded credentials, new dependencies with known CVEs, permission/auth changes. Only flag issues actually present in the diff.

2. **Architecture reviewer** (`architecture-reviewer` agent) — Evaluate the diff for: module boundary violations, increased coupling between components, broken abstraction layers, API surface changes without migration path, pattern breaks vs. established conventions.

3. **Correctness reviewer** (`correctness-reviewer` agent) — Check: logic errors, off-by-one bugs, unhandled error cases, race conditions, null/None handling, integer overflow, resource leaks, incorrect state transitions.

4. **Test adequacy reviewer** — Check: new code has corresponding tests, changed behavior has updated tests, edge cases are covered, test assertions are meaningful (not just "it doesn't crash"), integration paths are tested.

Each agent must end its response with exactly one verdict line:

```
VERDICT: APPROVE
VERDICT: APPROVE_WITH_NOTES
VERDICT: REQUEST_CHANGES
```

## Step 3: Synthesize verdicts

Combine all 4 agent responses into a single review summary:

```
## Review Summary for PR #<N>

### Security
<verdict> — <key findings or "No issues">

### Architecture
<verdict> — <key findings or "No issues">

### Correctness
<verdict> — <key findings or "No issues">

### Test Adequacy
<verdict> — <key findings or "No issues">

### Overall
<APPROVE / APPROVE_WITH_NOTES / REQUEST_CHANGES>
<1-2 sentence summary>
```

## Step 4: Post as PR comment

```bash
gh pr comment <PR-number> --repo <owner/repo> --body "<the review summary>"
```
