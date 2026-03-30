# Orchestrator

Use katulong as a multi-agent orchestrator — spawn workers per project, dispatch tasks, monitor output.

## Open
- [ ] `crew output --follow` uses 1s polling — switch to SSE via pub/sub for real-time streaming
- [ ] No way to detect when a command finishes (wait-for-idle / wait-for-prompt)
- [ ] No structured metadata per worker (role, task description) — just session name

## Done
- [x] `POST /sessions/:name/exec` — write input to PTY via HTTP
- [x] `GET /sessions/:name/output` — read output via HTTP (lines, fromSeq, screen modes)
- [x] `katulong crew` CLI — list, status, spawn, exec, output, kill with project namespacing
- [x] Session naming convention: `{project}--{worker}`
