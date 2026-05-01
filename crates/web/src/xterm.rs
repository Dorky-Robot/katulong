//! Minimal `wasm-bindgen` FFI to xterm.js + the FitAddon.
//!
//! We import only the surface the terminal tile needs today —
//! constructor, `open`, `write`, `onData`, `resize`, dim
//! getters, `loadAddon`, and `dispose`. Future slices may add
//! `clear`, `reset`, `attachCustomKeyEventHandler` (for
//! Cmd+V interception once the clipboard bridge port lands),
//! `serialize` / `selection` / `search`, and the WebGL,
//! ClipboardAddon, and SearchAddon constructors. Keep this file
//! tight: each `#[wasm_bindgen]` extern adds bytes to the bundle
//! even when unused, because wasm-bindgen emits a JS shim per
//! method.
//!
//! **Module path discipline.** The two `raw_module = "/xterm/..."`
//! attributes are absolute browser paths, not Rust module
//! names. `raw_module` (vs. `module`) tells wasm-bindgen NOT
//! to read the JS file at compile time — the path is preserved
//! verbatim in the generated `import { ... } from "..."`
//! statement and resolved by the browser's ES module loader at
//! runtime. Trunk's `copy-dir` directive in `index.html` lands
//! the vendored assets under `dist/xterm/`, so `/xterm/...`
//! resolves to a 200. If the path stops matching the trunk
//! drop location the import fails at runtime with a 404 and
//! the WASM bundle hangs at `Terminal::new` — there is no
//! compile-time check. Same constraint as the JS frontend's
//! `import { Terminal } from "/vendor/xterm/xterm.esm.js"` —
//! the URL space is the contract.
//!
//! **Why a thin wrapper, not the `xterm-js-rs` crate.** The
//! published `xterm-js-rs` crate is unmaintained (last release
//! 2023) and pins to xterm 4.x; we ship 5.5+ via the vendored
//! ESM. The full xterm API surface is also wider than we need —
//! ~30 methods we'll never call. A 60-line hand-rolled shim
//! is cheaper than auditing and patching a stale crate.
//!
//! **No `Drop` for `Terminal`.** xterm's `dispose()` is the
//! cleanup; we expose it as `Terminal::dispose(&self)` for
//! callers who hold a long-lived terminal in `store_value`. The
//! tile component drops the `Terminal` JsValue when it
//! unmounts, but the underlying xterm instance only releases
//! its internal allocations once `dispose` is called. The tile
//!'s mount-time RAII calls it in the cleanup closure.

use wasm_bindgen::prelude::*;
use web_sys::Element;

