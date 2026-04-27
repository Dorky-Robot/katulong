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
    // Slice 9r.1 lands the visual + URL-mode-switching part
    // of the login flow. The actual WebAuthn ceremony (calls
    // to `/api/auth/registration/begin` /
    // `navigator.credentials.create()` / etc.) lands in 9r.2.
    //
    // Today we always render `<Login/>` here — there's no
    // notion of "authenticated session" yet because no slice
    // has read the session cookie or the WS attach state.
    // Once 9r.2 lands, the post-success path will set a
    // signal that switches `<Main/>` to the (still-stub)
    // terminal view.
    view! {
        <main id="kat-main">
            <Login/>
        </main>
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
/// Slice 9r.1 only renders the form. The buttons currently
/// have no `on:click` handlers; 9r.2 wires the WebAuthn
/// ceremony.
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
    let cta = if is_pair_mode {
        "Pair with passkey"
    } else {
        "Sign in with passkey"
    };
    let blurb = if is_pair_mode {
        "Name this device and confirm with your passkey to add it to your account."
    } else {
        "Use your passkey to sign in."
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
            <button type="button" class="cta">{cta}</button>
        </section>
    }
}
