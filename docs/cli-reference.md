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

### open

Open Katulong in your default browser.

```bash
katulong open
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
katulung update --no-restart # Update code but skip restart
```

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
