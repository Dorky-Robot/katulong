/**
 * Sipag Tile Renderer — embeds sipag's web UI in a katulong tile.
 *
 * Sipag is the dorky-robot stack's OKR / observation board. It runs as
 * a separate process (Rust + maud + HTMX) and exposes its UI at
 * `https://sipag.felixflor.es` (or the user-configured URL).
 *
 * Why a dedicated tile instead of the generic localhost-browser?
 *  1. Sipag's "live activity" tray contains links to katulong sessions
 *     across hosts — `https://katulong-X.felixflor.es/?s=<name>`. The
 *     localhost-browser tile's iframe sandbox lacks
 *     `allow-top-navigation-by-user-activation`, so cross-origin link
 *     clicks die silently. This renderer adds it (user-initiated only,
 *     so non-user JS in the iframe still can't hijack the top window).
 *  2. Default URL is sipag's tunnel hostname. No port input — sipag
 *     isn't a one-off localhost service.
 *  3. Future hooks for richer integration (notification badges from
 *     sipag's pubsub, status-bar element, etc.) live naturally here.
 *
 * Props:  { url?: string }   — defaults to https://sipag.felixflor.es
 * Persistence: always (the URL doesn't need user input to be useful).
 */

import { escapeAttr } from "../utils.js";

const DEFAULT_URL = "https://sipag.felixflor.es";

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
    let currentUrl = (props && props.url) || DEFAULT_URL;
    let iframe = null;

    // --- DOM ---
    const root = document.createElement("div");
    root.className = "lb-tile-root sipag-tile-root";

    const toolbar = document.createElement("div");
    toolbar.className = "lb-tile-toolbar sipag-tile-toolbar";
    toolbar.innerHTML = `
      <div class="lb-tile-toolbar-form sipag-tile-toolbar-form">
        <span class="sipag-tile-url" title="${escapeAttr(currentUrl)}">${escapeAttr(currentUrl)}</span>
      </div>
      <div class="lb-tile-toolbar-actions">
        <button class="lb-tile-btn lb-tile-refresh-btn" aria-label="Refresh">
          <i class="ph ph-arrow-clockwise"></i>
        </button>
        <button class="lb-tile-btn lb-tile-open-btn" aria-label="Open in new tab">
          <i class="ph ph-arrow-square-out"></i>
        </button>
      </div>
    `;
    root.appendChild(toolbar);

    const content = document.createElement("div");
    content.className = "lb-tile-content";
    root.appendChild(content);

    el.appendChild(root);

    const refreshBtn = toolbar.querySelector(".lb-tile-refresh-btn");
    const openBtn = toolbar.querySelector(".lb-tile-open-btn");

    function connect() {
      if (!mounted) return;
      content.innerHTML = "";
      iframe = document.createElement("iframe");
      iframe.className = "lb-tile-iframe sipag-tile-iframe";
      iframe.src = currentUrl;
      // `allow-top-navigation-by-user-activation` is the critical
      // delta from the localhost-browser tile: it lets a user-clicked
      // <a href> inside sipag navigate the top window to e.g. a
      // katulong session URL across origins. Without it, sipag's
      // "live activity" links silently fail when sipag is rendered
      // inside this tile. Non-user JS still can't break out — top-nav
      // requires a transient activation (a real click/tap).
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
      window.open(currentUrl, "_blank", "noopener,noreferrer");
    });

    connect();

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
