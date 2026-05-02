//! Login + Register components + their WebAuthn ceremonies.
//!
//! Slice 9r.1 landed the form shell + URL-based pair vs.
//! sign-in mode swap. Slice 9r.2 wired the sign-in ceremony.
//! Slice 9r.3 wires the pair (additional-device registration)
//! ceremony. Slice 9r.5 adds the first-device register
//! ceremony as a sibling component, gated by
//! `AuthPhase::Register` (which the App-root probe sets when
//! the server reports authenticated-but-no-credentials, the
//! fresh-install-on-localhost case).
//!
//! Three pure async ceremonies live here: `signin()`, `pair()`,
//! `register()`. Their shapes are nearly identical (start
//! request → options → credentials API → finish request) but
//! the types diverge at every step (endpoint URL, request
//! body, options type, navigator method, response type, finish
//! body). A generic helper across the three would need ~6
//! type parameters; three parallel functions reading top-to-
//! bottom is easier to follow. The genuinely shared parts —
//! HTTP-status guard, JsFuture-into-credential conversion,
//! JsValue error rendering — are extracted as `check_ok`,
//! `credential_from_promise`, and `js_err`.
//!
//! FP-leaning per memory `feedback_rewrite_fp_direction`: the
//! ceremonies are side-effect-free in shape (Result-returning
//! linear pipelines). The components dispatch them via
//! `create_action` and react to the resolved value through a
//! shared `resolve` closure that funnels success/error into
//! the right signals.

