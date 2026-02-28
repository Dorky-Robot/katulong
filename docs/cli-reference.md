# CLI Reference

Katulong provides a command-line interface for managing the server, tokens, credentials, and terminal sessions.

## Service Management

### start

Start the daemon and/or server.

```bash
katulong start              # Start both daemon and server
katulong start server       # Start only the server
katulong start daemon       # Start only the daemon
katulong start --foreground # Run in foreground (don't daemonize)
```

### stop

Stop the daemon and/or server.

```bash
katulong stop               # Stop both
katulong stop server        # Stop only the server
katulong stop daemon        # Stop only the daemon
```

### restart

Restart the daemon and/or server.

```bash
katulong restart            # Restart both
katulong restart server     # Restart only the server
katulong restart --rolling  # Rolling restart (zero-downtime)
```

### status

Check if Katulong is running.

```bash
katulong status
```

### logs

Stream logs from the daemon, server, or both.

```bash
katulong logs               # Stream all logs
katulong logs daemon        # Stream daemon logs only
katulong logs server        # Stream server logs only
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
katulong update --no-restart # Update code but skip restart
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
    Revoking the last credential from a remote connection will lock you out. Use localhost or SSH to recover.

## Session Management

Sessions are PTY (terminal) sessions managed by the daemon.

### session list

List active PTY sessions.

```bash
katulong session list
katulong session list --json
```

### session create

Create a new named PTY session.

```bash
katulong session create dev
katulong session create "my-project" --json
```

### session kill

Kill a PTY session by name.

```bash
katulong session kill dev
katulong session kill dev --json
```

### session rename

Rename a PTY session.

```bash
katulong session rename dev production
katulong session rename old-name new-name --json
```

## SSH CLI

All token, credential, and session commands are also available over SSH for remote management:

```bash
ssh -p 2222 user@host "katulong token create 'My Phone'"
ssh -p 2222 user@host "katulong token list --json"
ssh -p 2222 user@host "katulong credential list"
ssh -p 2222 user@host "katulong session list"
ssh -p 2222 user@host "katulong status"
ssh -p 2222 user@host "katulong help"
```

The SSH CLI also supports a `status` command that shows credential, token, session, and daemon status.

## Global Options

| Option | Description |
|---|---|
| `--help`, `-h` | Show help message |
| `--version`, `-v` | Show version number |
| `--json` | Output as JSON (token, credential, session commands) |
