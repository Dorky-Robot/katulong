// Leptos shell.
//
// Slice 9q: layout primitives (header + main).
// Slice 9r.1: <Login/> form shell with URL-based mode switch.
// Slice 9r.2: sign-in WebAuthn ceremony wired to the API.
//   Login + ceremony moved to `login.rs` — this file owns
//   only the shell layout, the App-root signal contexts, and
//   the auth-state-driven swap in <Main/>.
//
// FP-leaning per memory `feedback_rewrite_fp_direction`: the
// shell is built from small pure components composed into a
// tree. Auth + connection state live in signals provided at
// the App root; the ceremony itself is a pure async function
// (`login::signin`) that returns a `Result` — the component
// just dispatches it via `create_action` and reacts to the
// resolved value. No scattered globals, no callbacks-on-
// callbacks.

use leptos::*;

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
pub struct AuthState {
    pub signed_in: ReadSignal<bool>,
    pub set_signed_in: WriteSignal<bool>,
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
