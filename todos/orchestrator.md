# Orchestrator

Use katulong as a multi-agent orchestrator — spawn workers per project, dispatch tasks, monitor output.

## Setup (do this on the host machine)

1. Run:
   ```bash
   katulong setup api
   ```
   This creates an API key and saves it to `~/.katulong/credentials/orchestrator-api-key`.

2. Kubo containers automatically mount `~/.katulong/credentials/` read-only, so the key is available at `/home/dev/.katulong/credentials/orchestrator-api-key` inside every kubo.

3. Verify from any kubo:
   ```bash
   curl -s -H "Authorization: Bearer $(cat ~/.katulong/credentials/orchestrator-api-key)" \
     https://katulong-mini.felixflor.es/sessions
   ```
   Should return a JSON array of sessions (not a 302 redirect).

## Open
- [ ] `crew output --follow` uses 1s polling — switch to SSE via pub/sub for real-time streaming
- [ ] No way to detect when a command finishes (wait-for-idle / wait-for-prompt)
- [ ] No structured metadata per worker (role, task description) — just session name

## Key decisions
- **Stable URL**: `https://katulong-mini.felixflor.es` — always use this, never localhost ports
- **API key auth**: stored at `~/.katulong/credentials/orchestrator-api-key`, chmod 600, auto-mounted into kubos
- **Two-instance problem**: the katulong inside a kubo (dev) is NOT the one the user sees (host). Always target the stable URL.
- **HTTP API over CLI**: the crew CLI uses env vars that silently target the wrong instance inside kubos. Use curl with explicit URL + Bearer token.

## Done
- [x] `POST /sessions/:name/exec` — write input to PTY via HTTP
- [x] `GET /sessions/:name/output` — read output via HTTP (lines, fromSeq, screen modes)
- [x] `katulong crew` CLI — list, status, spawn, exec, output, kill with project namespacing
- [x] Session naming convention: `{project}--{worker}`
- [x] `/orchestrate` updated to use stable URL + API key pattern
- [x] `katulong setup api` — CLI command that creates an orchestrator API key and saves it to `~/.katulong/credentials/orchestrator-api-key` (lib/cli/commands/setup.js)
- [x] Kubo now mounts all of `~/.katulong` into containers (not just uploads). The orchestrator API key is available at `~/.katulong/credentials/orchestrator-api-key` inside every kubo. Changed in `kubo-core/src/container.rs` — replaced separate uploads + credentials mounts with a single `~/.katulong` → `/home/dev/.katulong` mount.
- [x] All containers refreshed via `kubo refresh` (2026-03-30) — katulong, diwa, yolo, tala, levee all have the new mount
