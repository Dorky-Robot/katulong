# Federated Chat & Tile Sharing — Design Notes

**Status:** Parked. Captured from a brainstorming session to preserve the decision shape for when we pick this back up.

## Goal

Let katulong users talk to each other, and pair-program by sharing individual tiles — without breaking katulong's "full reign on your own machine" security model.

## Alternatives considered and rejected

### A native IRC tile
Wrong shape for the goal. IRC is a public-network client; what we actually want is private chat between katulong users we trust. If someone wants to sit on `#libera`, running `weechat` in a terminal tile already works today with zero new code.

### Guest role / multi-tenancy inside one instance
A second passkey tier with no terminal/file access, chat-only. Easy v1 — but every future tile and route then carries a permanent "what if a guest does this" security tax. One missed gate leaks shell access to the host. The tax never goes away.

## Direction: federation over WebRTC

Each person runs their own katulong. Instances establish a peer relationship over WebRTC; everything flows through that link. No multi-tenancy inside any single box — everyone stays sovereign on their own machine.

### Chat
Plain WebRTC data channel between peers. No "chat server," no shared host. Message history lives on each peer's own instance.

### Tile sharing (pair programming)
Rides on the same transport as a separate channel. The **host's** katulong renders the tile locally as usual; the **peer's** katulong gets a `remote-tile` renderer that proxies input events and mirrors output frames over the data channel. The peer never authenticates into the host's katulong — the WebRTC peer link *is* the authorization, revocable per-tile at any moment.

This sidesteps the multi-tenancy trap: there is no guest session on the host to harden.

### Signaling
A managed-relay service (see [`docs/service-plan.md`](service-plan.md)) could do double duty as the signaling layer for establishing WebRTC peer links.

## Security model — be honest about this

Sharing a terminal tile ≈ granting a shell in that pane's context. The peer can `cat ~/.ssh/id_rsa`, run `rm -rf`, read anything the host user can read in that cwd. This is **pair-programming trust, not stranger trust.**

The UX must make that loud:
- Visible peer indicator on any shared tile (who is watching / driving)
- One-click revoke, always reachable
- Per-tile-type policies worth considering — document tile is safe-ish, terminal tile is a loaded gun, file browser is somewhere in between

## Open questions (for when we unpark)

- Peer discovery: directory on the relay, invite links, something else?
- Offline message delivery for chat — store-and-forward on the relay, or strict online-only?
- Input arbitration when multiple peers share the same terminal tile (driver vs. observer)
- How shared-tile state survives host-side reloads or tab closes
- Do we let the host share a *cluster* (group of tiles) as a single unit, or only individual tiles?
