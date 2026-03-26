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

Starts the server on port 3001 (HTTP).

### 2. Open in Browser

```bash
katulong browse
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

### LAN Access

```
https://katulong.local:3001
```

Auto-advertised via mDNS on local network.

**HTTPS is required for LAN access.** WebAuthn passkeys only work over secure contexts (HTTPS or localhost). When accessing from another device on your LAN:

1. Use HTTPS (katulong serves a self-signed certificate)
2. Accept the self-signed certificate in your browser
3. Register a passkey on the new device

For internet access via tunnel, HTTPS is handled by the tunnel provider (ngrok, Cloudflare Tunnel).

### Setup Token for Remote Devices

When pairing a new device over the internet (via tunnel), you need a setup token:

```bash
katulong token create "My Phone"  # Creates a token
```

The token is used during WebAuthn registration to authorize the new device. Tokens expire after 7 days.
