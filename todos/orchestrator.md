# Orchestrator

## Open
- [ ] `crew output --follow` uses 1s polling — switch to SSE via pub/sub

## Done
- [x] API access (remote.json + self-access)
- [x] Session create + exec + output endpoints
- [x] `katulong crew` CLI
- [x] Notification toast fallback
- [x] `GET /sessions/:name/status` — alive, hasChildProcesses, childCount
- [x] `crew wait` — polls status until command finishes
- [x] Dispatch via `kubo katulong` → worktree → yolo works end-to-end
