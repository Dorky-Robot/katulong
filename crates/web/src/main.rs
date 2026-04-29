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

use katulong_shared::wire::{AuthStatusResponse, TileLayout};
use leptos::*;
use wasm_bindgen_futures::spawn_local;

mod login;
mod tile;
mod ws;
use login::{Login, Register};
use tile::{LayoutState, TileHost};

fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(|| view! { <App/> });
}

/// Reactive connection-state signal exposed to descendants via
/// context. `false` until the WS handshake completes; flips to
/// `true` after the client has sent `HelloAck` and back to
/// `false` on disconnect. The setter is exposed so the WS
/// client (lifecycle owner) can write through; readers (Header
/// status indicator, StatusTile, future tiles) only need the
/// reader.
///
/// Named-field shape mirrors `AuthState` so callers see a
/// consistent context shape across the platform's two
/// reactive primitives.
#[derive(Copy, Clone)]
pub struct ConnectionStatus {
    pub connected: ReadSignal<bool>,
    pub set_connected: WriteSignal<bool>,
}

/// Phases of the auth state machine driving `<Main/>`'s
/// view selection.
///
/// - `Restoring` — initial probe to `/api/auth/status` is in
///   flight. `<Main/>` renders a small "restoring" view here,
///   NOT the login form, so a page reload of an already-authed
///   user doesn't flash through the sign-in screen.
/// - `Register` — server says authenticated (typically via
///   localhost auto-auth) but no credentials are registered
///   yet. The first-device register UI renders. Distinct
///   from `SignedOut` because the next user action differs:
///   `Register` triggers `/api/auth/register/*` (localhost-
///   only, fresh-install-only); `SignedOut` triggers
///   `/api/auth/login/*`.
/// - `SignedOut` — probe resolved as unauthenticated AND
///   credentials exist on the server. The login form
///   renders.
/// - `SignedIn` — probe resolved as authenticated AND
///   credentials exist, OR a register/sign-in/pair ceremony
///   just succeeded. Post-auth view renders.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AuthPhase {
    Restoring,
    Register,
    SignedOut,
    SignedIn,
}

/// Reactive auth-state signal exposed via context. The setter
/// half travels alongside the reader because two places write
/// today (the App-root probe-on-mount and `<Login/>`'s
/// ceremony success branches), and a future logout slice will
/// write the same setter in the opposite direction.
#[derive(Copy, Clone)]
pub struct AuthState {
    pub phase: ReadSignal<AuthPhase>,
    pub set_phase: WriteSignal<AuthPhase>,
}

/// Probe `/api/auth/status` once at App mount.
///
/// Returns the full `AuthStatusResponse` (not just the
/// `authenticated` bool) so the caller has access to
/// `has_credentials` and `access_method` without a second
/// round trip when 9r.5 lands the register flow gate. The
/// caller currently only consumes `authenticated`; the wider
/// shape is on the boundary instead of behind it so
/// downstream code can grow without re-shaping this fn.
async fn probe_auth_status() -> Result<AuthStatusResponse, String> {
    let resp = gloo_net::http::Request::get("/api/auth/status")
        .send()
        .await
        .map_err(|e| format!("network error contacting server: {e}"))?;
    if !resp.ok() {
        return Err(format!("status returned {}", resp.status()));
    }
    resp.json()
        .await
        .map_err(|e| format!("malformed status response: {e}"))
}

#[component]
fn App() -> impl IntoView {
    // Connection signal lives at the root so any descendant
    // can read it without prop-drilling. The WS lifecycle owner
    // (`crate::ws::install`, called below after `AuthState` is
    // provided) writes the setter as the connection comes up
    // and goes down.
    let (connected, set_connected) = create_signal(false);
    let connection_status = ConnectionStatus {
        connected,
        set_connected,
    };
    provide_context(connection_status);

    // Auth signal lives at the root because three places
    // need to write: the probe-on-mount below, `<Login/>`'s
    // ceremony success branches, and a future logout. Initial
    // `Restoring` — `<Main/>` renders the restoring view in
    // this state.
    let (phase, set_phase) = create_signal(AuthPhase::Restoring);
    let auth_state = AuthState { phase, set_phase };
    provide_context(auth_state);

    // WS platform primitive — connects on `SignedIn`, runs the
    // protocol handshake, drives `ConnectionStatus.connected`.
    // Lives at App root so every tile (current and future)
    // sees the same connection. See `crate::ws` for the
    // platform-vs-tile-feature framing.
    ws::install(auth_state, connection_status);

    // Tile layout — the single state atom for what's rendered
    // in the post-auth view. Empty until the user signs in;
    // an effect below seeds the bootstrap default when
    // `phase` flips to `SignedIn`. Persistence (load from
    // localStorage / server-side at mount, save on change) is
    // a future slice's job.
    let layout = create_rw_signal(TileLayout::empty());
    provide_context(LayoutState { layout });

    create_effect(move |_| {
        // Seed once, on the first SignedIn transition with an
        // empty layout. The `tiles.is_empty()` guard means
        // re-firing this effect after the layout has been
        // populated is a safe no-op.
        //
        // **Logout-clear obligation**: when a future logout
        // slice writes `set_phase.set(SignedOut)`, it must
        // ALSO write `layout.set(TileLayout::empty())` so the
        // next sign-in re-seeds. Without that, a second
        // sign-in cycle would inherit the stale tiles from
        // the previous session — including any session-ids
        // that no longer exist on the server.
        if matches!(phase.get(), AuthPhase::SignedIn)
            && layout.with(|l| l.tiles.is_empty())
        {
            layout.set(TileLayout::bootstrap_default());
        }
    });

    // Fire the probe once on mount. We don't use
    // `create_action` because there's no input and no need
    // to expose pending/result state to the component tree —
    // the auth signal IS the result. On error (network
    // failure, server misbehaving), default to `SignedOut`
    // so the user lands on the login form rather than
    // getting stuck on "restoring…" forever; a `console.warn`
    // surfaces the actual failure for dev triage without
    // putting it in the user-visible string.
    spawn_local(async move {
        match probe_auth_status().await {
            // Branch order matters: the `authenticated &&
            // !has_credentials` case is the fresh-install-on-
            // localhost path (auto-auth gives `authenticated`
            // before any credential exists). Routing it to
            // `SignedIn` would land the user on the terminal
            // stub with no path back to the register flow;
            // routing to `SignedOut` would show the login
            // form with no credentials to sign in against.
            // The dedicated `Register` phase is what makes
            // this state representable.
            Ok(status) if status.authenticated && !status.has_credentials => {
                set_phase.set(AuthPhase::Register);
            }
            Ok(status) if status.authenticated => set_phase.set(AuthPhase::SignedIn),
            Ok(_) => set_phase.set(AuthPhase::SignedOut),
            Err(message) => {
                web_sys::console::warn_1(
                    &format!("katulong: auth status probe failed: {message}").into(),
                );
                set_phase.set(AuthPhase::SignedOut);
            }
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
    let ConnectionStatus { connected, .. } = expect_context();
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
            {move || match auth.phase.get() {
                AuthPhase::Restoring => view! { <SessionRestoring/> }.into_view(),
                AuthPhase::Register => view! { <Register/> }.into_view(),
                AuthPhase::SignedOut => view! { <Login/> }.into_view(),
                AuthPhase::SignedIn => view! { <TileHost/> }.into_view(),
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

