Push changes, create a PR, review-fix until clean, and merge. End-to-end ship.

## Instructions

You are orchestrating the full ship workflow: push → PR → review-fix loop → merge. The argument $ARGUMENTS is optional context (e.g., a PR title hint or branch name).

### Step 1: Ensure we're on a feature branch

Check the current branch with `git branch --show-current`.

- If on `main`, stop and tell the user: "You're on main. Create a feature branch first (`git checkout -b feat/...`) and commit your changes."
- If on a feature branch, continue.

### Step 2: Push changes and create the PR

1. Check for uncommitted changes with `git status`. If there are staged or unstaged changes, stop and tell the user: "You have uncommitted changes. Commit them first, then re-run /ship-it."

2. Push the branch to origin:
   ```
   git push -u origin $(git branch --show-current)
   ```

3. Check if a PR already exists for this branch:
   ```
   gh pr list --head $(git branch --show-current) --json number,url -q '.[0]'
   ```

4. If no PR exists, create one:
   - Gather the commit log for the PR body: `git log main..HEAD --oneline`
   - Create the PR:
     ```
     gh pr create --title "<descriptive title>" --body "$(cat <<'EOF'
     ## Summary
     <1-3 bullet points summarizing the changes based on commit history>

     ## Test plan
     - [ ] `npm test` passes
     - [ ] Manual verification of changed functionality

     🤖 Generated with [Claude Code](https://claude.com/claude-code)
     EOF
     )"
     ```
   - If `$ARGUMENTS` is provided and looks like a title (not a number), use it as the PR title.
   - Otherwise, derive the title from the branch name and commits.

5. Store the PR number for subsequent steps.

### Step 3: Run the review-fix loop

This is identical to the `/review-pr` workflow. Execute the full loop:

#### Step 3a: Gather the diff

Fetch the diff: `gh pr diff <PR_NUMBER>`
Fetch the PR description: `gh pr view <PR_NUMBER>`

#### Step 3b: Identify changed files

List all files changed in the diff. Read the full content of each changed file (not just the diff hunks) so reviewers have complete context.

#### Step 3c: Launch parallel review agents

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

#### Step 3d: Compile and post the review

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

#### Step 3e: Fix all issues

If the verdict is APPROVE (all LGTM), skip to Step 4.

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

#### Step 3f: Re-review (loop)

Go back to Step 3a: gather the fresh diff, identify changed files, launch all 5 review agents again in parallel, compile the new review, and post it as a new comment on the PR.

**Keep looping Steps 3a–3f until the verdict is APPROVE** (all agents return LGTM or only have findings that are intentional/acknowledged).

To prevent infinite loops: if the same issue appears in 3 consecutive review rounds, stop the loop, post a comment explaining the unresolved issue, and ask the user for guidance.

### Step 4: Merge the PR

Once the review loop completes with APPROVE:

1. Post a final comment:
   ```
   gh pr comment <PR_NUMBER> --body "✅ All review agents report LGTM. Merging."
   ```

2. Merge the PR using squash merge to keep history clean:
   ```
   gh pr merge <PR_NUMBER> --squash --delete-branch
   ```

3. Switch back to main and pull:
   ```
   git checkout main && git pull
   ```

4. Tell the user the PR has been merged and the branch cleaned up. Include the PR URL in the final message.
