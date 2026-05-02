/**
 * Remote terminal tile — attaches to a tmux session on a *peer* katulong
 * instance over WebSocket. Bubble-gum spike for cross-instance tiles.
 *
 * Scope (deliberately tiny):
 *   - One xterm.Terminal in the tile.
 *   - One raw WebSocket to the peer's `/?api_key=<key>` endpoint.
 *   - Speaks the peer's existing protocol: attach, output (push),
 *     data-available, pull, pull-response, pull-snapshot, input, resize.
 *   - No drift detection, no transport upgrade, no reconnect, no carousel,
 *     no rename, no scrollback restore beyond what `attached` includes.
 *   - Future: this folds into the generalized `remote-tile` descriptor
 *     described in docs/cross-instance-tiles.md once that lands. Until
 *     then it lives as its own type so the spike stays legible.
 *
 * Props: { peerUrl: string, apiKey: string, session: string, label?: string }
 *   - peerUrl: absolute http(s) URL of the peer katulong (no trailing slash needed)
 *   - apiKey:  raw key string. Browsers can't set Authorization headers on
 *              `new WebSocket()`, so it is sent as a query param. The peer's
 *              isAuthenticated() picks it up and bypasses the origin check
 *              (api-key auth is the explicit cross-instance grant).
 *   - session: tmux session name on the peer
 *   - label:   optional display label; defaults to "<host> · <session>"
 *
 * Persistence: NOT persistable in this spike. The api-key would be written
 *              to ui-store and that crosses a trust boundary we haven't
 *              designed yet (see open question in the spec doc). When the
 *              full peer-link / swarm membership lands, the tile will
 *              persist `{ peerId, session }` and resolve the credential
 *              from a separate keystore.
 */

// Relative imports (rather than the conventional `/vendor/...`) so the
// node:test runner's mock.module loader can intercept them. Resolves to
// the same file in the browser. If you change the file's location in
// the tree, fix the relative path here AND the matching test mock.
import { Terminal } from "../../vendor/xterm/xterm.esm.js";
import { FitAddon } from "../../vendor/xterm/addon-fit.esm.js";

