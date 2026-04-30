/**
 * Sipag Tile Renderer — embeds sipag's web UI in a katulong tile.
 *
 * Sipag is the dorky-robot stack's OKR / observation board. It runs as
 * a separate process (Rust + maud + HTMX) and exposes its UI at
 * either a same-host reverse-proxy path (e.g. `/_proxy/7100/`) or its
 * public tunnel URL — whichever is configured via katulong's
 * `sipagUrl` config.
 *
 * Why a dedicated tile instead of the generic localhost-browser?
 *  1. Sipag's "live activity" tray contains links to katulong sessions
 *     across hosts — `https://katulong-X.felixflor.es/?s=<name>`. The
 *     localhost-browser tile's iframe sandbox lacks
 *     `allow-top-navigation-by-user-activation`, so cross-origin link
 *     clicks die silently. This renderer adds it (user-initiated only,
 *     so non-user JS in the iframe still can't hijack the top window).
 *  2. URL comes from katulong's config API (`/api/config` →
 *     `sipagUrl`), not a hard-coded constant. Set it once via
 *     `PUT /api/config/sipag-url` and every sipag tile across this
 *     katulong instance picks it up.
 *  3. Future hooks for richer integration (notification badges from
 *     sipag's pubsub, status-bar element, etc.) live naturally here.
 *
 * Forward-looking note: this renderer is expected to fold into the
 * `remote-tile` shape described in `docs/cross-instance-tiles.md`
 * once that lands. Until then it lives as its own type so the
 * sipag-specific UX is tractable; when `remote-tile` ships, this
 * becomes a configured `remote-tile` for `kind: "sipag-ui"` and
 * the bespoke renderer goes away.
 *
 * Props:  { url?: string }   — per-tile override of the configured URL.
 * Persistence: always (the URL is resolvable without user input).
 */

import { api } from "../api-client.js";

// Last-resort fallback when neither tile props nor katulong config has
// a sipagUrl set. Matches the most common deployment shape: sipag
// running on the same host as this katulong, on its default port.
// User can override via `katulong config set sipag-url …` or by
// editing the config file directly.
const FALLBACK_URL = "/_proxy/7100/";

export const sipagRenderer = {
  type: "sipag",

  init(_deps) {},

  describe(props) {
    return {
      title: "sipag",
      icon: "list-checks",
      persistable: true,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    let mounted = true;
    let currentUrl = (props && props.url) || null; // resolved below
    let iframe = null;

    // --- DOM ---
    const root = document.createElement("div");
    root.className = "lb-tile-root sipag-tile-root";

    const toolbar = document.createElement("div");
    toolbar.className = "lb-tile-toolbar sipag-tile-toolbar";
    // Build toolbar via createElement (no innerHTML) so tile tests can
    // querySelector the controls without re-implementing an HTML parser
    // in the test FakeElement, AND so accidental future template-string
    // injection of user input becomes impossible.
    const toolbarForm = document.createElement("div");
    toolbarForm.className = "lb-tile-toolbar-form sipag-tile-toolbar-form";
    const urlLabel = document.createElement("span");
    urlLabel.className = "sipag-tile-url";
    urlLabel.setAttribute("data-role", "url");
    urlLabel.textContent = "…";
    toolbarForm.appendChild(urlLabel);

    const toolbarActions = document.createElement("div");
    toolbarActions.className = "lb-tile-toolbar-actions";
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "lb-tile-btn lb-tile-refresh-btn";
    refreshBtn.setAttribute("aria-label", "Refresh");
    const refreshIcon = document.createElement("i");
    refreshIcon.className = "ph ph-arrow-clockwise";
    refreshBtn.appendChild(refreshIcon);
    const openBtn = document.createElement("button");
    openBtn.className = "lb-tile-btn lb-tile-open-btn";
    openBtn.setAttribute("aria-label", "Open in new tab");
    const openIcon = document.createElement("i");
    openIcon.className = "ph ph-arrow-square-out";
    openBtn.appendChild(openIcon);
    toolbarActions.appendChild(refreshBtn);
    toolbarActions.appendChild(openBtn);

    toolbar.appendChild(toolbarForm);
    toolbar.appendChild(toolbarActions);
    root.appendChild(toolbar);

    const content = document.createElement("div");
    content.className = "lb-tile-content";
    root.appendChild(content);

    el.appendChild(root);

    function setUrlLabel(url) {
      urlLabel.textContent = url;
      urlLabel.title = url;
    }

    function connect(url) {
      if (!mounted) return;
      currentUrl = url;
      setUrlLabel(url);
      content.innerHTML = "";
      iframe = document.createElement("iframe");
      iframe.className = "lb-tile-iframe sipag-tile-iframe";
      iframe.src = url;
      // `allow-top-navigation-by-user-activation` is the critical delta
      // from the localhost-browser tile: it lets a user-clicked <a href>
      // inside sipag navigate the top window to e.g. a katulong session
      // URL across origins. Without it, sipag's "live activity" links
      // silently fail when sipag is rendered inside this tile. Non-user
      // JS still can't break out — top-nav requires transient activation.
      iframe.setAttribute(
        "sandbox",
        "allow-same-origin allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
      );
      content.appendChild(iframe);
    }

    refreshBtn.addEventListener("click", () => {
      if (iframe) iframe.src = iframe.src;
    });
    openBtn.addEventListener("click", () => {
      if (currentUrl) window.open(currentUrl, "_blank", "noopener,noreferrer");
    });

    // Resolution order:
    //   1. Per-tile prop (explicit override on this specific tile)
    //   2. katulong config `sipagUrl`  (instance-wide setting via
    //      `katulong config set sipag-url …` or `PUT /api/config/sipag-url`)
    //   3. FALLBACK_URL (`/_proxy/7100/`)
    //
    // Doing the config fetch async means the iframe takes one extra
    // tick to mount, but in exchange a single config edit reconfigures
    // every sipag tile users have open without any per-tile editing.
    if (currentUrl) {
      connect(currentUrl);
    } else {
      api.get("/api/config")
        .then((resp) => {
          const cfg = resp && resp.config ? resp.config : {};
          const url = cfg.sipagUrl || FALLBACK_URL;
          if (mounted) connect(url);
        })
        .catch(() => {
          if (mounted) connect(FALLBACK_URL);
        });
    }

    return {
      unmount() { mounted = false; el.innerHTML = ""; },
      focus() {},
      blur() {},
      resize() {},
      getSessions() { return []; },
      tile: null,
    };
  },
};
