// Leptos shell.
//
// Slice 9q: layout primitives (header + main).
// Slice 9r.1: <Login/> form shell with URL-based mode switch.
// Slice 9r.2: sign-in WebAuthn ceremony wired to the API.
//   Login + ceremony moved to `login.rs` — this file owns
//   only the shell layout, the App-root signal contexts, and
//   the auth-state-driven swap in <Main/>.
// Slice 9r.4: status probe + session restore. Auth state
//   becomes tri-state — None while the initial
//   `/api/auth/status` probe is in flight, Some(false) when
//   the server says not authed, Some(true) when authed. The
//   None branch renders a small "restoring" view, NOT the
//   login form, so a refresh after sign-in doesn't flash
//   the user back to "Sign in with passkey" before the
//   probe resolves.
//
// FP-leaning per memory `feedback_rewrite_fp_direction`: the
// shell is built from small pure components composed into a
// tree. Auth + connection state live in signals provided at
// the App root; the ceremonies (signin, pair, status probe)
// are pure async functions returning `Result` — the
// components dispatch them via `spawn_local` /
// `create_action` and react to the resolved value.

use katulong_shared::wire::AuthStatusResponse;
use leptos::*;
use wasm_bindgen_futures::spawn_local;

mod login;
use login::Login;

fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(|| view! { <App/> });
}

/// Reactive connection-state signal exposed to descendants
/// via context. `false` until a future slice wires the WS
/// attach handshake to flip it.
#[derive(Copy, Clone)]
struct ConnectionStatus(ReadSignal<bool>);

/// Tri-state auth signal exposed to descendants via context:
///
/// - `None` — initial probe to `/api/auth/status` is in
///   flight. `<Main/>` renders a small "restoring" view
///   here, NOT the login form, so a page reload of an
///   already-authed user doesn't flash through the sign-in
///   screen.
/// - `Some(false)` — probe resolved as unauthenticated. The
///   login form renders.
/// - `Some(true)` — probe resolved as authenticated, OR the
///   sign-in/pair ceremony just succeeded. Post-auth view
///   renders.
///
/// The setter half travels alongside the reader because two
/// places need to write: the App-root probe-on-mount, and
/// `<Login/>`'s ceremony success branches. A future logout
/// will write the same setter in the opposite direction.
#[derive(Copy, Clone)]
pub struct AuthState {
    pub signed_in: ReadSignal<Option<bool>>,
    pub set_signed_in: WriteSignal<Option<bool>>,
}

/// Probe `/api/auth/status` once at App mount to discover
/// the current session state. Returns the `authenticated`
/// flag from the response (the wire shape exposes more
/// fields — `access_method`, `has_credentials` — but only
/// `authenticated` is needed at this layer; future slices
/// that branch on `has_credentials` for the
/// "no-credentials-yet → register flow" route will read the
/// other fields).
async fn probe_auth_status() -> Result<bool, String> {
    let resp = gloo_net::http::Request::get("/api/auth/status")
        .send()
        .await
        .map_err(|e| format!("network error contacting server: {e}"))?;
    if !resp.ok() {
        return Err(format!("status returned {}", resp.status()));
    }
    let status: AuthStatusResponse = resp
        .json()
        .await
        .map_err(|e| format!("malformed status response: {e}"))?;
    Ok(status.authenticated)
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

    // Auth signal lives at the root because three places
    // need to write: the probe-on-mount below, `<Login/>`'s
    // ceremony success branches, and a future logout. Initial
    // `None` means "probe in flight" — `<Main/>` renders the
    // restoring view in this state.
    let (signed_in, set_signed_in) = create_signal(None::<bool>);
    provide_context(AuthState {
        signed_in,
        set_signed_in,
    });

    // Fire the probe once on mount. We don't use
    // `create_action` because there's no input and no need
    // to expose pending/result state to the component tree —
    // the auth signal IS the result. On error (network
    // failure, server misbehaving), default to
    // `Some(false)` so the user lands on the login form
    // rather than getting stuck on "restoring…" forever.
    spawn_local(async move {
        match probe_auth_status().await {
            Ok(authed) => set_signed_in.set(Some(authed)),
            Err(_) => set_signed_in.set(Some(false)),
        }
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
    // Single derived view of the connection bool — used both
    // for the `data-status` attribute (CSS dot color hook)
    // and the visible label. Two separate closures would
    // create two reactive subscriptions and risk silent
    // divergence if one ever changed; this folds them into
    // one read per render.
    let status = move || {
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
            <span class="status" data-status=status>
                <span class="dot" aria-hidden="true"></span>
                <span class="label">{status}</span>
            </span>
        </header>
    }
}

#[component]
fn Main() -> impl IntoView {
    let auth = expect_context::<AuthState>();
    // Three-way switch on auth state. The `None` case has to
    // render SOMETHING that isn't the login form — otherwise
    // a page reload of an authed user would briefly flash
    // through the sign-in screen before the probe resolves
    // and swaps to the post-auth view. The "restoring…"
    // section is small and self-explanatory.
    view! {
        <main id="kat-main">
            {move || match auth.signed_in.get() {
                None => view! { <SessionRestoring/> }.into_view(),
                Some(true) => view! { <TerminalStub/> }.into_view(),
                Some(false) => view! { <Login/> }.into_view(),
            }}
        </main>
    }
}

/// Rendered while the initial auth-status probe is in
/// flight. Deliberately minimal — the probe is a single
/// fast HTTP round trip, so this view is on screen for
/// O(100ms) on a normal network and the user shouldn't
/// even register it. The visible identity matters for e2e:
/// `#kat-session-restoring` is the selector hook for tests
/// that want to wait the probe out before asserting on
/// downstream views.
#[component]
fn SessionRestoring() -> impl IntoView {
    view! {
        <section id="kat-session-restoring" aria-busy="true">
            <p class="blurb">"Restoring session…"</p>
        </section>
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
