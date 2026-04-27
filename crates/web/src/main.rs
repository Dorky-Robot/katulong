// Leptos shell — slice 9q.
//
// Layout primitives (header + main) replace the slice-9o
// hello-world `<main>`. The shell is intentionally a frame
// with NO real content yet: subsequent slices fill `<Main/>`
// with login → terminal → tile-grid as those land. The
// Header carries a connection-status signal that future
// slices will wire to the WS attach state; today it's
// hardcoded to `false` so the visible truth ("disconnected")
// matches the actual state.
//
// FP-leaning per memory `feedback_rewrite_fp_direction`: the
// shell is built from small pure components composed into a
// tree. Connection state lives in a single signal provided
// at the App root and consumed via context — no global
// mutable state, no scattered RwSignal allocations across
// components.

use leptos::*;

fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(|| view! { <App/> });
}

/// Reactive connection-state signal exposed to descendants
/// via context. `false` until a future slice wires the WS
/// attach handshake to flip it.
#[derive(Copy, Clone)]
struct ConnectionStatus(ReadSignal<bool>);

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
    // Placeholder content. Replaced by:
    //   - slice 9r: <Login/> when no session cookie
    //   - slice 9s: <Terminal/> when authenticated
    //   - slice 9t+: tile grid
    view! {
        <main id="kat-main">
            <p>"Rust + Leptos rewrite — shell ready, content pending."</p>
        </main>
    }
}
