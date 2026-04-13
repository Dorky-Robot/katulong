/**
 * Localhost Browser Tile Renderer — single-file renderer, no factory layer.
 *
 * Embeds an iframe pointing at /_proxy/<port>/ to preview a localhost
 * service through Katulong's authenticated reverse proxy. The user
 * enters a port number (or restores from props) and the tile streams
 * the proxied content.
 *
 * Props:  { port?: string }
 * Persistence: only once a port is connected.
 */

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
            .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const localhostBrowserRenderer = {
  type: "localhost-browser",

  init(_deps) {},

  describe(props) {
    const port = props.port || "";
    return {
      title: port ? `localhost:${port}` : "Browser",
      icon: "globe-simple",
      persistable: !!port,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    let currentPort = props.port || "";
    let iframe = null;

    // --- DOM ---
    const root = document.createElement("div");
    root.className = "lb-tile-root";

    const toolbar = document.createElement("div");
    toolbar.className = "lb-tile-toolbar";
    toolbar.innerHTML = `
      <div class="lb-tile-toolbar-form">
        <label class="lb-tile-label" for="lb-port-${id}">Port</label>
        <input class="lb-tile-port-input" id="lb-port-${id}" type="text"
          inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 7070"
          maxlength="5" value="${escapeAttr(currentPort)}">
        <button class="lb-tile-btn lb-tile-go-btn" aria-label="Connect">Go</button>
      </div>
      <div class="lb-tile-toolbar-actions">
        <button class="lb-tile-btn lb-tile-refresh-btn" aria-label="Refresh" disabled>
          <i class="ph ph-arrow-clockwise"></i>
        </button>
        <button class="lb-tile-btn lb-tile-open-btn" aria-label="Open in new tab" disabled>
          <i class="ph ph-arrow-square-out"></i>
        </button>
      </div>
    `;
    root.appendChild(toolbar);

    const content = document.createElement("div");
    content.className = "lb-tile-content";
    root.appendChild(content);

    el.appendChild(root);

    // --- Refs ---
    const portInput = toolbar.querySelector(".lb-tile-port-input");
    const goBtn = toolbar.querySelector(".lb-tile-go-btn");
    const refreshBtn = toolbar.querySelector(".lb-tile-refresh-btn");
    const openBtn = toolbar.querySelector(".lb-tile-open-btn");

    // --- Handlers ---
    function connect() {
      const port = portInput.value.trim();
      if (!port || !/^\d+$/.test(port)) return;
      const num = parseInt(port, 10);
      if (num < 1 || num > 65535) return;

      currentPort = port;
      dispatch({ type: "ui/UPDATE_PROPS", id, patch: { port } });

      content.innerHTML = "";
      iframe = document.createElement("iframe");
      iframe.className = "lb-tile-iframe";
      iframe.src = `/_proxy/${port}/`;
      iframe.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms allow-popups");
      content.appendChild(iframe);

      refreshBtn.disabled = false;
      openBtn.disabled = false;

      showPlaceholder(false);
    }

    function showPlaceholder(show) {
      let ph = content.querySelector(".lb-tile-placeholder");
      if (show && !ph) {
        ph = document.createElement("div");
        ph.className = "lb-tile-placeholder";
        ph.innerHTML = `
          <i class="ph ph-globe-simple" style="font-size: 2rem; opacity: 0.3;"></i>
          <p>Enter a port number to preview a localhost service.</p>
        `;
        content.appendChild(ph);
      } else if (!show && ph) {
        ph.remove();
      }
    }

    goBtn.addEventListener("click", connect);
    portInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); connect(); }
    });
    refreshBtn.addEventListener("click", () => {
      if (iframe) iframe.src = iframe.src;
    });
    openBtn.addEventListener("click", () => {
      if (currentPort) window.open(`/_proxy/${currentPort}/`, "_blank");
    });

    // Auto-connect if restored with a port
    if (currentPort) {
      connect();
    } else {
      showPlaceholder(true);
    }

    // --- Handle ---
    return {
      unmount() { el.innerHTML = ""; },
      focus() { if (portInput && !currentPort) portInput.focus(); },
      blur() {},
      resize() {},
      getSessions() { return []; },
      tile: null,
    };
  },
};
