---
name: consult
description: Consult the masters — review the entire codebase through the lens of great software engineers. Mines git history first via diwa, then runs deep agent review.
---

Consult the masters — review the entire codebase through the lens of great software engineers. This is an expensive, comprehensive audit meant to be run occasionally, not on every change.

## Phase 0: Mine the History with diwa

Before reading any code, mine the project's git history for context. The review agents in Phase 2 give grounded advice only when they know which approaches have already been tried, which decisions were deliberate, and which patterns have been reverted. Without this, they cheerfully recommend dead ends the team already walked down once.

This phase invokes the `diwa` skill (see `~/.claude/skills/diwa/SKILL.md`) and applies its iterate-and-fork pattern fully — do not stop at one search.

1. **Confirm indexed.** Run `diwa ls`. If this project isn't listed, **skip Phase 0 entirely** and note in the final report that history grounding was unavailable. Use the project's name as it appears in `diwa ls` for `<repo>` below.

2. **Run several seed searches in parallel.** Different angles on the same codebase:
   - `diwa search <repo> "architecture decisions and rationale"`
   - `diwa search <repo> "bug fixes incidents postmortems"`
   - `diwa search <repo> "reverted approaches things tried that failed"`
   - `diwa search <repo> "major refactors rewrites"`
   - Plus 1–3 project-specific angles drawn from `CLAUDE.md` or what you already know about the codebase.

3. **Follow the strings.** For each interesting `[sha]` returned, run `git -C <project-path> show <sha>` and mine the diff and commit message for clues — other SHAs, PR numbers, branch names, file paths, "follows up on…" / "reverts" / "see also" phrases, co-authors. Each clue is a candidate follow-up `diwa search`. Iterate until the tree converges (~3 hops max).

4. **Fork independent threads.** If the searches surface multiple non-overlapping rabbit holes (different subsystems, different time periods), spawn parallel subagents — one `Agent` call per thread, `subagent_type: "Explore"`, briefed with the diwa workflow (search → git show → iterate → stop on convergence), the seed SHAs, the thread it owns, and the threads it should *not* touch (the other agents own those — no duplicate work). Ask each for a tight (<300 word) synthesis. Launch them in a single message.

5. **Produce a history brief.** Synthesize everything into a concise 200–400 word document capturing:
   - **Major decisions & rationale** — key architectural choices and the *why*, with SHAs
   - **Known traps** — patterns tried and reverted, with SHAs and a one-line "don't redo this" warning
   - **Recent direction** — what is actively changing in the codebase right now
   - **Open tensions** — unresolved questions, known debts, or deferred decisions visible in the history

The history brief is the **primary input to Phase 2**. Every review agent must receive it verbatim in their shared context block so they can avoid recommending dead ends.

## Phase 1: Map the Codebase

Thoroughly explore the full project structure. Use Glob and Grep to build a complete picture:

1. **Source code** — find all source files by extension (`.rs`, `.ts`, `.py`, `.go`, `.dart`, `.java`, `.rb`, etc.)
2. **Configuration** — `Cargo.toml`, `package.json`, `pyproject.toml`, `go.mod`, `Makefile`, `CLAUDE.md`, etc.
3. **Tests** — locate test files, test directories, and test configuration
4. **Infrastructure** — `Dockerfile`, CI configs, deploy scripts

Read ALL source files. Every module, every component, every test. Do not skip files or skim — each agent needs the full picture to give meaningful advice. This is intentionally thorough.

## Phase 2: Launch Review Agents in Parallel

Send a single message with 8 Task tool calls so they run concurrently. Each agent should be `subagent_type: "general-purpose"` so it has access to all file-reading tools.

**IMPORTANT**: Tell each agent to read the source files directly rather than trying to pass all file contents in the prompt. The prompt should describe the project structure and direct the agent to the relevant directories.

Shared context to include in every agent prompt:
```
Read ALL source files before forming your review.
Report your top 5 findings ranked by impact. For each finding, cite the specific file and line.
Do NOT suggest changes that would reduce capabilities or fight language/framework idioms.
Cross-reference your findings against the Phase 0 history brief — do not recommend approaches that have already been tried and reverted. If a finding matches a known trap, drop it or explain what's different now. Cite SHAs from the brief.
```

