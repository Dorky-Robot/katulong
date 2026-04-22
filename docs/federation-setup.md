# Fleet federation setup

This doc walks an operator — or an agent running `claude` over SSH on each
instance — through enabling the primitives that let a fleet hub mint real
first-party sessions on each of your katulong instances.

It only covers the per-instance setup. Wiring up the actual hub UI (the
thing that iframes the three consume URLs and merges the tiles) is a
separate project. Until then, `katulong fleet test-mint` is how you verify
the primitives work.

## What you're setting up

Each katulong instance gets an API key with a narrow `mint-session` scope.
A hub server, calling in with that key, can ask the instance to issue a
single-use consume URL. A browser that hits that URL lands a normal
`katulong_session` cookie on the instance — same cookie, same session
lifetime, same passkey binding as if the user had logged in directly.

Key properties:

- The key is Bearer-only. It cannot do anything except mint sessions. It
  is default-denied on every other authenticated route.
- The consume URL is single-use and TTL-bounded (30s by default).
- Cookies remain first-party to each instance's origin. Passkeys never
  leave the instance they were registered on.
- Revocation is instant: `katulong apikey revoke <id>` on the instance
  terminates further minting immediately. Existing minted sessions stay
  valid for their normal 30-day lifetime unless you also remove the
  bound credential.

## Prerequisites

- katulong **≥ 0.59.0** on every instance. Confirm with:

  ```sh
  katulong --version
  ```

  If the instance is older than 0.59.0, upgrade it first. The
  `mint-session` scope and `/auth/consume` route do not exist in older
  releases — the mint call will come back 400.

- A registered passkey on the instance. Mint refuses on instances with
  no credentials (409 "Instance has no registered credentials"); there's
  no credential for the minted session to bind to.

## Procedure (run on each instance)

Run these steps on each instance — locally, or by SSHing in and running
`claude` there, or by handing the instance to an agent. Each step is
idempotent and safe to retry.

### 1. Verify version and that a passkey exists

```sh
katulong --version                 # expect: v0.59.0 or newer
katulong credential list           # expect: at least one row
```

If `credential list` returns nothing, register a passkey by logging in
through the browser once before continuing.

### 2. Generate a `mint-session` API key

```sh
katulong apikey create "fleet-hub" --scope mint-session --json
```

The JSON output contains:

```json
{
  "id": "...",
  "name": "fleet-hub",
  "key": "<32-byte hex>",
  "prefix": "...",
  "scopes": ["mint-session"]
}
```

**The `key` field is shown exactly once.** Capture it immediately. The
hostname of this instance plus this key is what the hub configuration
needs.

An agent collecting keys from multiple instances can parse the `--json`
output directly:

```sh
HOST=$(hostname)
PAYLOAD=$(katulong apikey create "fleet-hub-$(date +%s)" --scope mint-session --json)
KEY=$(echo "$PAYLOAD" | jq -r .key)
KEY_ID=$(echo "$PAYLOAD" | jq -r .id)
printf '%s\t%s\t%s\n' "$HOST" "$KEY_ID" "$KEY"
```

Pipe that line out to a central location (e.g. stdout of the SSH
command) and the hub operator can assemble the config without the key
ever hitting disk on the instance side beyond the auth state file.

### 3. Verify the key works

Still on the instance, with `$KEY` from step 2:

```sh
katulong fleet test-mint "https://$(hostname)" --key "$KEY" --json
```

Or from the hub / your laptop, against the instance's public URL:

```sh
katulong fleet test-mint https://katulong-og.example.com --key "$KEY"
```

Expected result:

```
OK  https://katulong-og.example.com — mint + consume succeeded (redirect to /)
```

If it fails:

- `mint=401` — the key didn't resolve. Either it's wrong, or the instance
  is older than 0.59.0.
- `mint=403` — the key doesn't carry `mint-session`. Re-check step 2
  (the `scopes` field in the JSON should include `mint-session`).
- `mint=409` — the instance has no registered credential. Register a
  passkey and retry.
- `consume=404` with `mint=201` — very unlikely; indicates the consume
  token was swept or already used. Re-run; it's transient.
- `consume=400 "return must be same-origin"` — your `--host` hint
  doesn't match the instance's canonical origin. Hit the instance by
  its public URL, not an IP, and retry.

### 4. Record and report

Hand the hub operator (or your notes):

- Instance public URL (e.g. `https://katulong-og.example.com`)
- Key ID from step 2 (for rotation / auditing — safe to share)
- Key material from step 2 (secret — transport via secure channel)

The hub writes these to its own configuration. The instance is done.

## Revocation

To revoke a fleet key on an instance:

```sh
katulong apikey list
katulong apikey revoke <id>
```

Sessions already minted via that key continue to work (they are normal
first-party cookie sessions bound to the passkey credential). To sever
those as well, revoke the passkey credential via the web UI or
`katulong credential revoke`.

## Rotation

Scheduled rotation — create a new key, update the hub config, revoke
the old key:

```sh
# on the instance
katulong apikey create "fleet-hub-$(date +%Y%m)" --scope mint-session --json

# (hub operator updates config with the new key, then:)
katulong apikey revoke <old-id>
```

There is no grace window other than the 30-second mint TTL. Plan the
config update to happen between the new key's creation and the old
key's revocation.

## Security notes

- `/api/sessions/mint` is Bearer-only — cookie/localhost auth is
  explicitly rejected. The intent is that this endpoint is only ever
  hit by a hub server holding the key, never by a browser.
- The consume URL's `return` parameter is validated to be same-origin
  at both mint time and consume time. A bad hub cannot mint a token
  that redirects off-instance on use.
- Minted sessions are bound to the first registered credential on the
  instance. If that credential is later revoked, the session is
  invalidated along with all other sessions for that credential.
- The mint-session key has no permission to list, modify, or revoke
  API keys, passkeys, setup tokens, or any other state. It can only
  mint sessions.
