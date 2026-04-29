---
name: katulong-mesh-update
description: Roll a `katulong update` across the user's configured mesh of katulong hosts using `bin/katulong-mesh-update`. Each host updates the OTHERS, never itself, so a botched release leaves at least one healthy peer to recover from. TRIGGER when the user wants to upgrade katulong on multiple machines at once ("update all my katulongs", "roll the new release out", "upgrade the mesh", "make all instances run vX.Y.Z"). DO NOT TRIGGER for a single-host upgrade (`katulong update` alone is enough), for staging instances (use `katulong-stage`), or for non-katulong projects.
---

# katulong-mesh-update — rolling update across a katulong mesh

`bin/katulong-mesh-update` walks a user-defined list of peer katulong hosts in order, runs `katulong update` on each via ssh, and verifies the post-update HTTP probe before moving to the next. The peer whose id matches `~/.katulong/node-id` is excluded — every host is responsible for upgrading its peers, never itself. That asymmetry is the safety net: if the new release wedges a host, the orchestrator (this host) is still on the prior version and can roll back.

## When to reach for this skill

Use it when the user says (in spirit, not exact words):

- "roll the new release out to all my katulongs"
- "update all the katulong instances"
- "upgrade the mesh"
- "make every host run the latest"
- "what's the version status across my katulong fleet?" (use `list`)

Do NOT use it for:

- A single-host upgrade — bare `katulong update` is the right tool.
- Staging instances — use the `katulong-stage` skill.
- Pushing local in-development code to peers. This skill calls `katulong update`, which goes through the normal Homebrew tap → smoke test → swap path. If you want to test an unreleased branch on another device, stage it first.

## Subcommands

`bin/katulong-mesh-update [roll]` — run the rolling update (default).

`bin/katulong-mesh-update list` — show the configured peers, mark which one is "self" (excluded from rollout).

`bin/katulong-mesh-update --dry-run` — print the plan without ssh-ing. Use this whenever the user is uncertain about the mesh contents or you're preparing to roll a brand-new release for the first time.

## Why "never update self"

A katulong update has a few moving parts: brew formula sync, npm install on the upgraded prefix, smoke-test on a free port, LaunchAgent restart. Each step has plausible failure modes (network flake, brew lock, port held by zombie process). When all hosts update simultaneously and one wedges, you can't ssh in to investigate because the host you'd ssh FROM is also part of the broken set.

The mesh-update rule sidesteps that:

- Run `bin/katulong-mesh-update` from machine A → machines B, C, D upgrade.
- Run it from machine B → machines A, C, D upgrade.
- A bad release that hangs a host on upgrade leaves at least one peer untouched, with shell access to fix the others.

If the user asks "but how do I upgrade THIS host?" — the answer is "ssh to a peer and run `katulong-mesh-update` from there." Don't add a `--include-self` flag; the asymmetry IS the feature.

## Reporting the rollout

When you run `bin/katulong-mesh-update`, surface the script's output verbatim — the per-peer `before`/`after` versions and HTTP code are exactly the verification the user wants. On success, conclude with a summary table; on failure, surface the failed peer id, the version state at failure, and the "fix and re-run" hint the script prints. `katulong update` is idempotent (already-current host = `Already up to date`), so a fixed-and-retried run safely no-ops the peers that already succeeded.

## Setup the user has to do once

The script reads two files in `$KATULONG_DATA_DIR` (default `~/.katulong`):

- `mesh.json` — the peer list, same on every host:
  ```json
  {
    "peers": [
      { "id": "host-a", "ssh": "alias-a" },
      { "id": "host-b", "ssh": "alias-b" }
    ]
  }
  ```
- `node-id` — single line containing this host's id (one of the `peers[*].id` values).

If the user is configuring this for the first time and asks for help, suggest copying `mesh.json` to every host (it's identical) and writing the right `node-id` on each. Don't generate the contents from your own knowledge — ask the user for their host inventory and ssh aliases.

## Failure modes worth flagging

- `mesh.json` missing → script prints a clear error pointing at `~/.katulong/mesh.json` and the expected schema. Don't try to write the file from memory; have the user create it.
- `node-id` missing → script warns and proceeds to update every peer including this host. Almost always a misconfiguration; tell the user to create the file before re-running, unless they explicitly want every-host-including-self behavior.
- `ssh <alias>` fails → rollout halts immediately. Could be network, a downed peer, or a stale ssh alias. Surface the alias verbatim so the user knows which mesh entry to fix.
- `katulong update` fails on a peer → rollout halts. The remote command's stdout is already streamed, so the user has the failure context. Suggest re-running once they've fixed the underlying cause.
- Post-update HTTP probe `!= 200` → the upgrade swap completed but the new server isn't serving. Suggest `ssh <alias> 'katulong status'` and `katulong service restart` as recovery steps.
