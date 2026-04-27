// Leptos shell.
//
// Slice 9q: layout primitives (header + main).
// Slice 9r.1: <Login/> form shell with URL-based mode switch.
// Slice 9r.2: sign-in WebAuthn ceremony wired to the API.
//
// FP-leaning per memory `feedback_rewrite_fp_direction`: the
// shell is built from small pure components composed into a
// tree. Auth + connection state live in signals provided at
// the App root; the ceremony itself is a pure async function
// (`signin()`) that returns a `Result` — the component just
// dispatches it via `create_action` and reacts to the
// resolved value. No scattered globals, no callbacks-on-
// callbacks.

use leptos::*;
use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(|| view! { <App/> });
}

/// Reactive connection-state signal exposed to descendants
/// via context. `false` until a future slice wires the WS
/// attach handshake to flip it.
#[derive(Copy, Clone)]
struct ConnectionStatus(ReadSignal<bool>);

/// Reactive auth-state signal exposed to descendants via
/// context. Slice 9r.2 flips it on successful sign-in so
/// `<Main/>` can swap from `<Login/>` to a stub. Future
/// slices read the same signal to gate WS attach + tile
/// rendering. The setter half travels alongside the reader
/// because the sign-in ceremony — owned by `<Login/>` —
/// needs to publish success up to its sibling-switching
/// parent. Logout (a future slice) will use the same setter
/// in reverse.
#[derive(Copy, Clone)]
struct AuthState {
    signed_in: ReadSignal<bool>,
    set_signed_in: WriteSignal<bool>,
}

#[component]
fn App() -> impl IntoView {
    // Connection signal lives at the root so any descendant
    // can read it without prop-drilling. The setter half is
    // discarded for now — only future slices that own the WS
    // lifecycle will need it, and they'll re-create the
    // signal at a more appropriate scope (e.g., inside the
    // WS-driving component) rather than mutating shared state
    // from anywhere.
    let (connected, _set_connected) = create_signal(false);
    provide_context(ConnectionStatus(connected));

    // Auth signal also lives at the root because two siblings
    // need it: `<Login/>` writes (on ceremony success) and
    // `<Main/>` reads (to swap children). A future
    // `<Header/>` logout button will also write through this
    // setter. Initial value `false` because we haven't yet
    // checked `/api/auth/status`; slice 9r.3 lands the
    // session-restore-on-load probe.
    let (signed_in, set_signed_in) = create_signal(false);
    provide_context(AuthState {
        signed_in,
        set_signed_in,
    });

    view! {
        <div id="kat-shell">
            <Header/>
            <Main/>
        </div>
    }
}

#[component]
fn Header() -> impl IntoView {
    let ConnectionStatus(connected) = expect_context();
    // The status attribute is what the CSS dot color binds
    // to. Computing it as a derived signal means the DOM
    // attribute mutates only when the underlying boolean
    // flips — no manual class-toggle dance.
    let status_attr = move || {
        if connected.get() {
            "connected"
        } else {
            "disconnected"
        }
    };
    let status_label = move || {
        if connected.get() {
            "connected"
        } else {
            "disconnected"
        }
    };

    view! {
        <header id="kat-header">
            <span class="brand">
                "kat" <span class="accent">"•"</span> "ulong"
            </span>
            <span class="status" data-status=status_attr>
                <span class="dot" aria-hidden="true"></span>
                <span class="label">{status_label}</span>
            </span>
        </header>
    }
}

#[component]
fn Main() -> impl IntoView {
    let auth = expect_context::<AuthState>();
    // Switch on auth state. While unauthenticated → `<Login/>`.
    // Once the sign-in ceremony flips `signed_in`, render the
    // (still-stub) terminal placeholder. This is the FP-leaning
    // shape: parent consumes a signal, returns the right child
    // — no imperative DOM swap, no shared mutable view-state.
    view! {
        <main id="kat-main">
            <Show
                when=move || auth.signed_in.get()
                fallback=|| view! { <Login/> }
            >
                <TerminalStub/>
            </Show>
        </main>
    }
}

