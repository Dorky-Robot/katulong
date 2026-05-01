//! Terminal tile — first concrete consumer of the platform's
//! WS dispatch API, now backed by xterm.js.
//!
//! Mount-time wiring (in order — order matters for correctness):
//!   1. Subscribe to `ServerMessage::Output` and pipe its raw
//!      bytes to `term.write(...)`. Subscribed BEFORE we send
//!      `Attach` so any pre-handshake-replay output (the server
//!      ships fresh `Output` chunks immediately on attach for
//!      cold panes too) lands in the renderer.
//!   2. Subscribe to `ServerMessage::Attached` to capture the
//!      server's clamped dims and call `term.resize(cols, rows)`
//!      so xterm's grid matches what the PTY thinks.
//!   3. Mount xterm into the tile's `<div class="terminal-mount">`.
//!      `NodeRef::on_load` is the hook — `term.open(el)` on a
//!      not-yet-mounted node falls back to xterm's 80×24 default
//!      and the `FitAddon::fit()` call reports a 0×0 viewport.
//!   4. Run `FitAddon::fit()` to size the terminal grid to the
//!      visible mount node.
//!   5. Send `Attach { session, cols, rows, resume_from_seq:
//!      None }` with the fitted dims. Server may clamp; the
//!      `Attached` subscription above re-applies whatever the
//!      server returned.
//!   6. Hook `term.onData` → `WsClient::send(Input { data })`.
//!      xterm pre-encodes keystrokes (Enter → "\r", arrow keys
//!      → CSI sequences) so the bytes ride straight to the PTY.
//!   7. Install a `ResizeObserver` on the mount node, debounced
//!      80ms. On fire: `FitAddon::fit()` then send
//!      `Resize { cols, rows }`.
//!   8. `term.focus()` so keystrokes start landing immediately
//!      without a click.
//!
//! **Why this idiom is so verbose vs. the JS terminal-pool.**
//! The JS code can lean on xterm's life-as-a-DOM-element being
//! self-managing — `parentEl.appendChild(...)` and the GC takes
//! care of the rest. In WASM we cross the JS/WASM boundary, so
//! every JS-callable closure (`onData`, the ResizeObserver
//! callback) needs a `Closure` object whose lifetime we own. We
//! also can't rely on `Drop` for the `Terminal` JsValue —
//! xterm's `dispose()` releases the renderer's WebGL context
//! and helper-textarea, neither of which the WASM Drop chain
//! reaches. `on_cleanup` is the explicit hook.
//!
//! **Bytes, not strings.** `term.write(&[u8])` is the WHOLE
//! decode story. xterm has a stateful UTF-8 decoder + ANSI
//! parser inside; partial multi-byte sequences across chunks
//! buffer correctly. The 9s.3 placeholder used
//! `String::from_utf8_lossy` per chunk and lost split code
//! points outright (a 4-byte emoji split 2/2 became two
//! `U+FFFD`s, no recovery). Do NOT reintroduce a Rust-side
//! decoder here. The WASM ↔ JS marshalling for `&[u8]` is a
//! `Uint8Array` view over the WASM linear memory — zero-copy
//! for xterm's internal append.
//!
//! **Resize debounce — 80ms, matching the JS terminal-pool.**
//! ResizeObserver fires on every layout shift, including
//! 1-pixel viewport jitter (mobile focus-ring adjustments,
//! safe-area recalculations on iPad). The debounce coalesces
//! rapid bursts into one `Resize` wire message. The Node-side
//! history (commits d311168, 066dab2 from `diwa search xterm
//! resize SIGWINCH`) showed that SIGWINCH-mid-render garbles
//! TUI cursor-positioned output; here the debounce is the
//! client-side half of that defense. The server-side timing
//! gate (defer SIGWINCH while output is active) is a separate
//! property that lives in `crates/server/src/session/dims.rs`.
//!
//! **FIXME (multi-terminal):** Two terminal tiles with
//! `session_id: None` both resolve to `"main"` and both send
//! `ClientMessage::Attach { session: "main", ... }`. Per the
//! protocol's "one transport binds one session" rule
//! (`katulong_shared::wire`), the second `Attach` re-binds
//! the transport to the same session — both tiles subscribe
//! to the same Output stream and effectively mirror each
//! other. The bootstrap layout has only one terminal tile so
//! this isn't a current bug, but the persistence / multi-tile
//! slice MUST populate `session_id` with a stable per-tile id
//! before adding a second terminal tile to the layout.

use crate::ws::{SubscriberHandle, WsClient};
use crate::xterm::{FitAddon, Terminal};
use katulong_shared::wire::{ClientMessage, ServerMessage};
use leptos::html::Div;
use leptos::leptos_dom::helpers::TimeoutHandle;
use leptos::*;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::ResizeObserver;

