# Salita Improvements to Port to Katulong

This document outlines architectural and UX improvements made in Salita that should be ported back to Katulong.

## 1. Dual-Server Architecture for HTTP/HTTPS

**Current (Katulong):** Single server with conditional redirect logic
```javascript
// Complex conditional logic to allow /connect paths on HTTP
if (!req.socket.encrypted && !isLocalRequest(req) && !pathname.startsWith("/connect")) {
  // Redirect to HTTPS if authenticated...
}
```

**Improvement (Salita):** Separate HTTP and HTTPS servers
- **HTTPS Server (main port):** All app routes
- **HTTP Server (onboarding port):** ONLY trust certificate routes

**Benefits:**
- Cleaner separation of concerns
- More secure by default (HTTP server can't accidentally serve app routes)
- No conditional logic needed
- Easier to reason about

**Implementation:**
```rust
// HTTPS server with all routes
let https_server = bind_rustls(https_addr, rustls_config)
    .serve(app.into_make_service());

// HTTP server with ONLY trust routes
let http_app = routes::trust::router()
    .with_state(state);
let http_server = axum::serve(http_listener, http_app);

// Run both concurrently
tokio::select! {
    result = https_server => { result?; }
    result = http_server => { result?; }
}
```

**Todo for Katulong:**
- [ ] Split into two Express apps or Node HTTP servers
- [ ] HTTP server only mounts `/connect/trust` routes
- [ ] HTTPS server mounts all app routes
- [ ] Remove conditional redirect logic

---

## 2. Pairing Completion Detection

**Current (Katulong):** WebSocket-based notification
```javascript
// Server sends WebSocket message on pairing
for (const client of wss.clients) {
  if (client.readyState === 1) {
    client.send(JSON.stringify({ type: "pair-complete", code }));
  }
}
```

**Improvement (Salita):** Polling-based with completion tracking
```rust
// Mark pairing as completed
pairings.mark_completed(&code);

// Desktop polls endpoint
GET /auth/pair/check?code=xxx
// Returns: { completed: true/false }
```

**Benefits:**
- Simpler implementation (no WebSocket infrastructure needed)
- Works behind restrictive proxies/firewalls
- Easier to debug
- Still fast (500ms polling is imperceptible)

**Implementation:**
```rust
// Add completion flag to challenge
pub struct PairingChallenge {
    pub pin: String,
    pub expires_at: Instant,
    pub completed: bool,  // NEW
}

// Mark as completed when verified
pairings.mark_completed(&req.code);

// Polling endpoint
async fn pair_check(code: String) -> Json<{ completed: bool }> {
    let completed = pairings.is_completed(&code);
    Json { completed }
}
```

**Frontend:**
```javascript
// Poll every 500ms
setInterval(async () => {
  const res = await fetch(`/auth/pair/check?code=${code}`);
  const { completed } = await res.json();
  if (completed) {
    goToStep(3); // Auto-advance
  }
}, 500);
```

**Todo for Katulong:**
- [ ] Add `completed` flag to pairing challenges
- [ ] Add `/auth/pair/check` endpoint
- [ ] Update desktop polling to use endpoint instead of WebSocket
- [ ] Keep WebSocket as optional enhancement (instant vs 500ms delay)

---

## 3. LAN IP-Based Pairing URLs

**Current (Katulong):** Uses configured site_url or hostname
```javascript
const url = lanIP ? `https://${lanIP}:${HTTPS_PORT}/pair?code=${code}` : null;
```

**Improvement (Salita):** Always uses LAN IP for pairing
```rust
// Always get LAN IP for pairing URLs
let lan_ip = local_ip_address::local_ip()
    .map(|ip| ip.to_string())
    .unwrap_or_else(|_| "127.0.0.1".to_string());
let pair_url = format!("https://{}:{}/pair?code={}", lan_ip, port, code);
```

**Benefits:**
- Works from any device on LAN (not just those that can resolve .local)
- More reliable than mDNS/Bonjour
- Doesn't require hostname configuration

**Todo for Katulong:**
- [x] Already implemented! No changes needed.

---

## 4. Cleaner Pairing Store Architecture

**Current (Katulong):** Map with expiry tuples
```javascript
pairingChallenges.set(code, { pin, expiresAt });
```

**Improvement (Salita):** Dedicated module with auto-cleanup
```rust
pub struct PairingStore {
    challenges: HashMap<String, PairingChallenge>,
}

impl PairingStore {
    pub fn insert(&mut self, code: String, pin: String) {
        self.clear_stale(); // Auto-cleanup on insert
        self.challenges.insert(code, PairingChallenge {
            pin,
            expires_at: Instant::now() + Duration::from_secs(30),
            completed: false,
        });
    }

    fn clear_stale(&mut self) {
        let now = Instant::now();
        self.challenges.retain(|_, c| now < c.expires_at);
    }
}
```

**Benefits:**
- Automatic cleanup of expired challenges
- Encapsulated logic
- Type-safe
- Easier to test

**Todo for Katulong:**
- [ ] Create `PairingStore` class
- [ ] Move pairing logic into class methods
- [ ] Add auto-cleanup on insert/access
- [ ] Add tests for expiry behavior

---

## 5. QRCode Library Loading

**Current (Katulong):** Script tag in HTML
```html
<script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
```

**Improvement (Salita):** Global load in base template
```html
<!-- base.html -->
<script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
```

**Benefits:**
- Available everywhere without per-page imports
- Single load for all pages
- Simpler usage in modals/components

**Todo for Katulong:**
- [x] Already implemented! No changes needed.

---

## 6. Step Indicators UX

**Current (Katulong):** Simple dots
```html
<div class="step-indicator">
  <span class="step-dot active"></span>
  <span class="step-dot"></span>
  <span class="step-dot"></span>
</div>
```

**Improvement (Salita):** Numbered steps with states
```html
<div class="connect__steps">
  <span class="connect__step active">1</span>
  <span class="connect__step">2</span>
  <span class="connect__step">3</span>
</div>
```

```css
.connect__step.active { background: #1c1917; color: #fff; }
.connect__step.done { background: #16a34a; color: #fff; }
```

**Benefits:**
- Clearer progression (shows which step you're on)
- Visual feedback (done steps turn green)
- More accessible (numbered indicators)

**Todo for Katulong:**
- [ ] Add numbers to step indicators
- [ ] Add "done" state styling
- [ ] Update JavaScript to mark completed steps

---

## 7. Config-Driven Instance Naming

**Current (Katulong):** Hardcoded "Katulong"
```javascript
const INSTANCE_NAME = "Katulong";
```

**Improvement (Salita):** Configurable instance name
```toml
# config.toml
instance_name = "My Server"
```

**Benefits:**
- Users can customize their instance name
- Better for multiple instances
- Personalization

**Todo for Katulong:**
- [ ] Add `instance_name` to config
- [ ] Use throughout UI (titles, certificates, etc.)
- [ ] Default to "Katulong" if not set

---

## Summary

**High Priority:**
1. ✅ Dual-server architecture (HTTP/HTTPS separation)
2. ✅ Polling-based pairing detection
3. ✅ Dedicated PairingStore module

**Medium Priority:**
4. ✅ Numbered step indicators
5. ✅ Config-driven instance naming

**Low Priority:**
6. ✅ Minor refactoring for consistency

**Timeline:**
- Week 1: Dual-server architecture + PairingStore
- Week 2: Polling-based detection
- Week 3: UX improvements (step indicators, instance naming)

---

## Testing Checklist

After implementing each improvement:

- [ ] HTTP server only serves `/connect/trust` routes
- [ ] HTTPS server serves all app routes
- [ ] Pairing auto-advances within 1 second
- [ ] Expired pairing codes are cleaned up
- [ ] Step indicators show clear progression
- [ ] Instance name appears in certificates and UI
- [ ] No regressions in existing functionality