**Before launching the agents, append the full Phase 0 history brief verbatim to the shared context block above so every agent receives it.**

Include the project name, tech stack, architecture summary, and key directories you discovered in Phase 1.

### Agent 1: Rich Hickey — Simplicity & Data Orientation

You are channeling Rich Hickey (creator of Clojure, author of "Simple Made Easy").

Review the entire codebase for:

1. **Complecting** — Are independent concerns entangled? State mixed with identity? Coordination mixed with logic? Look for things that are *easy* (familiar, nearby) but not *simple* (one fold, one braid). Name the specific things being complected.
2. **Data over abstractions** — Is behavior hiding data that wants to be plain values? Could maps, records, or plain data structures replace custom classes/objects? Are there methods that should be functions operating on data?
3. **State and identity** — Is mutable state used where values + managed references would be clearer? Are there atoms of state that could be immutable snapshots? Is state being changed in place when it could flow through transformations?
4. **Accidental complexity** — What's incidental to the problem vs. essential? Are there abstractions that exist for the framework but not for the domain? Is there ceremony that doesn't earn its keep?
5. **Composition over complection** — Could smaller, independent pieces be composed rather than having a large intertwined unit? Are there seams where things could be pulled apart?

**Key Hickey question**: "Can I think about this independently of that?" If two things must be thought about together but don't *have* to be, they're complected.

### Agent 2: Alan Kay — Message Passing & Late Binding

You are channeling Alan Kay (inventor of Smalltalk, coined "object-oriented programming").

Review the entire codebase for:

1. **Objects as biological cells** — Are objects self-contained units that communicate through messages? Or are they bags of getters/setters with their guts exposed? Does each object have a clear responsibility boundary?
2. **Message passing over method calling** — Is the code organized around *what* to do (messages/intentions) or *how* to do it (direct method calls with assumptions about internals)? Could indirection or late binding make it more resilient to change?
3. **Extreme late binding** — Are decisions being made too early? Hardcoded where they could be parameterized? Could interfaces, protocols, or callbacks defer decisions to the right moment?
4. **The real OOP** — Kay said OOP is about messaging, not inheritance. Look for inheritance hierarchies that should be composition. Look for type checks that should be polymorphic dispatch. Look for switch statements on types.
5. **Scale and resilience** — If this code were 100x bigger, would the abstractions hold? Are there assumptions that work now but would crumble at scale? Is the architecture fractal (same patterns at every level)?

**Key Kay question**: "If I sent this object a message, would it know what to do without me knowing how it works inside?"

### Agent 3: Eric Evans — Domain-Driven Design

You are channeling Eric Evans (author of "Domain-Driven Design").

Review the entire codebase for:

1. **Ubiquitous language** — Do the names in code match the domain language? Would a domain expert recognize these terms? Are there implementation-speak names where domain terms would be clearer? Flag any naming that leaks infrastructure into the domain.
2. **Bounded contexts** — Are there clear boundaries between subsystems? Is each module responsible for one coherent slice of the domain? Or are concerns bleeding across boundaries? Where should anticorruption layers exist?
3. **Entities vs. Value Objects** — Are things modeled correctly? Are there entities (identity matters) being treated as values? Value objects (identity doesn't matter) being given unnecessary IDs or mutability?
4. **Aggregates** — Is there a clear consistency boundary? What's the aggregate root? Are invariants being maintained at the right level? Is there state that should be transactional but isn't?
5. **Domain events and side effects** — Are side effects explicit or hidden? Could domain events make the flow of change clearer? Are there implicit workflows that should be modeled explicitly?

**Key Evans question**: "Does this code tell the story of the domain, or does it tell the story of the framework?"

### Agent 4: Composition & Functional Design

You are channeling the functional programming tradition (Haskell, ML, Erlang, Elm).

Review the entire codebase for:

1. **Pure core, impure shell** — Is business logic entangled with I/O, framework calls, or side effects? Could the core be a pure function that transforms input to output, with effects pushed to the edges?
2. **Total functions** — Are there partial functions (can crash/throw on valid inputs)? Null checks that indicate an optional type is missing? Exceptions used for control flow?
3. **Algebraic data types** — Could sum types (sealed classes, tagged unions, enums with data) replace boolean flags, string types, or null sentinels? Are there impossible states that the type system could prevent?
4. **Composition over configuration** — Are there small functions that compose into larger behaviors? Or monolithic functions with many parameters/flags? Could pipelines replace procedural sequences?
5. **Referential transparency** — Can you replace a function call with its return value without changing behavior? If not, where does the impurity leak in? Are there hidden dependencies on global state, time, or order of execution?

**Key FP question**: "Given the same inputs, does this always produce the same output? If not, why not, and is that essential?"

### Agent 5: Joe Armstrong — Fault Tolerance & Isolation

You are channeling Joe Armstrong (creator of Erlang, co-inventor of OTP).

Review the entire codebase for:

1. **Process isolation** — Are failure domains isolated? Can one component crash without taking down others? Can one request's failure poison another?
2. **Let it crash** — Is error handling trying to recover from things that should just crash and restart? Are there try/catch blocks papering over deeper problems? Would a supervisor strategy be cleaner than defensive error handling?
3. **Message passing and protocols** — Are components communicating through well-defined message protocols? Are messages immutable values or mutable shared state? Could you draw a message sequence diagram of the interactions?
4. **Supervision trees** — Is there a clear hierarchy of "who watches whom"? If a process dies, who notices? If a connection drops, who cleans up? Are there orphaned resources waiting to happen?
5. **Hot code reloading** — Can the system evolve without downtime? Are there implicit assumptions about initialization order that would break rolling updates? Is state serializable across restarts?

**Key Armstrong question**: "What happens when this fails? Who notices, and what do they do about it?"

### Agent 6: Sandi Metz — Practical Object Design

You are channeling Sandi Metz (author of "Practical Object-Oriented Design in Ruby" and "99 Bottles of OOP").

Review the entire codebase for:

1. **Single Responsibility** — Does each class/module/function have one reason to change? If you had to describe what it does, would you use the word "and"? Metz rule of thumb: a class should be describable in one sentence without "and" or "or."
2. **Dependency direction** — Do dependencies point toward stability? Are volatile things depending on stable things, or vice versa? Could dependency injection make the code more flexible without adding complexity?
3. **Tell, Don't Ask** — Is code asking objects for data and then making decisions, or telling objects what to do? Look for chains of `object.property.method()` (Law of Demeter violations). Look for conditionals based on another object's state.
4. **Small methods, small objects** — Are methods under ~5 lines? Are classes under ~100 lines? If not, where are the natural seams to break them apart? Metz: "small objects that send messages to each other."
5. **Cost of change** — Is the code easy to change? Would a new requirement require editing many files or just one? Are there shotgun surgery patterns where a single concept change requires updates in 5 places?

**Key Metz question**: "What is the future cost of doing nothing? Is this code easy to change, or does it resist change?"

### Agent 7: Leslie Lamport — State Machines & Temporal Reasoning

You are channeling Leslie Lamport (creator of TLA+, LaTeX, Paxos, Lamport clocks).

Review the entire codebase for:

1. **State machine clarity** — Can you enumerate the states this system can be in? Are transitions explicit or implicit? Draw the state machine: what states exist, what transitions are valid, what's the initial state? Are there states that should be unreachable but aren't?
2. **Invariants** — What must always be true? Are these invariants enforced by the code or just hoped for? Could they be violated by race conditions or unexpected message ordering?
3. **Temporal properties** — Are there liveness properties (something good eventually happens)? Safety properties (something bad never happens)? Are these guaranteed?
4. **Concurrency hazards** — Are there race conditions? What if two operations happen in the wrong order? What if a resource is deleted while being read? Think about all interleavings.
5. **Specification vs. implementation** — Could the core logic be specified as a state machine with clear pre/post conditions? Would writing that specification reveal bugs or ambiguities in the current implementation?

**Key Lamport question**: "What are ALL the possible states? Which ones are valid? Can the system reach an invalid state?"

### Agent 8: Kent Beck — Simple Design & Courage to Change

You are channeling Kent Beck (creator of Extreme Programming, TDD, JUnit, Smalltalk patterns).

Review the entire codebase for:

1. **Four rules of simple design** — In priority order: (a) Passes the tests. (b) Reveals intention. (c) No duplication. (d) Fewest elements. Is there code that violates these, especially (b) and (c)?
2. **Make the change easy, then make the easy change** — Is there a refactoring that would make the *next* change trivial? Is the code resisting a change that should be easy? What preparatory refactoring would help?
3. **YAGNI** — Is there code preparing for a future that may never come? Configuration for things that are never configured? Abstractions for variation that doesn't exist? Parameters nobody passes?
4. **Test-driven gaps** — Looking at the code, what tests are missing? What edge cases aren't covered? What would a test-first approach have produced differently? Where would tests give the most confidence?
5. **Courage** — Is there code everyone is afraid to touch? Complexity that persists because "it works"? Would a bold simplification (delete this class, inline this abstraction, merge these two things) make everything clearer?

**Key Beck question**: "What's the simplest thing that could possibly work? And then: is this simpler than what we have?"

## Phase 3: Distill

Wait for all eight agents to complete. Then:

**Step 0 — Cross-reference against history.** Take each candidate finding from any agent and check it against the Phase 0 history brief. If the finding matches a known trap (something the team tried and reverted), either drop it or explain what's changed since the prior attempt. Cite the SHA from the brief. This filter runs first.

1. **Cross-reference** — Look for findings that multiple agents agree on. These are highest signal. Present a consensus table showing which agents flagged each theme.
2. **Filter** — Discard findings that would:
   - Add abstraction without clear payoff
   - Fight the language/framework idioms
   - Reduce capabilities or remove features
3. **Rank** — Order remaining findings by impact (how much clarity, maintainability, or correctness they add).

## Phase 4: Build the Execution Plan

Create a detailed, phased execution plan. Each phase should be a cohesive unit of work that can be committed and verified independently. Organize by dependency order — earlier phases should unblock later ones.

For each phase:
- **Title** — short name
- **Motivation** — which agents/perspectives drive this, and why it matters
- **Scope** — exact files and functions to change
- **Steps** — numbered implementation steps, specific enough to execute without ambiguity
- **Verification** — how to confirm the change works (tests, linting, manual check, etc.)
- **Risk** — what could go wrong, and how to mitigate

Group into tiers:
- **Tier 1: Critical fixes** — bugs, safety issues, correctness problems. Do these first.
- **Tier 2: Type safety & cleanup** — enum replacements, dead code removal, stringly-typed fixes. Low risk, high clarity.
- **Tier 3: Structural improvements** — decomposition, extraction, protocol simplification. Medium effort, high long-term value.
- **Tier 4: Architectural evolution** — cross-cutting changes that touch multiple subsystems. Needs careful sequencing.

## Phase 5: Present Plan and Get Feedback

**STOP HERE and present the plan to the user before doing any implementation.**

Output the full execution plan as a numbered list grouped by tier. For each item, show:
1. The title and a one-line summary
2. Which files it touches
3. Which agents motivated it (e.g., "Armstrong #1, Lamport #2")

Then use `AskUserQuestion` to ask the user:
- "How should I proceed with this plan?" with options:
  - **Execute all** — implement every tier, commit after each phase
  - **Execute Tier 1-2 only** — critical fixes and type safety only, defer structural/architectural work
  - **Let me adjust first** — user wants to modify the plan before execution

If the user chooses "Let me adjust first", wait for their edits and re-present the updated plan. Do NOT proceed to Phase 6 until the user approves.

## Phase 6: Execute

Once the user approves, work through the approved plan tier by tier.

For each phase within a tier:
1. **Announce** — state which phase you're starting and what it does
2. **Implement** — make the changes
3. **Verify** — run the project's test suite and linting
4. **Checkpoint** — commit the changes with a descriptive message

After completing each tier, briefly summarize what was done and confirm all tests still pass before moving to the next tier.

If a phase turns out to be larger or riskier than expected during implementation, stop, explain why, and ask whether to continue or defer it.

## Phase 7: Ship

After all approved tiers are complete:
1. Run the full test suite
2. Create a feature branch, commit all work, and run `/ship-it`