/// Default session id used when the tile's descriptor doesn't
/// carry one. The server creates the tmux session lazily on
/// `Attach`, so a fresh page load with no persisted layout
/// always lands on the same well-known session.
const DEFAULT_SESSION_ID: &str = "main";

/// ResizeObserver debounce window — coalesces rapid layout
/// jitter (mobile focus-ring, safe-area, browser zoom) into
/// one `Resize` wire message. Matches the Node frontend's
/// `terminal-pool.js` choice; revisit if TUI rendering shows
/// SIGWINCH artifacts under the multi-device matrix.
const RESIZE_DEBOUNCE: Duration = Duration::from_millis(80);

/// Aggregate of the JS-side allocations the tile owns. Stored
/// in a single `store_value` so a single drop site
/// (`on_cleanup`) tears the whole graph down. Field order is
/// intentional: drop hits them top-down, and the disposables
/// must drop before the closures they reference. (Rust's drop
/// order is field-declaration order for structs — we rely on
/// it here so the `on_data` and `ResizeObserver` listeners
/// detach BEFORE their backing closures' `drop_box` runs.)
struct TerminalGuard {
    /// xterm `IDisposable` returned by `Terminal::on_data`.
    /// Holding the JsValue keeps the listener attached; drop
    /// detaches it on JS-side ref-count when xterm's listener
    /// list is GC'd at `Terminal::dispose` time. We don't
    /// invoke `disposable.dispose()` ourselves — the terminal
    /// dispose below cascades.
    _on_data_disposable: JsValue,

    /// The xterm input-callback closure. Must outlive the
    /// disposable above; dropping it before xterm detaches the
    /// listener leaves xterm holding a JS reference to a freed
    /// WASM closure → use-after-free on the next keystroke.
    _on_data_closure: Closure<dyn FnMut(String)>,

    /// ResizeObserver instance. `disconnect()`-ed in cleanup so
    /// it stops firing into the (about-to-be-freed) callback
    /// closure.
    resize_observer: ResizeObserver,

    /// ResizeObserver callback closure. See ordering note on
    /// `_on_data_closure` — same constraint applies.
    _resize_observer_closure: Closure<dyn FnMut(JsValue, JsValue)>,

    /// xterm.js terminal handle. `dispose()` called in cleanup;
    /// a future fitness slice may keep the handle alive across
    /// tile re-mounts (cache one terminal per session) but
    /// that's a layout-persistence-tier concern.
    terminal: Terminal,

    /// Subscriber handles for `Output` and `Attached`. Drop
    /// removes them from the WS dispatch list (RAII via the
    /// `Drop` impl on `SubscriberHandle`). Without these, a
    /// disposed tile still receives byte streams and tries to
    /// write into a disposed xterm.
    _subscribers: [SubscriberHandle; 2],
}

