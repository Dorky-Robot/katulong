//! Login component + sign-in WebAuthn ceremony.
//!
//! Slice 9r.1 landed the form shell + URL-based pair vs.
//! sign-in mode swap. Slice 9r.2 wired the sign-in ceremony.
//! Slice 9r.3 (planned) lands the pair ceremony, which will
//! reuse the `LoginPhase` machine and the HTTP glue here.
//!
//! FP-leaning per memory `feedback_rewrite_fp_direction`:
//! `signin()` is a pure async pipeline (no shared state, no
//! callbacks); the component dispatches it via
//! `create_action` and reacts to the resolved value.

use crate::AuthState;
use leptos::*;
use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

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
        .map_err(|v| format!("browser returned an unexpected credential type: {}", js_err(&v)))?;
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
///
/// Two layers, both bounded:
/// 1. If the value is a JS string, return it.
/// 2. If it has a non-empty `.message` property (the conventional
///    field on `Error` / `DOMException`), return that.
///
/// We deliberately do NOT fall back to `format!("{v:?}")`. Debug
/// formatting of a `JsValue` in some browsers/extensions can
/// surface internal state into the user-visible error string, and
/// since we render that string into the DOM via Leptos's text
/// nodes, we'd be giving the user (or an over-the-shoulder
/// observer) detail they don't need. The console gets the
/// debug form for operator triage; the UI gets a generic message.
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
    // Operator-side detail goes to the console; the user-side
    // string stays generic. Useful when triaging weird browser
    // / extension errors that don't follow the `Error` shape.
    web_sys::console::warn_2(&JsValue::from_str("katulong: unstructured signin error"), v);
    "unexpected browser error".to_string()
}

/// Login phase — local to `<Login/>`. The three states form a
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
pub fn Login() -> impl IntoView {
    let setup_token = url_setup_token();
    let is_pair_mode = setup_token.is_some();
    // 9r.3 will read `setup_token` to forward into the pair
    // ceremony. Holding it in a binding (not just discarding)
    // documents that intent.
    let _setup_token_for_9r3 = setup_token;

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
        match signin().await {
            Ok(()) => {
                // Flip global auth state — `<Main/>` swaps to
                // the post-auth view, unmounting this
                // component in the process. We don't reset
                // `phase` here because the unmount discards
                // the signal anyway; resetting would just be
                // a write into a dropped scope.
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
                    // Set InFlight directly here, not inside
                    // the action future. The action's first
                    // poll runs on a microtask, so an Idle →
                    // InFlight transition done inside the
                    // future would leave a tick where the
                    // button is briefly enabled — long enough
                    // for a synthetic double-click to fire a
                    // second concurrent ceremony. Setting
                    // InFlight synchronously here closes that
                    // window: the disabled re-render happens
                    // before the second click can be queued.
                    set_phase.set(LoginPhase::InFlight);
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
