# bridges/

A **bridge** is a small authenticated reverse proxy in front of a local-only HTTP service that katulong wants to talk to (e.g., Ollama). Each bridge runs as its own launchd job, listens on its own port, and validates a bearer token before forwarding requests verbatim to the wrapped service.

Bridges live here, alongside katulong itself, but they are **separate runtime processes** — a bridge crash does not take down the terminal. They share this codebase only because katulong is currently the only consumer; if a non-katulong consumer ever needs them, the directory becomes a candidate for extraction.

## Why bridges exist

Local services like Ollama, Redis, and Postgres listen on `127.0.0.1` with no auth and no TLS. Exposing them across machines requires putting auth and TLS in front. Coupling katulong to each service would violate katulong's vision as a general-purpose tiling platform, so each service gets a thin bridge that:

- has its own port
- validates a bearer token
- forwards everything else verbatim to the local service
- treats the wrapped service as opaque (new endpoints work automatically)

The runtime layer (HTTPS + Bearer auth) is forward-compatible with the planned [`katulong-app/1`](https://github.com/Dorky-Robot/sipag) protocol's runtime call shape. When that protocol's host implementation lands, bridges gain the four well-known endpoints (`manifest`, `install`, `intent-pull`, `health`) as a purely additive change. Nothing here gets thrown away.

## Layout

```
bridges/
  _lib/                  # shared code — every bridge uses this
    server.js            # HTTP proxy + bearer auth
    config-loader.js     # ~/.katulong/bridges/<name>/config.json
    launchd-template.js  # generates the LaunchAgent plist
    registry.js          # discovers bridges/<name>/manifest.js
  ollama/
    manifest.js          # exports { name, port, target, description }
    README.md            # service-specific notes
```

Adding a new bridge = creating a new directory with a `manifest.js`. That's it.

## Adding a bridge

1. Create `bridges/<name>/manifest.js`:

   ```js
   export default {
     name: "redis",
     port: 6380,
     target: "http://127.0.0.1:6379",
     description: "Authenticated reverse proxy to local Redis",
   };
   ```

   The directory name and the manifest's `name` field must match.

2. Optionally add `bridges/<name>/README.md` for service-specific operational notes.

3. Done. The CLI auto-discovers it — `katulong bridge list` will show it, and all `katulong bridge <name> <action>` commands work without further code changes.

## CLI

```sh
katulong bridge list                     # show available bridges
katulong bridge <name> new-token         # mint + save a 32-byte hex token
katulong bridge <name> show-token        # print the saved token
katulong bridge <name> install           # write + load the LaunchAgent plist
katulong bridge <name> uninstall         # unload + remove the plist
katulong bridge <name> status            # plist + token + listening probe
katulong bridge <name> start             # foreground (used internally by launchd)
```

## Storage

Per-bridge state lives under `~/.katulong/bridges/<name>/`:

- `config.json` (mode 0600) — `{ token, port?, bind?, target? }`. Operator overrides go here.
- `stdout.log`, `stderr.log` — launchd output

The shared CLI handles atomic writes and 0600 enforcement. Don't write these files directly.

## Wire format

Every bridge speaks the same shape:

```
<METHOD> /<any path>
Authorization: Bearer <token>
[body]
```

→ forwarded verbatim to `<target>/<any path>`. Streaming is preserved end-to-end.

The token is single-use-per-installation: paste-from-CLI today, ceremony-issued when `katulong-app/1` lands. The runtime path is identical either way.