#[component]
pub fn TerminalTile(#[prop(into)] session_id: Option<String>) -> impl IntoView {
    let session_id = session_id.unwrap_or_else(|| DEFAULT_SESSION_ID.to_string());
    let ws = expect_context::<WsClient>();
    let mount_ref = create_node_ref::<Div>();

    // Defer all JS-touching work until the mount node is in the
    // DOM. `on_load` fires exactly once when `mount_ref`
    // resolves; the body below runs in a real DOM environment
    // where `term.open(el)` and `FitAddon::fit()` produce
    // correct dimensions. Running this in the component body
    // (or in `spawn_local` at body level) would race the
    // initial render — the div doesn't exist yet.
    let session_id_for_attach = session_id.clone();
    mount_ref.on_load({
        let ws = ws.clone();
        move |el| {
            let session_id = session_id_for_attach;
            let term = Terminal::new();
            let fit = FitAddon::new();
            term.load_fit_addon(&fit);
            term.open(&el);
            // FitAddon needs the mount node to be visible AND
            // have measured fonts before it can compute dims.
            // `term.open()` triggers a synchronous layout that
            // makes both true.
            fit.fit();

            let cols = term.cols() as u16;
            let rows = term.rows() as u16;

            // Subscribe BEFORE sending Attach. The server may
            // ship `Attached` and the first `Output` chunks
            // back-to-back; if we subscribe afterwards the
            // first PTY byte race-loses against the
            // subscription registration.
            let term_for_output = term.clone();
            let output_sub = ws.subscribe(move |msg| {
                if let ServerMessage::Output { data, .. } = msg {
                    term_for_output.write(data);
                }
            });

            // The server's `Attached` carries the CLAMPED
            // dims — what the PTY actually got, not what we
            // requested. Re-apply them so xterm's grid matches
            // tmux's pane dimensions. This is not redundant
            // with our fit-then-attach flow: the server caps
            // cols/rows defensively (see `session::dims`), and
            // a phone can request 200 cols and get 80 back.
            let term_for_attached = term.clone();
            let attached_sub = ws.subscribe(move |msg| {
                if let ServerMessage::Attached { cols, rows, .. } = msg {
                    term_for_attached.resize(*cols as u32, *rows as u32);
                }
            });

            ws.send(ClientMessage::Attach {
                session: session_id,
                cols,
                rows,
                resume_from_seq: None,
            });

            // Keystroke / paste flow. xterm's `onData` callback
            // hands us a UTF-8 string of pre-encoded input
            // (Enter → "\r", Up arrow → "\x1b[A", pasted text →
            // verbatim). We marshal it back to bytes and ride
            // the `Input` wire variant. Doing the encoding
            // inside xterm rather than reimplementing a key
            // → bytes table in WASM is the entire reason we
            // vendor xterm in the first place — keystroke
            // mapping is a tar pit (see `diwa search xterm
            // keystroke` for the JS-side history).
            let ws_for_input = ws.clone();
            let on_data = Closure::<dyn FnMut(String)>::new(move |bytes: String| {
                ws_for_input.send(ClientMessage::Input {
                    data: bytes.into_bytes(),
                });
            });
            let disposable = term.on_data(&on_data);

            // ResizeObserver wiring. We share one `Rc<RefCell>`
            // for the debounce timer handle so the observer
            // callback can clear the previous timer and arm a
            // new one. `Rc<RefCell>` not `Cell` because
            // `TimeoutHandle` is not `Copy`.
            let pending_timer: Rc<RefCell<Option<TimeoutHandle>>> =
                Rc::new(RefCell::new(None));

            let observer_cb = Closure::<dyn FnMut(JsValue, JsValue)>::new({
                let ws = ws.clone();
                let term = term.clone();
                let fit = fit.clone();
                let pending_timer = pending_timer.clone();
                move |_entries: JsValue, _observer: JsValue| {
                    if let Some(handle) = pending_timer.borrow_mut().take() {
                        handle.clear();
                    }
                    // Clone the Rc one extra time so the
                    // timer closure owns its own reference
                    // and we can still write back the new
                    // handle below. `pending_timer` is the
                    // observer-closure-owned Rc; `timer_slot`
                    // is the timer-closure-owned Rc.
                    let timer_slot = pending_timer.clone();
                    let ws = ws.clone();
                    let term = term.clone();
                    let fit = fit.clone();
                    let new_handle = set_timeout_with_handle(
                        move || {
                            *timer_slot.borrow_mut() = None;
                            // Container size has settled —
                            // recompute grid + tell the server.
                            // `fit()` is a no-op if the dims
                            // are unchanged (xterm's internal
                            // `_renderService` early-outs).
                            fit.fit();
                            let cols = term.cols() as u16;
                            let rows = term.rows() as u16;
                            ws.send(ClientMessage::Resize { cols, rows });
                        },
                        RESIZE_DEBOUNCE,
                    )
                    .ok();
                    *pending_timer.borrow_mut() = new_handle;
                }
            });

            let observer = ResizeObserver::new(observer_cb.as_ref().unchecked_ref())
                .expect("ResizeObserver constructor should not fail in supported browsers");
            observer.observe(&el);

            term.focus();

            let guard = TerminalGuard {
                _on_data_disposable: disposable,
                _on_data_closure: on_data,
                resize_observer: observer,
                _resize_observer_closure: observer_cb,
                terminal: term,
                _subscribers: [output_sub, attached_sub],
            };
            let stored_guard = store_value(Some(guard));

            on_cleanup(move || {
                if let Some(guard) = stored_guard.try_update_value(|g| g.take()).flatten() {
                    // Stop the observer before the closure
                    // it references is dropped. Field-order
                    // drop on TerminalGuard takes care of
                    // closures vs. terminal but the observer
                    // outlives the closure inside the JS
                    // engine until we explicitly disconnect.
                    guard.resize_observer.disconnect();
                    guard.terminal.dispose();
                    // `guard` drops here; the rest of the JS
                    // resources (closures, disposable, ws
                    // subscribers) cascade-drop.
                }
            });
        }
    });

    view! {
        // `data-session` exposes the bound session id for
        // operator devtools and as a selector hook for any
        // future per-tile e2e test. No CSS rule depends on it.
        <section
            id="kat-terminal-tile"
            data-tile-kind="terminal"
            data-session=session_id.clone()
        >
            // Mount node for xterm. Empty markup — xterm fills
            // it with its own DOM (`.xterm`, `.xterm-screen`,
            // `.xterm-rows`) on `term.open()`. CSS gives this
            // element a definite height/width so the FitAddon
            // can measure it.
            //
            // **XSS-safety note.** No `inner_html` here. xterm
            // builds its DOM via `createElement` /
            // `appendChild` / `textContent` calls — server-
            // controlled PTY bytes can't inject markup. Do NOT
            // add a Leptos `inner_html=...` binding to this
            // div; that would turn the PTY-output path into a
            // stored-XSS surface.
            <div class="terminal-mount" node_ref=mount_ref></div>
        </section>
    }
}
