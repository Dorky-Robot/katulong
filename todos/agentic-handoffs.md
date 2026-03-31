# Agentic Handoffs

Set up a system where implementation work flows automatically: orchestrator dispatches → worker completes → results collected → tests run on host (Playwright with real browser) → ship.

## Open
- [ ] **Host-side test runner** — workers complete in kubos but E2E tests need Playwright on the Mac (real browser). Need an agent on the host that picks up completed worktree branches, runs `npm run test:e2e`, and reports back.
- [ ] **Completion detection → handoff** — use `crew wait` to detect when a worker finishes, then trigger the next step (cherry-pick, test, PR). Currently manual.
- [ ] **Event bus integration** — use katulong's pub/sub (`/pub`, `/sub`) as the event bus for handoff signals: `crew/{project}/{worker}/done`, `crew/{project}/{worker}/failed`. Workers publish their status, the orchestrator subscribes.
- [ ] **Host agent via katulong API** — run a Claude instance on the host (not in kubo) that can: run Playwright, manage kubos, access Docker. It receives tasks via the event bus and reports results back.
- [ ] **Automated PR pipeline** — worker finishes → event → host agent runs E2E → passes → orchestrator creates PR → review agents → merge → release

## Architecture sketch
```
Orchestrator (kubo) → dispatches workers via katulong API
    ↓
Workers (kubo worktrees) → implement, commit, publish "done" to pub/sub
    ↓
Host agent (Mac) → subscribes to "done" events, runs Playwright E2E
    ↓
Orchestrator → cherry-picks, creates PR, runs review agents, merges
```

## Context
- Mac Mini host has real browser (Chrome) for Playwright
- Kubos can't run Playwright (Colima VM, no GUI)
- Katulong pub/sub is ephemeral (in-memory) — fine for real-time handoffs, not persistent queues
- The `crew wait` command already polls `GET /sessions/:name/status` for completion
