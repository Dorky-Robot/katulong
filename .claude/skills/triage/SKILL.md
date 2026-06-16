---
name: triage
description: Deep triage — trace open issues to root causes, find eliminations, and propose structural PRs.
---

Deep triage: trace open issues to root causes, find eliminations, and propose structural PRs.

## Step 1: Identify the repository

Resolve `owner/repo` from the git remote of the current working directory:

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Store this as `REPO` for subsequent commands.

## Step 2: Fetch issues and project docs

Fetch all open issues for context:

```bash
gh issue list --repo <REPO> --state open --json number,title,labels,assignees,createdAt,updatedAt --limit 200
```

Count the total and note how many carry the `ready` label.

Also read project docs (CLAUDE.md, README.md) from the local working directory to ground the synthesis phase.

## Step 3: Launch 3 agents in parallel

Send a **single message** with 3 Task tool calls so they run concurrently:

1. **root-cause-analyst** (`root-cause-analyst` agent) — Pass it:
   ```
   Analyze all open issues for <REPO>. Follow your full procedure: fetch project docs, fetch all open issues with bodies, trace issues to code, identify root causes using engineering principles, rank them, and prescribe structural cures. Focus on finding the disease, not the symptoms.
   ```

2. **simplicity-advocate** (`simplicity-advocate` agent) — Pass it:
   ```
   Analyze all open issues for <REPO>. Follow your full procedure: fetch project docs, fetch open and recently closed issues, read the implicated code, apply elimination tests and smallest-fix tests, check for wrong-question issues, identify essential complexity, and recommend simplifications.
   ```

3. **issue-analyst** (`issue-analyst` agent) — Pass it:
   ```
   Analyze all open issues for <REPO>. Follow your full procedure: fetch issues, cluster by theme, evaluate from 3 perspectives, and recommend the highest-impact next PR. Focus on issues labeled `ready`.
   ```

Wait for all three agents to complete before proceeding.

## Step 4: Synthesize across perspectives

Combine the three agent outputs into a unified analysis. This is the most important step — the agents provide raw perspectives, you provide the judgment.

### 4a: Build the root-cause map

Start with root-cause-analyst's findings. For each root cause, note:
- Which issues it explains
- What code it implicates
- What cure it proposes

### 4b: Resolve disagreements

When the agents disagree, apply these heuristics:

- **Root-cause-analyst proposes adding an abstraction AND simplicity-advocate proposes eliminating** →
  - If the abstraction would have only one consumer: simplicity-advocate wins
  - If elimination would create duplication: root-cause-analyst wins
  - Tie-break: fewer net lines wins

- **Issue-analyst's clusters cut across root causes** →
  - Prefer root-cause grouping (structurally coherent PRs over thematically grouped PRs)
  - Exception: if a root-cause PR would touch 10+ files, split along issue-analyst cluster lines

- **Simplicity-advocate says "do nothing" AND others propose changes** →
  - If the issue is a feature request with low demand: simplicity-advocate wins
  - If the issue reports actual breakage: proceed with the change

Note every disagreement and how you resolved it. Transparency builds trust.

### 4c: Scope to PR-sized chunks

Apply these scoping rules to each proposed change:

- Each PR addresses **one root cause or one simplification** — not a mix
- Max **5 issues per PR**, prefer 2-3
- Every file modified serves the **same structural goal**
- If a cure touches **10+ files**, split into sequential PRs with clear ordering
- PRs that **delete code rank higher** than PRs that add code

### 4d: Write PR specifications

Each PR body is the **complete briefing** for an isolated Docker worker that has no access to this conversation. The worker reads the PR description verbatim via `gh pr view` — it is everything they know. Write accordingly: a senior engineer reading only the PR body should understand the disease, the cure, and why this cure over alternatives.

For each proposed PR, write a full specification following this structure:

```
### PR: <title — imperative, under 70 chars>
**Priority**: <rank among proposed PRs>
**Dependencies**: <which PRs must land first, if any>
```

Then write the PR body that will be used in `gh pr create --body`:

```markdown
## The disease

<What structural flaw exists in the codebase and WHY it exists. Not "X is broken" but "X was designed for Y context, but the codebase has since evolved to Z context, creating a mismatch that manifests as..." Explain the history — when was this code written, what tradeoff was it making, why was that tradeoff reasonable at the time, and what changed.>

## Symptoms (open issues)

<For each issue this PR addresses, quote the relevant parts of the issue body and explain how each symptom traces back to the disease above. The worker should see the causal chain from structural flaw → each bug.>

- **Closes #X — <title>**: <How this issue is a symptom of the disease. Quote specific details from the issue body.>
- **Closes #Y — <title>**: <Same.>
- **Partially addresses #Z — <title>**: <What gets fixed and what remains.>

## Code evidence

<For EVERY file the worker will need to modify, include:>

- `<file:line>` — <What this code does now, what's wrong with it structurally, and what it should become. Include enough surrounding context (function signatures, data flow) that the worker can navigate directly to the right place without exploring.>

<Also include files the worker should READ but not modify, to understand the broader context:>

- `<file:line>` (read-only context) — <Why the worker needs to understand this code to make the right changes.>

## The cure

<The structural change at the design level. Not "edit file X" but "introduce concept Y that replaces the current pattern of Z". Explain the design PRINCIPLE being applied — e.g., "This follows the principle of making illegal states unrepresentable" or "This eliminates accidental coupling by giving each module a single reason to change.">

### Implementation steps

<Numbered, specific steps. Each step should name the file, the function, and what changes. Include code sketches for non-obvious transformations — the worker should not have to guess what the target state looks like.>

1. <Step — specific enough that the worker knows exactly what to do>
2. <Step>
3. <Step>

### What the code looks like after

<Describe the target architecture in 2-3 sentences. What concepts exist, how do they relate, what's the data flow? This is the "after" picture that helps the worker evaluate their own changes.>

## Design context the worker should know

<The "Rich Hickey" section. Broader architectural observations that are not obvious from the diff but matter for making good decisions:>

- <Why the current abstraction boundaries exist and which ones this PR respects vs. changes>
- <What essential complexity exists nearby that should NOT be simplified (from simplicity-advocate)>
- <How this change interacts with the rest of the system — second-order effects>
- <What the agents disagreed about and how it was resolved, if relevant to this PR>
- <Any Chesterton's Fence observations — things that look wrong but are load-bearing>

## What NOT to do

<Explicit guardrails. These prevent the worker from over-engineering or going off-scope:>

- Do not <specific anti-pattern the worker might be tempted by>
- Do not <scope creep risk>
- <Any "this looks related but is actually a separate concern" warnings>

## Tests

<What tests to add, modify, or remove. Be specific about test scenarios:>

- <Test scenario 1 — what behavior to verify>
- <Test scenario 2>
- <Any existing tests that will break and need updating>

## Net lines: <estimate — negative preferred>
```

## Step 5: Present the triage report

Output the full synthesized report:

```
## Deep Triage Report for <REPO>

### Root causes identified
<From root-cause-analyst, validated against code evidence>

### Simplifications found
<From simplicity-advocate, including essential complexity acknowledgments>

### Issue clusters
<From issue-analyst, noting where clusters align with or diverge from root causes>

### Disagreements and resolutions
<Where agents disagreed and how you resolved it>

### Proposed PRs (ranked)
<PR specifications from Step 4d, ordered by priority>

### Summary
- Total open issues: N
- Issues addressed by proposed PRs: N
- Proposed PRs: N (N delete code, N restructure, N add code)
- Issues not addressed: N (explain why — isolated bugs, low priority, or need more info)
```

## Step 6: Ask before creating

Present the ranked PR list and ask the user which PRs to create. Offer options:

1. **Create all** — Create branches and draft PRs for all proposed changes
2. **Pick specific PRs** — Let the user select which ones to create
3. **Just the report** — Save the analysis without creating any PRs
4. **Dispatch immediately** — Create PRs and launch `sipag dispatch` for each

Do not create any PRs without explicit user approval.

## Step 7: Create PRs (if approved)

**Critical**: The PR body is the worker's ONLY context. The worker runs in an isolated Docker container with no access to this conversation, the triage report, or the agent analyses. Everything the worker needs to make good decisions — the disease, the code evidence, the design rationale, the guardrails — must be in the PR body. Write as if briefing a senior engineer who is joining the project today.

For each approved PR:

1. Create a branch from main with an empty commit (GitHub requires at least one commit to create a PR):
   ```bash
   git checkout -b sipag/triage-<short-name> main
   git commit --allow-empty -m "chore: <short description of structural fix>"
   git push -u origin sipag/triage-<short-name>
   git checkout main
   ```

2. Create a draft PR using the full specification from Step 4d as the body. Use a heredoc to preserve formatting:
   ```bash
   gh pr create --repo <REPO> --base main --head sipag/triage-<short-name> \
     --title "<PR title>" --body "$(cat <<'BODY'
   <Full PR body from Step 4d — disease, symptoms, code evidence, cure, design context, guardrails, tests>
   BODY
   )" --draft
   ```

3. If the user chose "Dispatch immediately", run:
   ```bash
   sipag dispatch <PR_URL>
   ```

Report the created PR URLs back to the user.
