# Getting Started

Simple installation with Homebrew or npm.

## Installation

=== "Homebrew (macOS)"

    ```bash
    # Add the tap
    brew tap dorky-robot/katulong

    # Install
    brew install katulong

    # Start
    katulong start

    # Or use brew services for auto-start
    brew services start katulong
    ```

    Installs to `~/.katulong` with system service integration.

=== "Manual"

    ```bash
    git clone https://github.com/Dorky-Robot/katulong.git
    cd katulong
    npm install
    npm link  # Makes 'katulong' command available
    ```

    For development or if Homebrew isn't available.

## Quick Start with CLI

### 1. Start Katulong

```bash
katulong start
```

Starts daemon and server on ports 3001 (HTTP) and 3002 (HTTPS).

### 2. Open in Browser

```bash
katulong open
```

Or visit **http://localhost:3001** manually.
Follow the WebAuthn registration flow to create your first passkey.

### 3. Manage Services

```bash
katulong status  # Check if running
katulong logs    # View output
katulong stop    # Stop services
```

Run `katulong --help` to see all available commands.

### 4. Manage Tokens and Sessions

```bash
katulong token create "My Phone"  # Create a setup token for pairing
katulong token list               # List tokens
katulong credential list          # List registered passkeys
katulong session list             # List active terminal sessions
```

See the [CLI Reference](cli-reference.md) for all available commands.

### 5. Pair Additional Devices

From Settings > "Pair New Device", scan the QR code on your mobile device
and enter the PIN to pair securely.

## Advanced Options

### Remote Access via Tunnel

```bash
ngrok http 3002
```

Access your terminal from anywhere using ngrok or Cloudflare Tunnel.

### SSH Access

```bash
ssh -p 2222 session-name@localhost
```

Native SSH access using auto-generated password (shown in logs).

### LAN Access

```
http://katulong.local:3001
```

Auto-advertised via mDNS on local network.
