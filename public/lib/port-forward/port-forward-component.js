/**
 * Port Forward Component
 *
 * Provides an iframe-based view of a localhost service proxied through
 * Katulong's /_proxy/<port>/ endpoint. Follows the file browser
 * mount/unmount/focus pattern.
 */

export function createPortForwardComponent(options = {}) {
  const { onClose } = options;
  let container = null;
  let iframe = null;
  let portInput = null;
  let currentPort = localStorage.getItem("portfwd-port") || "";

  function mount(el) {
    container = el;
    container.innerHTML = "";
    container.className = "port-forward";

    container.innerHTML = `
      <div class="pf-toolbar">
        <div class="pf-toolbar-form">
          <label class="pf-label" for="pf-port-input">Port</label>
          <input class="pf-port-input" id="pf-port-input" type="text" inputmode="numeric"
            pattern="[0-9]*" placeholder="e.g. 7070" maxlength="5"
            value="${escapeAttr(currentPort)}">
          <button class="pf-btn pf-go-btn" aria-label="Connect">Go</button>
        </div>
        <div class="pf-toolbar-actions">
          <button class="pf-btn pf-refresh-btn" aria-label="Refresh" disabled>
            <i class="ph ph-arrow-clockwise"></i>
          </button>
          <button class="pf-btn pf-open-btn" aria-label="Open in new tab" disabled>
            <i class="ph ph-arrow-square-out"></i>
          </button>
          <button class="pf-btn pf-close-btn" aria-label="Close">
            <i class="ph ph-x"></i>
          </button>
        </div>
      </div>
      <div class="pf-content">
        <div class="pf-placeholder">
          <i class="ph ph-plug" style="font-size: 2rem; opacity: 0.3;"></i>
          <p>Enter a port number to preview a localhost service.</p>
        </div>
      </div>
    `;

    portInput = container.querySelector(".pf-port-input");
    const goBtn = container.querySelector(".pf-go-btn");
    const refreshBtn = container.querySelector(".pf-refresh-btn");
    const openBtn = container.querySelector(".pf-open-btn");
    const closeBtn = container.querySelector(".pf-close-btn");

    goBtn.addEventListener("click", () => connect());
    portInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        connect();
      }
    });
    refreshBtn.addEventListener("click", () => {
      if (iframe) {
        iframe.src = iframe.src; // reload
      }
    });
    openBtn.addEventListener("click", () => {
      if (currentPort) {
        window.open(`/_proxy/${currentPort}/`, "_blank");
      }
    });
    if (closeBtn && onClose) closeBtn.addEventListener("click", onClose);

    // If we had a port from last session, auto-connect
    if (currentPort) {
      connect();
    }
  }

  function connect() {
    if (!container) return;
    const port = portInput.value.trim();
    if (!port || !/^\d+$/.test(port)) return;

    const num = parseInt(port, 10);
    if (num < 1 || num > 65535) return;

    currentPort = port;
    localStorage.setItem("portfwd-port", port);

    const contentEl = container.querySelector(".pf-content");
    contentEl.innerHTML = "";

    iframe = document.createElement("iframe");
    iframe.className = "pf-iframe";
    iframe.src = `/_proxy/${port}/`;
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms allow-popups");
    contentEl.appendChild(iframe);

    // Enable action buttons
    container.querySelector(".pf-refresh-btn").disabled = false;
    container.querySelector(".pf-open-btn").disabled = false;
  }

  function unmount() {
    iframe = null;
    portInput = null;
    container = null;
  }

  function focus() {
    if (portInput && !currentPort) {
      portInput.focus();
    }
  }

  return { mount, unmount, focus };
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
