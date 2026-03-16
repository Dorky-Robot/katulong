Spin up a staging instance of katulong with a Cloudflare tunnel and fresh setup token.

Run the staging script:

```bash
$REPO_ROOT/bin/katulong-stage $ARGUMENTS
```

If `$ARGUMENTS` is `--stop`, it tears down staging. If `$ARGUMENTS` is `--status`, it shows running instances. Otherwise it spins up a new staging instance from the current directory (or the path given in `$ARGUMENTS`).

Report the output to the user exactly as printed by the script.
