Stage and unstage isolated Katulong instances behind a Cloudflare tunnel.

Run the staging script with the user's arguments verbatim:

```bash
$REPO_ROOT/bin/katulong-stage $ARGUMENTS
```

Subcommands:

- `start [name]` — start a staging instance (default name = current branch). Prints the public URL, a pair URL with a fresh setup token, and the stop command.
- `stop [name]` — tear down staging. With no name, stops ALL running instances. With a name, stops just that one.
- `list` — show running staging instances.

If the user runs `/stage` with no arguments, default to `start`. Report the script's output to the user exactly as printed.

For full background on the isolation guarantees and the rationale for the named-tunnel + token-CLI design, see the `katulong-stage` skill at `.claude/skills/katulong-stage/SKILL.md`.