use crate::AuthState;
use katulong_shared::wire::{
    LoginFinishRequest, LoginStartResponse, PairFinishRequest, PairStartRequest,
    PairStartResponse, RegisterFinishRequest, RegisterStartResponse,
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

/// Run the first-device WebAuthn registration ceremony.
///
/// Same shape as `pair()` (both produce a credential via
/// `navigator.credentials.create()`), with the differences
/// concentrated at the HTTP boundaries:
///   - POST `/api/auth/register/start` with no body (the
///     route is localhost-only and fresh-install-only on the
///     server; no setup token to submit)
///   - POST `/api/auth/register/finish` with just the
///     credential — no `setup_token_id` to echo
///
/// The server's register routes refuse non-localhost callers
/// and refuse a non-fresh install. The WASM doesn't pre-check
/// either condition; the user only reaches this ceremony when
/// the App-root probe has already classified the request as
/// `AuthPhase::Register`, which by definition means
/// authenticated (loopback peer) AND no credentials. If the
/// server rejects anyway (race against another concurrent
/// register, or a credential added between the probe and the
/// click), the error renders in the standard error region.
async fn register() -> Result<(), String> {
    // 1. Ask for a registration challenge.
    let start_resp = gloo_net::http::Request::post("/api/auth/register/start")
        .send()
        .await
        .map_err(|e| format!("network error contacting server: {e}"))?;
    check_ok(&start_resp, "server rejected register challenge")?;
    let start: RegisterStartResponse = start_resp
        .json()
        .await
        .map_err(|e| format!("server returned malformed challenge: {e}"))?;

    // 2. Convert the wire challenge to the JS shape that
    //    `navigator.credentials.create()` expects.
    let options: web_sys::CredentialCreationOptions = start.options.into();

    // 3. Run the platform registration ceremony.
    let window = web_sys::window().ok_or("browser window unavailable")?;
    let promise = window
        .navigator()
        .credentials()
        .create_with_options(&options)
        .map_err(|e| format!("browser refused credential creation: {}", js_err(&e)))?;
    let credential = credential_from_promise(promise).await?;
    let response: webauthn_rs_proto::RegisterPublicKeyCredential = credential.into();

    // 4. Send the attestation back. No `setup_token_id` here —
    //    register/finish only needs the challenge id and the
    //    credential.
    let finish_resp = gloo_net::http::Request::post("/api/auth/register/finish")
        .json(&RegisterFinishRequest {
            challenge_id: start.challenge_id,
            response,
        })
        .map_err(|e| format!("could not encode register-finish payload: {e}"))?
        .send()
        .await
        .map_err(|e| format!("network error completing register: {e}"))?;
    check_ok(&finish_resp, "server rejected register")?;

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
    web_sys::console::warn_2(&JsValue::from_str("katulong: unstructured browser error"), v);
    "unexpected browser error".to_string()
}

/// In-flight state machine for an auth ceremony component.
/// Used by both `<Login/>` (sign-in + pair) and
/// `<Register/>`. Three states form a minimal machine:
/// idle → in-flight → (idle | error). Encoded as an enum
/// (rather than a pair of bool signals) so "in-flight" and
/// "error" can never co-exist; `pending` would be ambiguous
/// if both were independent.
#[derive(Clone, Debug, PartialEq, Eq)]
enum CeremonyPhase {
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
    let (phase, set_phase) = create_signal(CeremonyPhase::Idle);

    // Both ceremonies share the same post-resolve handler:
    // success flips global auth state (which unmounts this
    // component, so we don't bother resetting `phase`); error
    // moves the local state machine into Error so the alert
    // renders. Defining the handler once keeps the two
    // actions in lockstep — adding a new "logging" hook later
    // means changing one place, not two.
    let resolve = move |result: Result<(), String>| match result {
        Ok(()) => auth.set_phase.set(crate::AuthPhase::SignedIn),
        Err(message) => set_phase.set(CeremonyPhase::Error(message)),
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
        CeremonyPhase::InFlight => if is_pair_mode {
            "Pairing…"
        } else {
            "Signing in…"
        }
        .to_string(),
        _ => cta_idle.to_string(),
    };
    let cta_disabled = move || matches!(phase.get(), CeremonyPhase::InFlight);
    // Signal: are we in the error state? Drives a conditional
    // <p class="error">. Reading the message directly out of
    // the signal would clone an empty string in the non-error
    // case, hence the `Show` + accessor split.
    let error_message = move || match phase.get() {
        CeremonyPhase::Error(msg) => Some(msg),
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
        set_phase.set(CeremonyPhase::InFlight);
        match &setup_token {
            Some(token) => {
                pair_action.dispatch(token.clone());
            }
            None => {
                signin_action.dispatch(());
            }
        }
    };

    // Setup-token-input flow (sign-in mode only).
    //
    // The pair URL `?setup_token=...` covers the "scan QR
    // from another device" path; this manual-input flow
    // covers the "I have a setup token I want to paste"
    // path. Both feed the same `pair_action`, so the
    // ceremony shape and error surface stay singular —
    // only the source of the token differs. Pair mode (URL
    // already carries a token) hides this section: the user
    // arrived via a pair link and the token is already in
    // hand; presenting an input would be confusing.
    let (token_input, set_token_input) = create_signal(String::new());
    // Trim on read so leading/trailing whitespace from a
    // paste-from-clipboard doesn't reach the `pair_action`
    // (the server's token validator is strict).
    let token_trimmed = move || token_input.with(|t| t.trim().to_string());
    let register_disabled = move || {
        matches!(phase.get(), CeremonyPhase::InFlight) || token_trimmed().is_empty()
    };
    let register_label = move || match phase.get() {
        CeremonyPhase::InFlight => "Setting up…".to_string(),
        _ => "Set up new passkey".to_string(),
    };
    let on_setup_click = move |_| {
        let token = token_trimmed();
        if token.is_empty() {
            return;
        }
        // Same synchronous-InFlight pattern as the primary
        // CTA. `create_action`'s microtask scheduling means
        // setting InFlight inside the action future would
        // leave a re-entrant click window.
        set_phase.set(CeremonyPhase::InFlight);
        pair_action.dispatch(token);
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

            // Alternate-auth disclosure: setup-token-input
            // path. Always rendered, including in pair mode —
            // the user might arrive with a stale or wrong
            // pair URL and need to paste a different token,
            // or they might want to register a different
            // device than the URL was minted for. Keeping
            // the affordance present in both modes matches
            // the "always an option" rule from the Node
            // login UI.
            //
            // Native `<details>` is the right primitive: the
            // disclosure state is OS-managed, accessible by
            // default (keyboard, screen reader), and survives
            // page reload behavior in Safari/Chrome.
            //
            // **Why deferred: "Authorize from another
            // device".** The Node login UI offers a third
            // option that uses a server-side device-auth
            // flow (one device shows a code, the user
            // confirms on a logged-in device). The matching
            // server endpoints don't exist on the Rust side
            // yet — a separate slice. Rendering a disabled
            // button here would just be visual debt.
            <details class="alt-auth">
                <summary class="alt-auth-toggle">
                    "Set up a new passkey"
                </summary>
                <div class="alt-auth-body">
                    <p class="hint">
                        "Paste a setup token to register this device. Get one from the staging script's pair URL or from another already-paired device."
                    </p>
                    <div class="field">
                        <label class="label" for="kat-setup-token">"Setup token"</label>
                        <input
                            id="kat-setup-token"
                            type="text"
                            autocorrect="off"
                            autocapitalize="off"
                            autocomplete="off"
                            spellcheck="false"
                            placeholder="paste token here"
                            prop:value=token_input
                            on:input=move |ev| set_token_input.set(event_target_value(&ev))
                        />
                    </div>
                    <button
                        type="button"
                        class="cta cta-secondary"
                        prop:disabled=register_disabled
                        on:click=on_setup_click
                    >
                        {register_label}
                    </button>
                </div>
            </details>
        </section>
    }
}

/// First-device register UI. Rendered when the App-root
/// probe classifies the request as `AuthPhase::Register`
/// (server: authenticated && !has_credentials, i.e., a
/// fresh-install localhost session with no enrolled
/// credentials).
///
/// The UX is deliberately minimal: one CTA, one explanatory
/// blurb. Unlike `<Login/>` (which has two URL-driven modes
/// and dispatches between two ceremonies), `<Register/>` has
/// exactly one path — there's no setup token, no device-
/// name input (the server doesn't carry a name field on
/// register/finish either), no mode switch. A user reaching
/// this view is by definition the operator setting up the
/// first device; we don't need to clutter the screen with
/// options.
#[component]
pub fn Register() -> impl IntoView {
    let auth = expect_context::<AuthState>();
    let (phase, set_phase) = create_signal(CeremonyPhase::Idle);

    // Same resolve closure pattern as `<Login/>` — success
    // flips global auth state (which unmounts this component
    // when `<Main/>`'s match swaps to `<TileHost/>`), error
    // renders in the local error region.
    let resolve = move |result: Result<(), String>| match result {
        Ok(()) => auth.set_phase.set(crate::AuthPhase::SignedIn),
        Err(message) => set_phase.set(CeremonyPhase::Error(message)),
    };

    let register_action = create_action(move |_: &()| async move {
        resolve(register().await);
    });

    let cta_label = move || match phase.get() {
        CeremonyPhase::InFlight => "Registering…".to_string(),
        _ => "Register first device".to_string(),
    };
    let cta_disabled = move || matches!(phase.get(), CeremonyPhase::InFlight);
    let error_message = move || match phase.get() {
        CeremonyPhase::Error(msg) => Some(msg),
        _ => None,
    };

    // Same synchronous-InFlight pattern as `<Login/>`'s
    // click handler. `create_action`'s first poll runs on a
    // microtask, so a transition done inside the future
    // would leave a window where a synthetic double-click
    // could fire two concurrent ceremonies. Setting InFlight
    // synchronously here closes that window.
    let on_click = move |_| {
        set_phase.set(CeremonyPhase::InFlight);
        register_action.dispatch(());
    };

    view! {
        <section id="kat-register" data-mode="register">
            <h1 class="title">"Set up your first device"</h1>
            <p class="blurb">
                "Register a passkey for this device to get started. The first credential is created from this machine over localhost."
            </p>
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
