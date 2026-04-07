---
name: katulong-stage
description: Stage and unstage isolated Katulong instances behind a Cloudflare tunnel using `bin/katulong-stage`. TRIGGER when the user wants to spin up a temporary Katulong instance for testing on another device (phone, iPad, etc.), share an in-progress branch with someone over the internet, smoke-test a feature against a fresh database before merging, or tear down a previous staging. DO NOT TRIGGER for the production Katulong instance, for the e2e test server (which uses its own scripts under test/e2e/), or for non-Katulong projects.
---

# katulong-stage — isolated Katulong staging behind a Cloudflare tunnel

`katulong-stage` (lives at `bin/katulong-stage` in this repo) spins up a fully isolated Katulong instance — fresh data dir, fresh tmux socket, fresh setup token, attached to a stable Cloudflare tunnel hostname — and can tear it down cleanly. Use it whenever the user wants to test an in-progress branch from another device without polluting the production Katulong, or wants to share a branch over the internet for review.

## When to reach for this skill

Use it when the user says (in spirit, not exact words):

- "stage this branch so I can pair my phone to it"
- "spin up a temporary katulong on the tunnel"
- "I need a setup token for testing the branch"
- "tear down staging" / "clean up staging" / "kill the staging instance"
- "what's running on the tunnel right now?"

Do NOT use it for:

- Restarting or modifying the production katulong server (use `katulong restart`, `katulong update`).
- The e2e test harness — that has its own server lifecycle under `test/e2e/`.
- Non-Katulong projects.

## What "isolated" buys you

A staging instance is completely partitioned from prod. The script:

| Aspect | How it's isolated |
|---|---|
| Auth state (passkeys, sessions, setup tokens) | `KATULONG_DATA_DIR=/tmp/katulong-stage/<name>/data` |
| tmux server | `KATULONG_TMUX_SOCKET=stage-<name>` — `tmux -L stage-<name> kill-server` only touches staging |
| TCP port | Free port allocated dynamically starting at 3050 |
| Public URL | Stable hostname `<name>.<tunnel>` on the existing named tunnel (e.g. `palette-system.felixflor.es`) |
| Setup token | Minted via the staging server's own `katulong token create` API — no shared state with prod |

This means a phone paired to staging gets a passkey scoped to the staging hostname only. Tearing down staging removes the route, kills the server, kills the staging-specific tmux server, and deletes the data dir. Prod is untouched.

## Core commands

```
bin/katulong-stage start [name]    # default name = current git branch
bin/katulong-stage stop  [name]    # default = stop ALL staging instances
bin/katulong-stage list            # show running instances
```

The default name is the current git branch slugified (e.g. `feature/palette-system` → `feature-palette-system`). Pass an explicit name when staging from a detached HEAD or when you want a shorter hostname.

## Configuration

The script reads `~/.katulong/config.json` (or `$KATULONG_DATA_DIR/config.json` if the user has overridden their personal data dir) for two optional keys under a `stage` namespace:

| Key | Purpose | Default |
|---|---|---|
| `stage.tunnel` | Pin the named tunnel to use — skips auto-detect entirely | first dotted tunnel from `tunnels list --json` |
| `stage.domain` | Override the hostname suffix — host becomes `<name>.<stage.domain>` instead of `<name>.<tunnel>` | tunnel name |

Example `~/.katulong/config.json`:

```json
{
  "instanceName": "my-mini",
  "stage": {
    "tunnel": "my-cf-tunnel",
    "domain": "example.com"
  }
}
```

With this config, `bin/katulong-stage start palette-system` → `https://palette-system.example.com`, attached to the `my-cf-tunnel` named tunnel.

