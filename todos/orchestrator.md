# Orchestrator

Use katulong as a multi-agent orchestrator — spawn workers per project, dispatch tasks, monitor output.

## Blocked
- [ ] **Discovery file** — `katulong setup api` should create `~/.katulong/remote.json` containing `{ "url": "https://...", "apiKey": "..." }`. One file, everything needed to reach the host katulong from any context (kubo, host shell, CI). The `setup api` command should prompt for the URL or detect it from the running instance's external URL config. Kubos mount `~/.katulong/` so the file is automatically available everywhere.

## Open
- [ ] Fix `katulong setup api` to write the API key into the running instance's actual data dir (currently broken when data dir differs from default)
- [ ] `crew output --follow` uses 1s polling — switch to SSE via pub/sub for real-time streaming
- [ ] No way to detect when a command finishes (wait-for-idle / wait-for-prompt)

## Key architecture decisions
- **Single discovery file**: `~/.katulong/remote.json` — contains URL + API key. One file to find the right katulong from anywhere.
- **Existing API key auth is sufficient** — no need for a new auth mechanism. The problem was plumbing (wrong data dir, missing mounts), not the auth model.
- **Colima VM isolation**: localhost inside a kubo is the VM, not the Mac host. The host katulong binds to `127.0.0.1` on the Mac, unreachable from the VM. The only path from kubo to host katulong is the public URL (Cloudflare tunnel), which requires API key auth.
- **Orchestrator prefers kubo**: spin up sessions via the host katulong API, workers run inside kubos via `yolo`.

## Done
- [x] `POST /sessions/:name/exec` — write input to PTY via HTTP
- [x] `GET /sessions/:name/output` — read output via HTTP (lines, fromSeq, screen modes)
- [x] `katulong crew` CLI — list, status, spawn, exec, output, kill with project namespacing
- [x] Session naming convention: `{project}--{worker}`
- [x] `/orchestrate` updated to use stable URL + API key pattern
- [x] `katulong setup api` — creates API key (needs fix for data dir detection)
- [x] Kubo mounts `~/.katulong` rw into containers
- [x] All containers refreshed via `kubo refresh`
- [x] Confirmed: host networking doesn't work in Colima VMs — need public URL + API key
