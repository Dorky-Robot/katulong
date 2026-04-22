# CLI Reference

Katulong provides a command-line interface for managing the server, tokens, credentials, and terminal sessions.

## Service Management

### start

Start the Katulong server.

```bash
katulong start              # Start the server
katulong start --foreground # Run in foreground (don't daemonize)
```

### stop

Stop the Katulong server.

```bash
katulong stop
```

### restart

Restart the Katulong server.

```bash
katulong restart            # Restart the server
katulong restart --rolling  # Rolling restart (zero-downtime)
```

### status

Check if Katulong is running.

```bash
katulong status
```

### logs

Stream server logs.

```bash
katulong logs
```

### browse

Open Katulong in your default browser.

```bash
katulong browse
```

### info

Show system information and configuration.

```bash
katulong info
```

### update

Update Katulong to the latest version.

```bash
katulong update             # Update and restart
katulong update --check     # Check if update is available
katulong update --no-restart # Update code but skip restart
```

## Pub/Sub Messaging

Topics-based messaging between sessions, scripts, and browser clients. Enables inter-session coordination and event-driven workflows.

### pub

Publish a message to a topic.

```bash
katulong pub deploy "v1.2.3 deployed"
echo '{"status":"pass"}' | katulong pub ci/result   # reads from stdin
```

### sub

Subscribe to a topic. Blocks and streams messages to stdout.

```bash
katulong sub deploy                    # print messages as they arrive
katulong sub deploy --once             # wait for one message, exit
katulong sub deploy --json             # JSON envelope output
```

### topics

List active topics and subscriber counts.

```bash
katulong topics
katulong topics --json
```

### notify

Send a native OS notification to all connected browser clients.

```bash
katulong notify "deploy complete"
katulong notify --title "Build" "Tests passed"
```

## API Key Management

API keys allow external access to katulong via `Authorization: Bearer <key>` header.

### apikey create

Create a new API key. Shows a QR code for easy copying.

```bash
katulong apikey create "CI pipeline"
katulong apikey create "monitoring" --json
```

The key is shown **once** — save it immediately.

Keys default to the `full` scope (same authority as a logged-in browser
session). To mint a narrow-scope key that can only do one thing, pass
`--scope`:

```bash
# Can only call /api/sessions/mint — used for fleet federation.
katulong apikey create "fleet-hub" --scope mint-session --json
```

Known scopes: `full` (default), `mint-session`. Unknown scopes are
rejected. Narrow-scope keys are default-denied on every route that
doesn't explicitly opt in — adding a new scope can't accidentally grant
access to an existing endpoint. See `docs/federation-setup.md` for the
mint-session workflow.

### apikey list

List all API keys. The `SCOPES` column shows what each key can do.

```bash
katulong apikey list
katulong apikey list --json
```

### apikey revoke

Revoke an API key by ID.

```bash
katulong apikey revoke abc123def456
```

## Fleet Federation

Helpers for operating katulong across multiple hosts. See
`docs/federation-setup.md` for the end-to-end setup procedure.

### fleet test-mint

Verify a `mint-session` API key works against a remote instance by
performing a mint + consume round-trip and reporting whether the
instance returned a session cookie.

```bash
katulong fleet test-mint https://katulong-og.example.com --key <key>
katulong fleet test-mint https://katulong-og.example.com --json

# Or pass the key via env so it doesn't land in shell history.
KATULONG_FLEET_KEY=<key> katulong fleet test-mint https://katulong-og.example.com
```

Exits 0 on success, 1 on failure. The `--json` output is structured for
scripting (e.g. looping over a fleet and collecting results).

## Token Management

Setup tokens allow pairing new devices via WebAuthn. Each token can be used once to register a passkey.

!!! note
    The server must be running for token commands to work.

### token create

Create a new setup token.

```bash
katulong token create "My Phone"
katulong token create "Work Laptop" --json
```

The token value is shown **once** — save it immediately.

### token list

List all setup tokens and their linked credentials.

```bash
katulong token list
katulong token list --json
```

### token revoke

Revoke a token by ID. If a credential was registered with the token, it is also revoked.

```bash
katulong token revoke abc123def456
katulong token revoke abc123def456 --json
```

## Credential Management

Credentials are WebAuthn passkeys registered to your Katulong instance.

### credential list

List all registered passkeys.

```bash
katulong credential list
katulong credential list --json
```

### credential revoke

Revoke a passkey by ID.

```bash
katulong credential revoke abc123def456
katulong credential revoke abc123def456 --json
```

!!! warning
    Revoking the last credential from a remote connection will lock you out. Use localhost to recover.

## Session Management

Sessions are terminal sessions managed via tmux.

### session list

List active terminal sessions.

```bash
katulong session list
katulong session list --json
```

### session create

Create a new named terminal session.

```bash
katulong session create dev
katulong session create "my-project" --json
```

### session kill

Kill a terminal session by name.

```bash
katulong session kill dev
katulong session kill dev --json
```

### session rename

Rename a terminal session.

```bash
katulong session rename dev production
katulong session rename old-name new-name --json
```

## Global Options

| Option | Description |
|---|---|
| `--help`, `-h` | Show help message |
| `--version`, `-v` | Show version number |
| `--json` | Output as JSON (token, credential, session commands) |
