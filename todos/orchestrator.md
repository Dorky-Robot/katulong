# Orchestrator

See `docs/dorkyrobot-stack.md` for the full architecture design.

## Open
- [ ] **Durable pub/sub** — replace in-memory topic broker with file-backed storage in `~/.katulong/pubsub/`. Append-only JSONL per topic, monotonic sequence numbers, replay from `?fromSeq=N`. Survives restarts/updates.
- [ ] **Hook integration** — wire Claude Code lifecycle events (SubagentStop, TaskCompleted, Stop) to katulong pub/sub via hooks config. This replaces custom event systems.
- [ ] **`crew output --follow` via SSE** — switch from 1s polling to SSE with durable replay (depends on durable pub/sub)
- [ ] **Wildcard subscriptions** — glob-based topic matching (`crew/katulong/+/agent-done`) using the directory structure of pubsub/

## Done
- [x] API access (remote.json + self-access)
- [x] Session create + exec + output endpoints
- [x] `katulong crew` CLI
- [x] Notification toast fallback
- [x] `GET /sessions/:name/status` — alive, hasChildProcesses, childCount
- [x] `crew wait` — polls status until command finishes
- [x] Dispatch via `kubo katulong` → worktree → yolo works end-to-end
