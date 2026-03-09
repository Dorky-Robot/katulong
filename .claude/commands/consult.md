Consult the masters — review the entire katulong codebase through the lens of great software engineers.

## Phase 1: Map the Codebase

Thoroughly explore the full project structure. Use Glob and Grep to build a complete picture:

1. **Source code** — find all `.js` files in `lib/`, `server.js`, `bin/katulong`
2. **Frontend** — all files in `public/` including `public/lib/`, `public/vendor/`
3. **Configuration** — `package.json`, `CLAUDE.md`, `nodemon.json`, `playwright.config.js`, `config.json`
4. **Tests** — all files in `test/` and `test/e2e/`
5. **Infrastructure** — `Dockerfile`, `docker-compose.yml`, `.husky/`, `scripts/`

Read ALL source files. Every module, every component, every test. Do not skip files or skim — each agent needs the full picture to give meaningful advice. This is intentionally thorough.

## Phase 2: Launch Review Agents in Parallel

Send a single message with 8 Task tool calls so they run concurrently. Each agent should be `subagent_type: "general-purpose"` so it has access to all file-reading tools.

**IMPORTANT**: Tell each agent to read the source files directly rather than trying to pass all file contents in the prompt. The prompt should describe the project structure and direct the agent to the relevant directories.

Shared context to include in every agent prompt:
```
Katulong is a self-hosted web terminal that gives remote shell access via HTTP/WebSocket.
It manages terminal sessions through tmux and serves an xterm.js frontend.
Key directories: lib/ (server modules), public/ (SPA frontend), test/ (comprehensive test suite).
Security-critical: this app provides direct terminal access to the host machine.
Backend: Node.js ESM, WebSocket (ws), tmux control mode, WebAuthn (@simplewebauthn/server).
Frontend: Vanilla JS, xterm.js, web components, all vendor deps self-hosted in public/vendor/.

Read ALL source files before forming your review.
Report your top 5 findings ranked by impact. For each finding, cite the specific file and line.
Do NOT suggest changes that would reduce capabilities or fight Node.js/JavaScript idioms.
```

### Agent 1: Rich Hickey — Simplicity & Data Orientation

You are channeling Rich Hickey (creator of Clojure, author of "Simple Made Easy").

Review the entire katulong codebase for:

1. **Complecting** — Are independent concerns entangled? Is auth logic mixed with session management? Is WebSocket handling mixed with business logic? Name the specific things being complected.
2. **Data over abstractions** — Could plain objects/maps replace classes? Are there methods that should be functions operating on data? Is the Session class earning its keep or hiding data?
3. **State and identity** — Is mutable state used where immutable values would be clearer? Are there atoms of state that could be snapshots? Is auth state being changed in place when it could flow through transformations?
4. **Accidental complexity** — What's incidental to the problem vs. essential? Are there abstractions that exist for the framework but not for the domain?
5. **Composition over complection** — Could smaller, independent pieces be composed rather than having a large intertwined unit?

**Key Hickey question**: "Can I think about this independently of that?" If two things must be thought about together but don't *have* to be, they're complected.

### Agent 2: Alan Kay — Message Passing & Late Binding

You are channeling Alan Kay (inventor of Smalltalk, coined "object-oriented programming").

Review the entire katulong codebase for:

1. **Objects as biological cells** — Are objects self-contained units that communicate through messages? Or bags of getters/setters with their guts exposed?
2. **Message passing over method calling** — Is the code organized around *what* to do (messages/intentions) or *how* to do it? The WebSocket protocol is a natural message-passing boundary — is it used that way?
3. **Extreme late binding** — Are decisions being made too early? Could the session manager be more pluggable? Could auth strategies be swappable?
4. **The real OOP** — Look for inheritance hierarchies that should be composition. Look for type checks that should be polymorphic dispatch.
5. **Scale and resilience** — If katulong had 100 concurrent sessions, would the abstractions hold?

**Key Kay question**: "If I sent this object a message, would it know what to do without me knowing how it works inside?"

### Agent 3: Eric Evans — Domain-Driven Design

You are channeling Eric Evans (author of "Domain-Driven Design").

Review the entire katulong codebase for:

1. **Ubiquitous language** — Do code names match the terminal/session domain? Would a user recognize terms like "session", "shortcut", "credential"? Are there implementation-speak names where domain terms would be clearer?
2. **Bounded contexts** — Are there clear boundaries between auth, session management, and the HTTP layer? Is each module responsible for one coherent slice?
3. **Entities vs. Value Objects** — Is Session an entity (identity matters) or being treated as a value? Are credentials modeled correctly?
4. **Aggregates** — Is there a clear consistency boundary for sessions? For auth state? Are invariants maintained at the right level?
5. **Domain events** — Are side effects explicit? Could domain events make the flow of session creation, auth, and WebSocket connection clearer?

**Key Evans question**: "Does this code tell the story of the domain, or does it tell the story of the framework?"

### Agent 4: Composition & Functional Design

You are channeling the functional programming tradition.

Review the entire katulong codebase for:

1. **Pure core, impure shell** — Is session management logic entangled with I/O? Could the core be pure functions with effects pushed to edges?
2. **Total functions** — Are there partial functions that crash on valid inputs? Null checks indicating missing optional types?
3. **Algebraic data types** — Could tagged unions replace boolean flags or string types? Are there impossible states the type system could prevent (even in JS via conventions)?
4. **Composition over configuration** — Are there small functions that compose? Or monolithic handlers with many flags?
5. **Referential transparency** — Can you replace function calls with return values? Where does impurity leak in?

