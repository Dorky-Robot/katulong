# bridges/ollama

Authenticated reverse proxy in front of a local Ollama instance.

## What it does

Listens on `127.0.0.1:11435` (default), checks `Authorization: Bearer <token>` against the saved token, forwards everything else verbatim to `http://127.0.0.1:11434`. Streaming responses pipe through unchanged so chat completions feel native.

## Quick start (host running Ollama)

```sh
# Mint a token + save it
katulong bridge ollama new-token

# Install + start under launchd (logs to ~/.katulong/bridges/ollama/)
katulong bridge ollama install

# Sanity check
katulong bridge ollama status

# Print the token to copy into another katulong's settings
katulong bridge ollama show-token
```

To expose the bridge across the network, run it behind a tunnel that does TLS (Cloudflare Tunnel, ngrok, etc.). The bridge does not terminate TLS.

## Quick start (consumer — another katulong using a remote bridge)

In Settings → General → External LLM endpoint:

- URL: `https://ollama-<host>.example.com` (your tunnel's hostname)
- Token: paste output of `katulong bridge ollama show-token` from the bridge host

Save → Test → done. The summarizer + narrator will route through the bridge on their next cycle.

## Operational notes

- The bridge's PATH is fixed to a deterministic set, never inheriting the calling shell's PATH (lesson from katulong's own `service install`).
- A bridge crash doesn't take down katulong — they're independent launchd jobs.
- The token is stored in `~/.katulong/bridges/ollama/config.json` (mode 0600).
- Rotate by `katulong bridge ollama new-token` (overwrites the saved token); update the consumer's settings with the new value.

## Caveats

- Ollama itself is unauthenticated. Anyone who reaches the bridge with the bearer token has full access to whatever Ollama serves on that host. Do not share the token.
- The bridge does not enforce a per-token rate limit. If you front it with a public hostname, put a rate limiter at the edge.

## What changes when `katulong-app/1` lands

The runtime path stays identical. The bridge gains the four well-known endpoints (`manifest`, `install`, `intent-pull`, `health`) as a purely additive change, and the paste-from-CLI token gets replaced by a ceremony-issued credential at the same wire shape. Existing installs will run side-by-side with new ones during the deprecation window.
