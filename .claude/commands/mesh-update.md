Roll a `katulong update` across every peer in the user's mesh, skipping this host.

Run the mesh-update script with the user's arguments verbatim:

```bash
$REPO_ROOT/bin/katulong-mesh-update $ARGUMENTS
```

Subcommands / flags:

- (no args) or `roll` — perform the rolling update. Each peer is updated in order; on any failure (ssh, brew, smoke test, post-update HTTP probe) the rollout halts and the remaining peers are not touched.
- `list` — print the configured peers and which entry matches this host (the one excluded from rollouts).
- `--dry-run` — show the planned rollout without ssh-ing.

If the user runs `/mesh-update` with no arguments, default to `roll`. Surface the script's output verbatim — the per-peer `before` / `after` versions and HTTP probe results are the verification the user is looking for.

The peer whose id matches `~/.katulong/node-id` is **always** excluded from the rollout — every host upgrades its peers, never itself. That asymmetry is intentional: a botched release leaves at least one healthy peer for recovery. Don't suggest a `--include-self` workaround; the user upgrades this host by running `mesh-update` from a different peer.

For full background on the self-heal rationale and the mesh.json schema, see the `katulong-mesh-update` skill at `.claude/skills/katulong-mesh-update/SKILL.md`.
