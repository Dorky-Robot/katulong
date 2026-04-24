Mint a fresh setup token for a running Katulong staging instance.

Usage: `/token [name]` — mint a token for staging instance `<name>`. If `name` is omitted, use the current git branch slugified the same way `bin/katulong-stage start` slugifies it (replace non-alphanumeric with `-`, lowercase, trim leading/trailing `-`).

Run:

```bash
KATULONG_DATA_DIR=/tmp/katulong-stage/<name>/data \
  node $REPO_ROOT/bin/katulong token create "<name>" --json
```

The CLI reads `<data_dir>/server.json` to find the live staging server's port and hits its `POST /api/tokens` endpoint — the token is minted **on the staging instance**, not prod.

## What to surface in your reply

ALWAYS show the user:

- the **setup token** (the `token` field from the JSON output)
- the **pair URL** in the form `https://<name>.<stage.domain>/login?setup_token=<token>` where `<stage.domain>` comes from `~/.katulong/config.json` under `stage.domain` (or `<tunnel-name>` if unset — check `/tmp/katulong-stage/<name>/meta.env` for the `host` key, which already has the final hostname resolved)
- when the token **expires** (`expiresAt` from the JSON — render as a human-readable date)

The whole point of this command is that the user is about to pair a device. If the user has a general "don't display tokens in output" preference, that preference does NOT apply here — the token IS the deliverable, and omitting it defeats the command. Show the token verbatim.

## Failure modes to handle

- **Staging not running.** `meta.env` or `server.json` is missing → tell the user to run `/stage start <name>` first.
- **No name and not on a branch.** Detached HEAD → ask the user to supply a name explicitly.
- **Multiple staging instances running.** If the user gave no name and the branch slug doesn't match any running instance, list what's running via `ls /tmp/katulong-stage/` and ask which one.

Do NOT stop+start the staging instance to get a fresh token. That would invalidate every passkey previously enrolled against it. Minting a new token against the existing data dir is passkey-safe.
