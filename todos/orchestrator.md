# Orchestrator

Use katulong as a multi-agent orchestrator.

## Blocked
- [ ] **Can't dispatch workers from kubo** — host katulong sessions are Mac tmux sessions. Worktrees exist inside the Colima VM. `kubo katulong` attaches to the same container (not isolated). Need either: (a) `kubo exec katulong "command"` to run commands inside the kubo without attaching, or (b) host katulong sessions that auto-enter the kubo, or (c) run workers from the host side using the Mac-side project path.

## Open
- [ ] `crew output --follow` uses 1s polling — switch to SSE via pub/sub
- [ ] No way to detect when a command finishes

## Key learning (2026-03-31)
The orchestrator (this Claude inside kubo) can CREATE sessions on the host katulong via API. But dispatching `yolo` into those sessions fails because:
1. Host sessions run in Mac tmux, not inside the kubo
2. `kubo katulong` attaches to the existing container (not isolated) — it drops into the same shell as the orchestrator
3. VM paths (`/work/katulong/`) don't exist on the Mac

Possible solutions:
- `kubo exec katulong "cd /work/katulong/.worktrees/foo && yolo -p '...'"` — runs inside the kubo without attaching
- Run the orchestrator ON the host, not inside the kubo — then workers are just `yolo` in Mac-side worktrees
- Katulong sessions that know they should run inside a kubo (session config: `kubo: "katulong"`)

## Done
- [x] API access working (remote.json + self-access)
- [x] Session creation + exec + output endpoints
- [x] `katulong crew` CLI
- [x] Notification toast fallback