**Why a config file rather than env vars or CLI flags:** the choice of tunnel/domain is per-machine (it's a property of the user's Cloudflare setup, not the branch they're staging), and it should persist across shells without having to remember to export anything. Adding it as a key in the existing `~/.katulong/config.json` keeps all per-user katulong knobs in one place.

If neither key is set, the script auto-detects via `tunnels list --json` (preferring a tunnel whose name looks like a domain). If the `tunnels` CLI isn't installed or no named tunnel is registered, the script fails loud — there is no fallback path. See "Why no cloudflared fallback" below.

## Hard requirement: the `tunnels` CLI

`katulong-stage` will only spin up an instance if the `tunnels` CLI is on `$PATH` and at least one named tunnel is registered. There is no fallback to raw `cloudflared`, no ephemeral `trycloudflare` URL, no degraded mode. If the user is on a fresh box, point them at:

```bash
brew tap dorky-robot/tap && brew install tunnels
tunnels add <name> --token <cloudflare-tunnel-token>
```

### Why no cloudflared fallback

An earlier version of this script fell back to `cloudflared tunnel --url http://127.0.0.1:<port>` when `tunnels` was missing. That was removed because:

1. **Trycloudflare hostnames change every run.** WebAuthn binds passkeys to the RP ID (effectively the hostname), so a phone paired against an ephemeral URL loses its passkey on the next staging restart. For a tool whose entire point is "pair a device, test from it, iterate," this is not a tolerable failure mode.
2. **Two sources of tunnel truth.** Routes added by raw `cloudflared` aren't visible to `tunnels list`, so the staging script ended up reasoning about tunnel state via two unrelated mechanisms. The whole project standardizes on `tunnels` for any cloudflared interaction.
3. **Failing loud is friendlier than degrading silently.** When the named-tunnel path doesn't work, we now print exactly what's wrong and exactly what to do — install `tunnels`, or pin a tunnel via `stage.tunnel`. That's a one-time setup cost, not a per-run footgun.

## What `start` actually does

1. Picks a free TCP port at or above 3050.
2. Creates `/tmp/katulong-stage/<name>/data` (chmod 700) and starts `node server.js` with `PORT`, `KATULONG_DATA_DIR`, and `KATULONG_TMUX_SOCKET=stage-<name>` env vars.
3. Polls `http://127.0.0.1:<port>/login` until the server responds (up to 20s).
4. Calls `KATULONG_DATA_DIR=<dir> node bin/katulong token create "<name>" --json` and parses the structured payload — the CLI uses `<dir>/server.json` to find the staging server's port and hits its `POST /api/tokens` endpoint, so the token is minted on the right instance.
5. Verifies the `tunnels` CLI is installed; bails with a clear error if not.
6. Resolves a named tunnel: first `stage.tunnel` from config, otherwise `tunnels list --json` auto-detect (prefers a tunnel whose name contains a dot, e.g. `felixflor.es`). Bails if nothing is found.
7. `tunnels route add <name>.<tunnel-or-stage.domain> <port> --tunnel <tunnel>` to wire up the stable hostname.
8. Writes `/tmp/katulong-stage/<name>/meta.env` with all the state needed by `stop` and `list`. If the write fails, the route is removed and the server is killed (no orphans).
9. Prints the URL, the pair URL (with `?setup_token=...`), and the stop command.

## What `stop` actually does

Reads `meta.env`, then in order:

1. Sends `SIGTERM` to the server PID; if it survives 1s, sends `SIGKILL`.
2. `tmux -L stage-<name> kill-server` to clean up the isolated tmux server.
3. `tunnels route rm <host> --tunnel <tunnel>` to remove the public route + DNS.
4. `rm -rf /tmp/katulong-stage/<name>` so nothing leaks across runs.

`stop` with no name stops ALL running instances. `stop <name>` stops just that one.

## Workflow examples

**Stage the current branch and tell the user the pair URL:**

```bash
bin/katulong-stage start
# → prints "Pair URL: https://<branch>.felixflor.es/login?setup_token=<token>"
```

Tell the user the pair URL so they can scan/visit it from a phone or iPad to enroll a passkey on staging.

**Check what's running:**

```bash
bin/katulong-stage list
```

**Tear down a single instance:**

```bash
bin/katulong-stage stop palette-system
```

**Tear down everything (e.g. at end of session):**

```bash
bin/katulong-stage stop
```

## Caveats

- **`tunnels` CLI is mandatory.** See "Hard requirement" above.
- **Setup token CLI talks to the staging server, not prod.** This is achieved by setting `KATULONG_DATA_DIR` so that `lib/cli/process-manager.js` reads the staging `server.json`. Don't bypass this and write tokens to disk by hand — the original `katulong-stage` did that and it broke silently when the auth storage format changed.
- **`stop` with no argument stops everything.** This is intentional for end-of-session cleanup, but be careful if multiple staging instances are running for different branches.
- **Each staging instance gets its own tmux server.** This is required for clean teardown. If the user runs `tmux ls` they will not see staging tmux sessions unless they pass `tmux -L stage-<name> ls`.

## Files this skill owns

- `bin/katulong-stage` — the script itself
- `.claude/commands/stage.md` — the user-facing `/stage` slash command, which delegates to this script
- `.claude/skills/katulong-stage/SKILL.md` — this file
