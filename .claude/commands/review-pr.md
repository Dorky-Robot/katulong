Review PR $ARGUMENTS from multiple expert perspectives, fix all issues found, and repeat until clean.

## Instructions

You are orchestrating a review-fix loop. You will review the PR, post findings, fix every issue, then re-review until all agents return LGTM.

### Step 1: Gather the diff

Determine the PR to review from the arguments:
- If given a PR number (e.g., `123`), fetch the diff with: `gh pr diff $ARGUMENTS`
- If given a branch name, diff it against main: `git diff main...$ARGUMENTS`
- If given nothing, diff the current branch against main: `git diff main...HEAD`

Also fetch the PR description if a PR number was given: `gh pr view $ARGUMENTS`

Determine the PR number for later use. If given a URL like `https://github.com/owner/repo/pull/123`, extract `123`. If reviewing the current branch, find it with `gh pr list --head $(git branch --show-current) --json number -q '.[0].number'`.

### Step 2: Identify changed files

List all files changed in the diff. Read the full content of each changed file (not just the diff hunks) so reviewers have complete context.

### Step 3: Launch parallel review agents

Launch ALL of the following review agents in parallel using the Task tool. Each agent should receive:
1. The full diff
2. The list of changed files
3. The full content of each changed file

**Agents to launch:**

1. **Architecture Review** (subagent_type: "general-purpose")
   - Prompt: Review these changes as an architecture reviewer. Check layer boundaries, module responsibilities, IPC protocol adherence, API contracts, and ripple effects. Use the architecture-reviewer agent guidelines from `.claude/agents/architecture-reviewer.md`. Here is the diff: [include diff]. Here are the full file contents: [include file contents]. Respond with LGTM if no issues, otherwise list issues as `[severity: high|medium|low] file:line — description`.

2. **Security Review** (subagent_type: "general-purpose")
   - Prompt: Review these changes as a security reviewer using STRIDE and OWASP. Check for auth bypass, injection, session hijacking, path traversal, XSS, header trust, WebSocket origin validation, and credential exposure. Use the security-reviewer agent guidelines from `.claude/agents/security-reviewer.md`. Here is the diff: [include diff]. Here are the full file contents: [include file contents]. Respond with LGTM if no issues, otherwise list issues as `[severity: high|medium|low] file:line — description`.

3. **Correctness Review** (subagent_type: "general-purpose")
   - Prompt: Review these changes for correctness. Check for logic errors, async bugs, race conditions, resource leaks, error handling gaps, edge cases, and broken callers. Use the correctness-reviewer agent guidelines from `.claude/agents/correctness-reviewer.md`. Here is the diff: [include diff]. Here are the full file contents: [include file contents]. Respond with LGTM if no issues, otherwise list issues as `[severity: high|medium|low] file:line — description`.

4. **Code Quality Review** (subagent_type: "general-purpose")
   - Prompt: Review these changes for code quality. Check naming, complexity, duplication, dead code, error messages, consistency with adjacent code, and API design. Use the code-quality-reviewer agent guidelines from `.claude/agents/code-quality-reviewer.md`. Here is the diff: [include diff]. Here are the full file contents: [include file contents]. Respond with LGTM if no issues, otherwise list issues as `[severity: high|medium|low] file:line — description`.

5. **Vision Alignment Review** (subagent_type: "general-purpose")
   - Prompt: Review these changes for alignment with katulong's vision: simplicity, self-contained, security by default, zero-config, Unix philosophy. Check for feature creep, unnecessary dependencies, UX regressions, scope deviation, and complexity growth. Use the vision-reviewer agent guidelines from `.claude/agents/vision-reviewer.md`. Here is the diff: [include diff]. Here are the full file contents: [include file contents]. Respond with LGTM if no issues, otherwise list issues as `[severity: high|medium|low] — description`.

### Step 4: Compile and post the review

Once all agents complete, compile a unified review report in this format and post it as a comment on the PR using `gh pr comment`:

```
## PR Review: [PR title or branch name]

### Summary
[1-2 sentence summary of what the PR does]

### Architecture
[Agent findings or LGTM]

### Security
[Agent findings or LGTM]

### Correctness
[Agent findings or LGTM]

### Code Quality
[Agent findings or LGTM]

### Vision Alignment
[Agent findings or LGTM]

### Verdict
[APPROVE / REQUEST CHANGES / DISCUSS]
[1-2 sentence overall assessment]

### Issues by Severity
#### High
- [list all high severity issues across all reviewers, if any]

#### Medium
- [list all medium severity issues across all reviewers, if any]

#### Low
- [list all low severity issues across all reviewers, if any]
```

Use a HEREDOC to pass the review body:
```
gh pr comment <PR_NUMBER> --body "$(cat <<'REVIEW_EOF'
<compiled review markdown>
REVIEW_EOF
)"
```

If all reviewers say LGTM, the verdict is APPROVE.
If any reviewer has HIGH severity issues, the verdict is REQUEST CHANGES.
Otherwise, the verdict is DISCUSS.

### Step 5: Fix all issues

If the verdict is APPROVE (all LGTM), skip to Step 7.

Otherwise, fix every issue found by the reviewers — high, medium, and low. For each issue:
1. Read the relevant file(s) to understand the context
2. Make the fix using Edit/Write tools
3. Keep fixes minimal and focused — don't refactor beyond what the issue requires

After fixing all issues, run the test suite (`npm test`) to make sure nothing is broken. If tests fail, fix them before proceeding.

Commit all fixes in a single commit with a message summarizing what was addressed:
```
fix: address review findings — [brief list of what was fixed]
```

Push the commit to the PR branch.

### Step 6: Re-review (loop)

Go back to Step 1: gather the fresh diff, identify changed files, launch all 5 review agents again in parallel, compile the new review, and post it as a new comment on the PR.

**Keep looping Steps 1–6 until the verdict is APPROVE** (all agents return LGTM or only have findings that are intentional/acknowledged).

To prevent infinite loops: if the same issue appears in 3 consecutive review rounds, stop the loop, post a comment explaining the unresolved issue, and ask the user for guidance.

### Step 7: Final comment

When the review loop completes with APPROVE, post a final comment:
```
gh pr comment <PR_NUMBER> --body "✅ All review agents report LGTM. Ready to merge."
```

Tell the user the PR is clean and ready for merge.