**Key FP question**: "Given the same inputs, does this always produce the same output?"

### Agent 5: Joe Armstrong — Fault Tolerance & Isolation

You are channeling Joe Armstrong (creator of Erlang, co-inventor of OTP).

Review the entire katulong codebase for:

1. **Process isolation** — Can one crashed session take down the server? Can one bad WebSocket message poison another session?
2. **Let it crash** — Is error handling trying to recover from things that should just crash and restart? Are there try/catch blocks papering over deeper problems?
3. **Message passing and protocols** — Are WebSocket messages well-defined protocols? Are they immutable values or mutable shared state?
4. **Supervision trees** — If a tmux session dies, who notices? If the WebSocket drops, who cleans up? Are there orphaned resources?
5. **Hot code reloading** — Can the server restart without losing sessions? (tmux provides this — is it used correctly?)

**Key Armstrong question**: "What happens when this fails? Who notices, and what do they do about it?"

### Agent 6: Sandi Metz — Practical Object Design

You are channeling Sandi Metz.

Review the entire katulong codebase for:

1. **Single Responsibility** — Does each module/function have one reason to change? Can you describe what server.js does without using "and"?
2. **Dependency direction** — Do dependencies point toward stability? Is volatile code depending on stable code?
3. **Tell, Don't Ask** — Is code asking objects for data then deciding, or telling objects what to do?
4. **Small methods, small objects** — Are functions under ~20 lines? Are modules under ~300 lines? Where are the natural seams?
5. **Cost of change** — Would a new feature require editing many files? Are there shotgun surgery patterns?

**Key Metz question**: "Is this code easy to change, or does it resist change?"

### Agent 7: Leslie Lamport — State Machines & Temporal Reasoning

You are channeling Leslie Lamport.

Review the entire katulong codebase for:

1. **State machine clarity** — Can you enumerate session states (created, connected, disconnected, destroyed)? Are transitions explicit? Are there states that should be unreachable but aren't?
2. **Invariants** — What must always be true about auth state? About session state? Are these enforced by code or hoped for?
3. **Temporal properties** — Session cleanup (liveness). Auth token expiry (safety). Are these guaranteed?
4. **Concurrency hazards** — Race conditions in auth state (withStateLock)? What if two WebSocket connections attach to the same session simultaneously? What about concurrent credential operations?
5. **Specification vs. implementation** — Could the session lifecycle be specified as a state machine? Would that reveal bugs?

**Key Lamport question**: "What are ALL the possible states? Which ones are valid? Can the system reach an invalid state?"

### Agent 8: Kent Beck — Simple Design & Courage to Change

You are channeling Kent Beck.

Review the entire katulong codebase for:

1. **Four rules of simple design** — (a) Passes tests. (b) Reveals intention. (c) No duplication. (d) Fewest elements. Which rules are violated?
2. **Make the change easy** — Is there a refactoring that would make the *next* feature trivial?
3. **YAGNI** — Is there code preparing for a future that may never come? Configuration nobody uses? Abstractions for variation that doesn't exist?
4. **Test-driven gaps** — What tests are missing? What edge cases aren't covered? Where would tests give the most confidence?
5. **Courage** — Is there code everyone is afraid to touch? Would a bold simplification make everything clearer?

**Key Beck question**: "What's the simplest thing that could possibly work?"

## Phase 3: Distill

Wait for all eight agents to complete. Then:

1. **Cross-reference** — Look for findings that multiple agents agree on. Present a consensus table.
2. **Filter** — Discard findings that would add abstraction without payoff, fight Node.js idioms, or reduce capabilities.
3. **Rank** — Order remaining findings by impact.

## Phase 4: Build the Execution Plan

Create a detailed, phased execution plan. Each phase should be a cohesive unit of work.

Group into tiers:
- **Tier 1: Critical fixes** — bugs, safety issues, correctness problems
- **Tier 2: Type safety & cleanup** — dead code removal, better error types, state machine clarity
- **Tier 3: Structural improvements** — decomposition, extraction, protocol simplification
- **Tier 4: Architectural evolution** — cross-cutting changes

For each phase:
- **Title** — short name
- **Motivation** — which agents drive this
- **Scope** — exact files and functions
- **Steps** — numbered implementation steps
- **Verification** — `npm test`, manual check, etc.
- **Risk** — what could go wrong

## Phase 5: Present Plan and Get Feedback

**STOP HERE and present the plan to the user before doing any implementation.**

Ask the user:
- **Execute all** — implement every tier, commit after each phase
- **Execute Tier 1-2 only** — critical fixes and cleanup only
- **Let me adjust first** — user wants to modify the plan

Do NOT proceed to Phase 6 until the user approves.

## Phase 6: Execute

Work through the approved plan tier by tier. For each phase:
1. **Announce** — state which phase you're starting
2. **Implement** — make the changes
3. **Verify** — run `npm test`
4. **Checkpoint** — commit with a descriptive message

## Phase 7: Ship

After all approved tiers are complete:
1. Run `npm test` (full suite)
2. Create a feature branch, commit all work, and run `/ship-it`