/// Placeholder for the post-auth terminal UI. Slice 9r.2
/// only needs *something* to render after sign-in so the e2e
/// can assert the auth-state-driven swap; the real terminal
/// view is a separate slice that lands the WS attach + xterm
/// hookup. Keeping it as a literal stub here means we don't
/// preemptively design the terminal module before its
/// dependencies (WS protocol, tile spec) are settled.
#[component]
fn TerminalStub() -> impl IntoView {
    view! {
        <section id="kat-terminal-stub">
            <h1 class="title">"Signed in"</h1>
            <p class="blurb">"Terminal view lands in a future slice."</p>
        </section>
    }
}

/// Setup-token from the URL's `?setup_token=...` query, or
/// `None` if not present. Read once at component construction
/// — Leptos signals will track changes if a future slice
/// needs that, but the initial-load read is enough for slice
/// 9r.1's mode toggle.
fn url_setup_token() -> Option<String> {
    let location = web_sys::window()?.location();
    let search = location.search().ok()?;
    if search.is_empty() {
        return None;
    }
    let params = web_sys::UrlSearchParams::new_with_str(&search).ok()?;
    let token = params.get("setup_token")?;
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

// =====================================================================
// Wire types — mirror the server's `ChallengeStartResponse<...>` and
// `LoginFinishRequest` shapes. We don't share the server's structs
// because the server pulls in axum, sqlx, scrypt, etc. — bringing
// those into the WASM bundle would balloon it. The wire format itself
// is small + stable, so duplicating two structs is cheaper than the
// transitive crate weight. The shared `webauthn_rs_proto` types
// (`RequestChallengeResponse`, `PublicKeyCredential`) DO ride along —
// they're the part that's tricky to redo, and the crate itself is
// WASM-friendly.
// =====================================================================

#[derive(Debug, Deserialize)]
struct LoginStartResp {
    challenge_id: String,
    options: webauthn_rs_proto::RequestChallengeResponse,
}

#[derive(Debug, Serialize)]
struct LoginFinishReq {
    challenge_id: String,
    response: webauthn_rs_proto::PublicKeyCredential,
}

/// Run the full sign-in WebAuthn ceremony.
///
/// Pure-by-shape: takes nothing, returns `Result<(), String>`.
/// Side effects (network, browser API calls) are linear from
/// top to bottom; nothing leaks back into shared state. The
/// caller (a Leptos action) owns the resulting state machine.
///
/// Errors come back as `String` because the failure modes are
/// heterogeneous (network vs. browser-API vs. server-side
/// rejection) and the UI just shows the message; a typed
/// error enum would be premature until a future slice needs
/// to branch on the variant (e.g., "session expired" vs.
/// "credential revoked" surfacing different recovery UIs).
async fn signin() -> Result<(), String> {
    // 1. Ask the server for a challenge. `login_start` takes
    //    no body, so a bare POST with no Content-Type works —
    //    the route doesn't use `JsonBody<T>`.
    let start_resp = gloo_net::http::Request::post("/api/auth/login/start")
        .send()
        .await
        .map_err(|e| format!("network error contacting server: {e}"))?;

    if !start_resp.ok() {
        return Err(format!(
            "server rejected sign-in challenge ({})",
            start_resp.status()
        ));
    }

    let start: LoginStartResp = start_resp
        .json()
        .await
        .map_err(|e| format!("server returned malformed challenge: {e}"))?;

    // 2. Convert the wire challenge to the JS shape that
    //    `navigator.credentials.get()` expects. `webauthn-rs-proto`
    //    with the `wasm` feature does the binary base64url ↔
    //    Uint8Array dance inside the From impl, so we don't
    //    hand-roll it.
    let options: web_sys::CredentialRequestOptions = start.options.into();

    // 3. Run the platform ceremony. `credentials.get()` either
    //    resolves with a `PublicKeyCredential` (user confirmed
    //    with biometric/PIN) or rejects (cancel, no credential,
    //    timeout, virtual-authenticator absent in test env).
    let window = web_sys::window().ok_or("browser window unavailable")?;
    let credentials = window.navigator().credentials();
    let promise = credentials
        .get_with_options(&options)
        .map_err(|e| format!("browser refused credential request: {}", js_err(&e)))?;
    let credential_js = JsFuture::from(promise)
        .await
        .map_err(|e| format!("passkey ceremony failed: {}", js_err(&e)))?;

    let credential: web_sys::PublicKeyCredential = credential_js
        .dyn_into()
        .map_err(|_| "browser returned an unexpected credential type".to_string())?;
    let response: webauthn_rs_proto::PublicKeyCredential = credential.into();

    // 4. Send the assertion back. `login_finish` uses
    //    `JsonBody<T>` so Content-Type *must* be application/json
    //    — `gloo-net`'s `.json(...)` sets that automatically.
    let finish_resp = gloo_net::http::Request::post("/api/auth/login/finish")
        .json(&LoginFinishReq {
            challenge_id: start.challenge_id,
            response,
        })
        .map_err(|e| format!("could not encode sign-in payload: {e}"))?
        .send()
        .await
        .map_err(|e| format!("network error completing sign-in: {e}"))?;

    if !finish_resp.ok() {
        return Err(format!(
            "server rejected sign-in ({})",
            finish_resp.status()
        ));
    }

    // We don't need to parse the body — the server set the
    // session cookie via Set-Cookie, which the browser
    // automatically applies. The caller flips the auth-state
    // signal so the UI swaps to the post-auth view; future
    // slices that need the credential id or csrf token will
    // parse the response then.
    Ok(())
}

/// Render a `JsValue` error into a human-readable string.
/// `JsValue::as_string()` is the cheap path for proper `Error`
/// objects; for opaque exceptions (e.g., DOMException without
/// a message) we fall back to debug formatting so the user
/// sees *something* rather than an empty box.
fn js_err(v: &JsValue) -> String {
    if let Some(s) = v.as_string() {
        return s;
    }
    // Most browser-thrown exceptions are `Error` instances
    // with a `.message` property. Reflecting it out is the
    // closest equivalent to JS's `e.message`.
    if let Ok(msg) = js_sys::Reflect::get(v, &JsValue::from_str("message")) {
        if let Some(s) = msg.as_string() {
            if !s.is_empty() {
                return s;
            }
        }
    }
    format!("{v:?}")
}

/// Login phase — local to `<Login/>`. The four states form a
/// minimal state machine: idle → in-flight → (idle | error).
/// Encoded as an enum (rather than a pair of bool signals) so
/// "in-flight" and "error" can never co-exist; `pending` would
/// be ambiguous if both were independent.
#[derive(Clone, Debug, PartialEq, Eq)]
enum LoginPhase {
    Idle,
    InFlight,
    Error(String),
}

/// Visual shell of the auth ceremony. Two modes, switched by
/// the presence of `?setup_token=` in the URL:
///
/// - **Pair mode** (token present): "Pair this device — name
///   it and confirm with your passkey." This is the
///   add-additional-device flow that the Node implementation
///   exposes via the staging script's printed pair URL.
///
/// - **Sign-in mode** (no token): "Sign in with your
///   passkey." Pure WebAuthn login, no setup token needed.
///   On a fresh data dir with no enrolled passkeys this will
///   be a dead-end — the bootstrap path (first device, no
///   token) is a separate question that 9r.4 will resolve.
///
/// Slice 9r.2 wires the sign-in ceremony only. The pair
/// ceremony stays inert until 9r.3 — the `<button>` is
/// disabled in pair mode so a user can't click it and get
/// nothing.
#[component]
fn Login() -> impl IntoView {
    let setup_token = url_setup_token();
    let is_pair_mode = setup_token.is_some();

    // The form has a separate identity for tests / future
    // styling: `data-mode` swaps copy + behavior between the
    // two ceremonies.
    let mode_attr = if is_pair_mode { "pair" } else { "signin" };
    let title = if is_pair_mode {
        "Pair this device"
    } else {
        "Sign in"
    };
    let cta_idle = if is_pair_mode {
        "Pair with passkey"
    } else {
        "Sign in with passkey"
    };
    let blurb = if is_pair_mode {
        "Name this device and confirm with your passkey to add it to your account."
    } else {
        "Use your passkey to sign in."
    };

    let auth = expect_context::<AuthState>();

    // Local state machine. `phase` drives the CTA copy +
    // disabled state and renders the error region.
    let (phase, set_phase) = create_signal(LoginPhase::Idle);

    // The ceremony itself is dispatched via `create_action`.
    // That gives us:
    //   - automatic pending tracking (we don't fire twice on
    //     a fast double-click — the action is gated by the
    //     button's `disabled` attribute, which we wire to
    //     `phase == InFlight`)
    //   - automatic cleanup if the component unmounts mid-
    //     flight (Leptos cancels the future)
    //   - composability: the action handler reads/writes the
    //     same `set_phase` signal, keeping all state
    //     transitions in one place.
    let signin_action = create_action(move |_: &()| async move {
        set_phase.set(LoginPhase::InFlight);
        match signin().await {
            Ok(()) => {
                // Flip global auth state — `<Main/>` swaps to
                // the post-auth view. We deliberately leave
                // `phase` at InFlight here; the component is
                // about to unmount as a result of the swap, so
                // there's no Idle state to return to.
                auth.set_signed_in.set(true);
            }
            Err(message) => {
                set_phase.set(LoginPhase::Error(message));
            }
        }
    });

    let cta_label = move || match phase.get() {
        LoginPhase::InFlight => "Signing in…".to_string(),
        _ => cta_idle.to_string(),
    };
    let cta_disabled = move || {
        // Sign-in: disable while a ceremony is mid-flight.
        // Pair mode: disabled outright in 9r.2 — clicking it
        // would do nothing because we haven't wired the pair
        // ceremony yet. Greying the button out is a clearer
        // signal than letting the user click into the void.
        is_pair_mode || matches!(phase.get(), LoginPhase::InFlight)
    };
    // Signal: are we in the error state? Drives a conditional
    // <p class="error">. Reading the message directly out of
    // the signal would clone an empty string in the non-error
    // case, hence the `Show` + accessor split.
    let error_message = move || match phase.get() {
        LoginPhase::Error(msg) => Some(msg),
        _ => None,
    };

    view! {
        <section id="kat-login" data-mode=mode_attr>
            <h1 class="title">{title}</h1>
            <p class="blurb">{blurb}</p>
            // Pair mode collects a device name (e.g.,
            // "felix-iphone"). Sign-in mode skips it — the
            // passkey itself identifies the credential.
            {is_pair_mode.then(|| view! {
                <label class="field">
                    <span class="label">"Device name"</span>
                    <input
                        type="text"
                        name="device-name"
                        autocomplete="off"
                        placeholder="e.g. felix-iphone"
                    />
                </label>
            })}
            <button
                type="button"
                class="cta"
                prop:disabled=cta_disabled
                on:click=move |_| {
                    // Clear any prior error so a retry
                    // doesn't render stale text under the
                    // button while the new ceremony is
                    // pending.
                    set_phase.set(LoginPhase::Idle);
                    signin_action.dispatch(());
                }
            >
                {cta_label}
            </button>
            {move || error_message().map(|msg| view! {
                <p class="error" role="alert">{msg}</p>
            })}
        </section>
    }
}
