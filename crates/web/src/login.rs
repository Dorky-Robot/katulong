//! Login component + sign-in / pair WebAuthn ceremonies.
//!
//! Slice 9r.1 landed the form shell + URL-based pair vs.
//! sign-in mode swap. Slice 9r.2 wired the sign-in ceremony.
//! Slice 9r.3 wires the pair (registration) ceremony,
//! reusing the `LoginPhase` state machine.
//!
//! FP-leaning per memory `feedback_rewrite_fp_direction`:
//! `signin()` and `pair()` are pure async pipelines (no shared
//! state, no callbacks). They share shape but not types — the
//! WebAuthn wire formats and the `web-sys` entry points
//! diverge between get/create. We keep them as two parallel
//! functions rather than a generic helper because the
//! "different parts" (endpoint, request body, options type,
//! navigator method, response type) outweigh the "same parts"
//! (ok-check, JsFuture, dyn_into); a generic abstraction
//! would obscure the flow without paying for itself.
//! The component dispatches whichever applies via
//! `create_action` and reacts to the resolved value.

use crate::AuthState;
use katulong_shared::wire::{
    LoginFinishRequest, LoginStartResponse, PairFinishRequest, PairStartRequest,
    PairStartResponse,
};
use leptos::*;
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

/// HTTP status guard shared by both ceremonies. Earlier
/// drafts inlined this twice; the duplicated format strings
/// drifted in review (one read "pair payload" for two
/// different payloads), which is exactly the failure mode a
/// helper prevents. Returns the status code embedded in the
/// message because the e2e suite asserts on it
/// (`toContainText("401")`).
fn check_ok(resp: &gloo_net::http::Response, label: &str) -> Result<(), String> {
    if resp.ok() {
        Ok(())
    } else {
        Err(format!("{label} ({})", resp.status()))
    }
}

/// Resolve a `navigator.credentials.{get,create}` promise into
/// the `web_sys::PublicKeyCredential` both ceremonies consume.
/// The promise is owned (not borrowed) because `JsFuture::from`
/// takes ownership; once we hand it over, the caller has no
/// remaining handle anyway.
async fn credential_from_promise(
    promise: js_sys::Promise,
) -> Result<web_sys::PublicKeyCredential, String> {
    let credential_js = JsFuture::from(promise)
        .await
        .map_err(|e| format!("passkey ceremony failed: {}", js_err(&e)))?;
    credential_js.dyn_into().map_err(|v| {
        format!(
            "browser returned an unexpected credential type: {}",
            js_err(&v)
        )
    })
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
    // 1. Ask the server for a challenge.
    let start_resp = gloo_net::http::Request::post("/api/auth/login/start")
        .send()
        .await
        .map_err(|e| format!("network error contacting server: {e}"))?;
    check_ok(&start_resp, "server rejected sign-in challenge")?;
    let start: LoginStartResponse = start_resp
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
    let promise = window
        .navigator()
        .credentials()
        .get_with_options(&options)
        .map_err(|e| format!("browser refused credential request: {}", js_err(&e)))?;
    let credential = credential_from_promise(promise).await?;
    let response: webauthn_rs_proto::PublicKeyCredential = credential.into();

    // 4. Send the assertion back. `login_finish` uses
    //    `JsonBody<T>` so Content-Type *must* be application/json
    //    — `gloo-net`'s `.json(...)` sets that automatically.
    let finish_resp = gloo_net::http::Request::post("/api/auth/login/finish")
        .json(&LoginFinishRequest {
            challenge_id: start.challenge_id,
            response,
        })
        .map_err(|e| format!("could not encode sign-in payload: {e}"))?
        .send()
        .await
        .map_err(|e| format!("network error completing sign-in: {e}"))?;
    check_ok(&finish_resp, "server rejected sign-in")?;

    // The server set the session cookie via Set-Cookie. The
    // caller flips the auth-state signal so the UI swaps to
    // the post-auth view.
    Ok(())
}