// vendor-path contract: `/xterm/` is also referenced in
// `crates/web/index.html` (trunk `copy-dir`) and on the
// sibling addon-fit extern below. If the URL prefix changes,
// update all three. Searchable sentinel for grep:
// `vendor-path:/xterm/`.
#[wasm_bindgen(raw_module = "/xterm/xterm.esm.js")]
extern "C" {
    /// xterm.js terminal emulator. Construct via [`Terminal::new`],
    /// then `open` it on a DOM node to render. Bytes pushed via
    /// `write` go through the internal stateful UTF-8 decoder +
    /// ANSI parser — DO NOT pre-decode bytes to a Rust `String`;
    /// multi-byte chars split across PTY chunks would produce
    /// U+FFFD.
    ///
    /// `Clone` is shallow — clones share the same underlying
    /// JS object reference, which is what we want when handing
    /// the terminal to multiple subscriber callbacks. wasm-
    /// bindgen does NOT auto-derive `Clone`; the explicit
    /// `#[derive(Clone)]` below is required for `term.clone()`
    /// to call into the JsValue's clone-as-`Self` impl rather
    /// than the JsValue Deref's clone-as-`JsValue`.
    ///
    /// **No `new_with_options` extern.** The configurable-options
    /// constructor is omitted until a caller actually needs to
    /// pass options — the wasm-bindgen shim adds bytes to the
    /// bundle even when unused. When a future slice wants
    /// `fontFamily`, `theme`, `scrollback`, etc., add a second
    /// extern constructor (`new_with_options(opts: &JsValue) ->
    /// Terminal`) and pass a `js_sys::Object` or
    /// `serde_wasm_bindgen::to_value` from the call site.
    #[derive(Clone)]
    pub type Terminal;

    #[wasm_bindgen(constructor)]
    pub fn new() -> Terminal;

    /// Mount the terminal into the given DOM element. The
    /// element must be visible (`display != none`, non-zero
    /// dimensions) when `open` runs — otherwise xterm falls
    /// back to its 80×24 default until the next manual resize.
    #[wasm_bindgen(method)]
    pub fn open(this: &Terminal, parent: &Element);

    /// Write bytes to the terminal. Accepts `Uint8Array` (raw
    /// PTY bytes, what we always pass) OR a JS string. xterm
    /// maintains an internal stateful decoder, so partial
    /// UTF-8 sequences across consecutive `write` calls are
    /// buffered correctly.
    #[wasm_bindgen(method)]
    pub fn write(this: &Terminal, data: &[u8]);

    /// Subscribe to keystroke / paste events. The callback
    /// receives a UTF-8 `String` of the bytes the user typed
    /// (xterm pre-encodes input — `Enter` becomes `"\r"`,
    /// arrow keys become CSI sequences, etc.). Returns an
    /// `IDisposable` whose `dispose()` detaches the listener.
    /// Hold both the `Closure` and the disposable for the
    /// terminal's lifetime; dropping either silently un-wires
    /// input.
    #[wasm_bindgen(method, js_name = onData)]
    pub fn on_data(this: &Terminal, cb: &Closure<dyn FnMut(String)>) -> JsValue;

    /// Resize the terminal grid. Triggers an `ITerminalApi`
    /// reflow + the xterm `onResize` event (which our app
    /// doesn't subscribe to today — the server-side resize is
    /// driven by our own `Resize` wire message).
    #[wasm_bindgen(method)]
    pub fn resize(this: &Terminal, cols: u32, rows: u32);

    #[wasm_bindgen(method, getter)]
    pub fn cols(this: &Terminal) -> u32;

    #[wasm_bindgen(method, getter)]
    pub fn rows(this: &Terminal) -> u32;

    /// Attach the FitAddon. xterm's addon registry is
    /// structurally typed (any `{ activate, dispose }` pair
    /// works), so a future slice that wires up additional
    /// addons (WebGL, Search, Clipboard) declares its own
    /// `load_*` overload here rather than threading a
    /// `&JsValue` upcast through every call site. Slice 9s.4
    /// only needs the fit addon.
    #[wasm_bindgen(method, js_name = loadAddon)]
    pub fn load_fit_addon(this: &Terminal, addon: &FitAddon);

    /// Cleanup — destroys the DOM, detaches listeners, and
    /// frees xterm's internal renderer buffers. Required on
    /// tile unmount to avoid leaking the per-terminal canvases.
    #[wasm_bindgen(method)]
    pub fn dispose(this: &Terminal);

    /// Move keyboard focus into the terminal. Required after
    /// mounting because xterm's `helper-textarea` is positioned
    /// at the cursor and only receives keystrokes when focused.
    #[wasm_bindgen(method)]
    pub fn focus(this: &Terminal);
}

// vendor-path:/xterm/ — see the sibling Terminal extern above.
#[wasm_bindgen(raw_module = "/xterm/addon-fit.esm.js")]
extern "C" {
    /// Computes a `(cols, rows)` pair from the terminal's
    /// containing element and resizes the terminal to match.
    /// Matches the standard xterm.js fit pattern. Cheaper than
    /// the Node frontend's custom `scaleToFit` (which also
    /// rescales font size to perfectly fill the width) — we
    /// pick the simpler addon for slice 9s.4 and revisit fit
    /// quality as a separate slice if the default rounding
    /// creates visible gutters.
    ///
    /// `Clone` is required because the ResizeObserver callback
    /// reaches into the addon to call `fit()` — same shallow
    /// JsValue clone semantics as `Terminal`.
    #[derive(Clone)]
    pub type FitAddon;

    #[wasm_bindgen(constructor)]
    pub fn new() -> FitAddon;

    /// Compute proposed dimensions and resize the terminal to
    /// match the containing element.
    #[wasm_bindgen(method)]
    pub fn fit(this: &FitAddon);
}