function buildWsUrl(peerUrl, apiKey) {
  // peerUrl may be http(s)://host[:port][/base]; rewrite scheme for ws
  // and append api_key. We intentionally do NOT use a path like /ws —
  // katulong's upgrade handler accepts upgrade on any non-/_proxy path.
  const u = new URL(peerUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // Preserve any base path the peer is mounted under, just like
  // public/lib/connection-manager.js#buildWsUrl does for same-origin.
  // Strip trailing slash so we don't end up with a double-slash path.
  if (u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  u.searchParams.set("api_key", apiKey);
  return u.toString();
}

function deriveLabel(peerUrl, session) {
  try {
    return `${new URL(peerUrl).host} · ${session}`;
  } catch {
    return session;
  }
}

export const remoteTerminalRenderer = {
  type: "remote-terminal",

  init(_deps) {},

  describe(props) {
    return {
      title: (props && props.label) || deriveLabel(props?.peerUrl || "", props?.session || ""),
      icon: "terminal-window",
      // Spike: not persistable — api key is in props and we don't want
      // it round-tripping through ui-store yet. See header note.
      persistable: false,
      session: null,         // session lives on the *peer*, not local
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { props }) {
    const { peerUrl, apiKey, session } = props || {};
    if (!peerUrl || !apiKey || !session) {
      el.textContent = "remote-terminal: missing peerUrl / apiKey / session";
      return { unmount() {}, focus() {}, blur() {}, resize() {}, getSessions() { return []; }, tile: null };
    }

    let mounted = true;
    let ws = null;
    let term = null;
    let fit = null;
    let lastSeq = 0;
    let sentInitialAttach = false;
    let resizeObserver = null;
    let pendingPull = false;

    // --- DOM ---
    const root = document.createElement("div");
    root.className = "lb-tile-root remote-terminal-tile-root";

    const status = document.createElement("div");
    status.className = "lb-tile-toolbar remote-terminal-status";
    const statusLabel = document.createElement("span");
    statusLabel.className = "remote-terminal-label";
    statusLabel.textContent = (props.label || deriveLabel(peerUrl, session));
    statusLabel.title = `${peerUrl} (session: ${session})`;
    const statusDot = document.createElement("span");
    statusDot.className = "remote-terminal-dot";
    statusDot.setAttribute("data-state", "connecting");
    statusDot.textContent = "•";
    status.appendChild(statusDot);
    status.appendChild(statusLabel);
    root.appendChild(status);

    const termHost = document.createElement("div");
    termHost.className = "remote-terminal-host";
    termHost.style.flex = "1 1 auto";
    termHost.style.minHeight = "0";
    root.appendChild(termHost);

    el.appendChild(root);

    function setStatus(state, msg) {
      statusDot.setAttribute("data-state", state);
      if (msg) statusLabel.textContent = `${props.label || deriveLabel(peerUrl, session)} — ${msg}`;
      else statusLabel.textContent = props.label || deriveLabel(peerUrl, session);
    }

    function send(msg) {
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore — onclose handles it */ }
    }

    function fitAndMaybeResize() {
      if (!term || !fit) return null;
      try { fit.fit(); } catch { return null; }
      const cols = term.cols, rows = term.rows;
      return { cols, rows };
    }

    // --- xterm ---
    term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      // Keep the initial size sane before fit runs; the peer reflows on resize.
      cols: 80,
      rows: 24,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    try { fit.fit(); } catch { /* parent may not have layout yet */ }

    term.onData((data) => {
      send({ type: "input", session, data });
    });

    // --- WebSocket ---
    let url;
    try { url = buildWsUrl(peerUrl, apiKey); }
    catch (err) {
      setStatus("error", `bad URL: ${err.message}`);
      return earlyHandle();
    }

    try { ws = new WebSocket(url); }
    catch (err) {
      setStatus("error", err.message);
      return earlyHandle();
    }

    ws.onopen = () => {
      if (!mounted) return;
      setStatus("connected");
      const dims = fitAndMaybeResize();
      const cols = dims?.cols || 80;
      const rows = dims?.rows || 24;
      send({ type: "attach", session, cols, rows });
      sentInitialAttach = true;
    };

    ws.onclose = (ev) => {
      if (!mounted) return;
      setStatus("disconnected", `closed (${ev.code})`);
    };

    ws.onerror = () => {
      if (!mounted) return;
      setStatus("error", "ws error");
    };

    ws.onmessage = (ev) => {
      if (!mounted) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case "attached":
          if (msg.data) term.write(msg.data);
          break;
        case "seq-init":
          if (typeof msg.seq === "number") lastSeq = msg.seq;
          break;
        case "output":
          // Server-pushed live data. cursor advances past msg.data.
          if (msg.data) term.write(msg.data);
          if (typeof msg.cursor === "number") lastSeq = msg.cursor;
          break;
        case "data-available":
          // Server says there's data we don't have. Send a pull from
          // our current cursor. Suppress duplicate in-flight pulls.
          if (pendingPull) break;
          pendingPull = true;
          send({ type: "pull", session, fromSeq: lastSeq });
          break;
        case "pull-response":
          pendingPull = false;
          if (msg.data) term.write(msg.data);
          if (typeof msg.cursor === "number") lastSeq = msg.cursor;
          break;
        case "pull-snapshot":
          // Cursor was evicted server-side; we lost the diff window. The
          // server sends a full pane snapshot to resync. Reset terminal
          // and write fresh. Bubble-gum: term.reset() is fine for spike.
          pendingPull = false;
          term.reset();
          if (msg.data) term.write(msg.data);
          if (typeof msg.cursor === "number") lastSeq = msg.cursor;
          break;
        case "exit":
          setStatus("disconnected", `peer session exited (${msg.code})`);
          break;
        case "error":
          setStatus("error", msg.message || "peer error");
          break;
        // Ignore everything else (state-check, session-updated, etc.) —
        // not needed for the spike.
      }
    };

    // --- Resize tracking ---
    resizeObserver = new ResizeObserver(() => {
      if (!mounted || !sentInitialAttach) return;
      const dims = fitAndMaybeResize();
      if (!dims) return;
      send({ type: "resize", session, cols: dims.cols, rows: dims.rows });
    });
    resizeObserver.observe(termHost);

    function earlyHandle() {
      return {
        unmount() { mounted = false; el.innerHTML = ""; },
        focus() {},
        blur() {},
        resize() {},
        getSessions() { return []; },
        tile: null,
      };
    }

    return {
      unmount() {
        mounted = false;
        if (resizeObserver) { try { resizeObserver.disconnect(); } catch {} resizeObserver = null; }
        if (ws) {
          try { ws.close(); } catch {}
          ws = null;
        }
        if (term) {
          try { term.dispose(); } catch {}
          term = null;
        }
        el.innerHTML = "";
      },
      focus() { try { term?.focus(); } catch {} },
      blur()  { try { term?.blur(); }  catch {} },
      resize() {
        const dims = fitAndMaybeResize();
        if (dims && sentInitialAttach) {
          send({ type: "resize", session, cols: dims.cols, rows: dims.rows });
        }
      },
      getSessions() { return []; },
      tile: null,
    };
  },
};