/// Run the full pair (WebAuthn registration) ceremony.
///
/// Symmetric to `signin()` but uses the registration variant
/// of every step:
///   - POST `/api/auth/pair/start` with the plaintext
///     setup-token in the body (vs. no body for sign-in)
///   - convert `CreationChallengeResponse` →
///     `web_sys::CredentialCreationOptions` (vs. request
///     options for sign-in)
///   - call `navigator.credentials.create(...)` (vs.
///     `.get(...)`)
///   - convert returned credential →
///     `RegisterPublicKeyCredential` (vs. assertion type)
///   - POST `/api/auth/pair/finish` with the
///     `setup_token_id` echoed alongside the assertion
///
/// The setup-token is moved in (not borrowed) because the
/// dispatched action future has no upper-bounded lifetime —
/// once the click fires, the future may outlive any borrow we
/// could have given it.
async fn pair(setup_token: String) -> Result<(), String> {
    // 1. Ask for a registration challenge.
    let start_resp = gloo_net::http::Request::post("/api/auth/pair/start")
        .json(&PairStartRequest { setup_token })
        .map_err(|e| format!("could not encode pair-start payload: {e}"))?
        .send()
        .await
        .map_err(|e| format!("network error contacting server: {e}"))?;
    check_ok(&start_resp, "server rejected pair challenge")?;
    let start: PairStartResponse = start_resp
        .json()
        .await
        .map_err(|e| format!("server returned malformed challenge: {e}"))?;

    // 2. Convert the wire challenge to the JS shape that
    //    `navigator.credentials.create()` expects.
    let options: web_sys::CredentialCreationOptions = start.options.into();

    // 3. Run the platform registration ceremony. `.create()`
    //    either resolves with a `PublicKeyCredential` (user
    //    confirmed with biometric/PIN, authenticator minted a
    //    new keypair) or rejects (cancel, "already
    //    registered", timeout, no authenticator available).
    let window = web_sys::window().ok_or("browser window unavailable")?;
    let promise = window
        .navigator()
        .credentials()
        .create_with_options(&options)
        .map_err(|e| format!("browser refused credential creation: {}", js_err(&e)))?;
    let credential = credential_from_promise(promise).await?;
    let response: webauthn_rs_proto::RegisterPublicKeyCredential = credential.into();

    // 4. Send the attestation back along with the
    //    `setup_token_id` the server gave us in step 1.
    let finish_resp = gloo_net::http::Request::post("/api/auth/pair/finish")
        .json(&PairFinishRequest {
            challenge_id: start.challenge_id,
            setup_token_id: start.setup_token_id,
            response,
        })
        .map_err(|e| format!("could not encode pair-finish payload: {e}"))?
        .send()
        .await
        .map_err(|e| format!("network error completing pair: {e}"))?;
    check_ok(&finish_resp, "server rejected pair")?;

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
/// Both ceremonies are wired as of slice 9r.3. The component
/// constructs one `create_action` per mode so the active
/// dispatch path is statically determined at component
/// construction; the click handler picks which to fire.
#[component]
pub fn Login() -> impl IntoView {
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

    // Both ceremonies share the same post-resolve handler:
    // success flips global auth state (which unmounts this
    // component, so we don't bother resetting `phase`); error
    // moves the local state machine into Error so the alert
    // renders. Defining the handler once keeps the two
    // actions in lockstep — adding a new "logging" hook later
    // means changing one place, not two.
    let resolve = move |result: Result<(), String>| match result {
        Ok(()) => auth.set_signed_in.set(true),
        Err(message) => set_phase.set(LoginPhase::Error(message)),
    };

    // The ceremonies themselves are dispatched via
    // `create_action`. That gives us:
    //   - automatic pending tracking (we don't fire twice on
    //     a fast double-click — the action is gated by the
    //     button's `disabled` attribute, which we wire to
    //     `phase == InFlight`)
    //   - automatic cleanup if the component unmounts mid-
    //     flight (Leptos cancels the future)
    //   - composability: each handler funnels its result
    //     through `resolve`, keeping all state transitions in
    //     one place.
    //
    // We construct both actions unconditionally even though
    // only one will be dispatched per component instance. The
    // unused action is a small allocation; branching on
    // `is_pair_mode` here would force the click handler to
    // hold either an `Action<(), ()>` or an `Action<String,
    // ()>` (different input types), which doesn't compose
    // without erasure. Keeping both visible is also useful
    // for future slices that may want a "switch mode" toggle.
    let signin_action = create_action(move |_: &()| async move {
        resolve(signin().await);
    });
    let pair_action = create_action(move |token: &String| {
        let token = token.clone();
        async move {
            resolve(pair(token).await);
        }
    });

    let cta_label = move || match phase.get() {
        LoginPhase::InFlight => if is_pair_mode {
            "Pairing…"
        } else {
            "Signing in…"
        }
        .to_string(),
        _ => cta_idle.to_string(),
    };
    let cta_disabled = move || matches!(phase.get(), LoginPhase::InFlight);
    // Signal: are we in the error state? Drives a conditional
    // <p class="error">. Reading the message directly out of
    // the signal would clone an empty string in the non-error
    // case, hence the `Show` + accessor split.
    let error_message = move || match phase.get() {
        LoginPhase::Error(msg) => Some(msg),
        _ => None,
    };

    // Click handler picks the ceremony based on mode and
    // dispatches with the appropriate input. `setup_token` is
    // moved into the closure; each click clones the inner
    // `String` into the dispatch.
    let on_click = move |_| {
        // Set InFlight synchronously, not inside the action
        // future. `create_action`'s first poll runs on a
        // microtask, so an Idle → InFlight transition done
        // inside the future would leave a tick where the
        // button is briefly enabled — long enough for a
        // synthetic double-click to fire a second concurrent
        // ceremony. The disabled re-render must happen before
        // the second click can be queued.
        set_phase.set(LoginPhase::InFlight);
        match &setup_token {
            Some(token) => {
                pair_action.dispatch(token.clone());
            }
            None => {
                signin_action.dispatch(());
            }
        }
    };

    view! {
        <section id="kat-login" data-mode=mode_attr>
            <h1 class="title">{title}</h1>
            <p class="blurb">{blurb}</p>
            // Device-name input deliberately absent. A future
            // slice that adds a `credential_name` field to the
            // auth schema will reintroduce it; rendering the
            // affordance before the wire type carries the
            // value would silently discard whatever the user
            // typed.
            <button
                type="button"
                class="cta"
                prop:disabled=cta_disabled
                on:click=on_click
            >
                {cta_label}
            </button>
            {move || error_message().map(|msg| view! {
                <p class="error" role="alert">{msg}</p>
            })}
        </section>
    }
}
