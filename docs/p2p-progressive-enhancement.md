# P2P Progressive Enhancement

Katulong uses WebRTC DataChannel as a progressive enhancement over the WebSocket baseline. When the client is on the same LAN as the host, terminal I/O upgrades to a direct peer-to-peer connection for near-zero latency.

## How It Works

```
Internet access (baseline):
  Browser ──WebSocket──→ Tunnel ──→ Server ──→ tmux

LAN enhancement (automatic):
  Browser ──WebSocket──→ Tunnel ──→ Server     (signaling + fallback)
  Browser ══DataChannel═══════════→ Server     (terminal I/O, direct LAN)
```

### Connection Flow

1. Client connects via WebSocket (always — this is the baseline)
2. Client attaches to a terminal session (`attach` message)
3. Server responds with `attached` — client creates a WebRTC peer (initiator)
4. ICE candidates are exchanged as `p2p-signal` messages over the existing WebSocket
5. DataChannel opens on the LAN — terminal I/O flows directly
6. WebSocket remains open for signaling and as a fallback

### Fallback

If the DataChannel closes or fails to connect (e.g., client is not on the LAN), terminal I/O continues over WebSocket with no interruption. The client retries P2P connection every 3 seconds.

## Design Decisions

**No STUN/TURN servers.** ICE is configured with an empty server list. This means P2P only works on the LAN, which is intentional — the goal is low-latency enhancement when you're physically near the host, not NAT traversal.

**Multi-NIC filtering.** The server filters ICE candidates to only include addresses on the default network interface. This prevents ICE failures on hosts with multiple network interfaces.

**WebSocket always open.** The WebSocket connection is never replaced — it handles signaling, fallback data, and non-terminal messages (session management, auth events, server drain). Only terminal I/O moves to the DataChannel.

**Initiator/responder roles.** The client is always the initiator. The server is always the responder. This simplifies the handshake.

## Connection Indicator

The UI shows a connection status dot:

- **Green** (direct) — DataChannel connected, lowest latency
- **Orange** (relay) — WebSocket only, typically via tunnel
- **Grey** (disconnected) — no connection

## Implementation

| Component | File | Role |
|-----------|------|------|
| Client P2P manager | `public/lib/p2p-manager.js` | Creates initiator peer, manages lifecycle and retry |
| Server P2P handler | `lib/p2p.js` | Creates responder peer via node-datachannel polyfill |
| Transport bridge | `lib/transport-bridge.js` | Routes I/O between WebSocket, DataChannel, and session |
| WS manager | `lib/ws-manager.js` | Handles `p2p-signal` messages, wires peers to bridge |

## Dependencies

- **Client**: Browser `RTCPeerConnection` API (no library needed)
- **Server**: `node-datachannel` polyfill (optional — P2P is disabled if not installed)
