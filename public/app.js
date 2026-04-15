    import { ModalRegistry } from "/lib/modal.js";
    import { createTerminalPool } from "/lib/terminal-pool.js";
    import {
      createSessionStore, invalidateSessions,
      createTokenStore, setNewToken, invalidateTokens, removeToken, loadTokens as reloadTokens,
      createShortcutsStore, loadShortcuts as reloadShortcuts,
    } from "/lib/stores.js";
    import { createSessionListComponent, updateSnapshot } from "/lib/session-list-component.js";
    import { api, resolveSessionId, invalidateSessionIdCache } from "/lib/api-client.js";
    import { createTokenListComponent } from "/lib/token-list-component.js";
    import { createTokenFormManager } from "/lib/token-form.js";
    import { createShortcutsPopup, createShortcutsEditPanel, createAddShortcutModal } from "/lib/shortcuts-components.js";
    import { createDictationModal } from "/lib/dictation-modal.js";
    import { createDragDropManager } from "/lib/drag-drop.js";
    import { showToast, isImageFile, uploadImageToTerminal as uploadImageToTerminalFn, uploadImagesToTerminal as uploadImagesToTerminalFn, onPasteComplete } from "/lib/image-upload.js";
    import { createJoystickManager } from "/lib/joystick.js";
    import { attachTouchSelect } from "/lib/touch-select.js";

    import { createThemeManager } from "/lib/theme-manager.js";
    import { DEFAULT_COLS, TERMINAL_ROWS_DEFAULT } from "/lib/terminal-config.js";
    import { createTabManager } from "/lib/tab-manager.js";
    import { isAtBottom, scrollToBottom, withPreservedScroll, terminalWriteWithScroll, initScrollTracking, initTouchScroll } from "/lib/scroll-utils.js";
    import { keysToSequence, sendSequence, displayKey, keysLabel, keysString, VALID_KEYS, normalizeKey } from "/lib/key-mapping.js";
    import { createShortcutBar } from "/lib/shortcut-bar.js";
    import { createCommandMode } from "/lib/command-mode.js";
    import { createCommandSurface } from "/lib/command-surface.js";
    import { buildCommandTree } from "/lib/command-tree.js";
    import { openCommandPicker } from "/lib/command-picker.js";
    import { createWindowTabSet } from "/lib/window-tab-set.js";
    import { createPasteHandler } from "/lib/paste-handler.js";
    import { createSettingsHandlers } from "/lib/settings-handlers.js";
    import { createTerminalKeyboard } from "/lib/terminal-keyboard.js";
    import { decideAppKey, isTextInputTarget } from "/lib/app-keyboard.js";
    import { createInputSender } from "/lib/input-sender.js";
    import { createViewportManager } from "/lib/viewport-manager.js";
    import { createConnectionManager } from "/lib/connection-manager.js";
    import { wsMessageHandlers } from "/lib/ws-message-handlers.js";
    import { createPullManager } from "/lib/pull-manager.js";
    import { screenFingerprint } from "/lib/screen-fingerprint.js";
    import { createWebRTCPeer } from "/lib/webrtc-peer.js";

    import { createNotepad } from "/lib/notepad.js";
    import { createCardCarousel, parseLegacyCarouselStorage } from "/lib/card-carousel.js";
    import { createTerminalTileFactory } from "/lib/tiles/terminal-tile.js";
    import { createClusterTileFactory } from "/lib/tiles/cluster-tile.js";
    import { createFileBrowserTileFactory } from "/lib/tiles/file-browser-tile.js";
    import { dispatchNotification } from "/lib/notify.js";
    import { createUiStore, loadFromStorage, EMPTY_STATE } from "/lib/ui-store.js";
    import { buildBootState } from "/lib/boot-state.js";
    import { createAddHandler, generateSessionName } from "/lib/add-target.js";
    import { createPinchGesture } from "/lib/pinch-gesture.js";
    import { createClusterStrips } from "/lib/cluster-strips.js";
    import { initRenderers, isPersistable, getRenderer } from "/lib/tile-renderers/index.js";
    import { createTileHost } from "/lib/tile-host.js";
    import { getFocusedSession, selectClusterView } from "/lib/selectors.js";
    import { navigateTab as computeNavigateTab, moveTab as computeMoveTab, jumpToTab as computeJumpToTab } from "/lib/navigation.js";
    import { createIconStore } from "/lib/icon-store.js";
    import { createReconcilerStore } from "/lib/reconciler-store.js";
    import { escapeHtml, escapeAttr } from "/lib/utils.js";

    // --- Modal Manager ---
    const modals = new ModalRegistry();

    // Modal registration imported from /lib/modal-init.js

    // --- Palette (derives UI CSS vars + xterm theme from a single anchor) ---
    // createThemeManager() reads {anchor, polarity} from localStorage,
    // generates the palette synchronously, and applies all CSS vars to
    // :root before the first paint — so there is no flash. The callback
    // fires again on anchor/polarity changes and on OS light/dark flips
    // when polarity is "auto".
    //
    // settingsHandlers is declared later (it depends on themeManager), so
    // we hold the reference in a closure-captured `let` and the callback
    // late-binds.
    let settingsHandlers = null;
    const themeManager = createThemeManager({
      onThemeChange: (xtermTheme) => {
        terminalPool.forEach((name, entry) => {
          withPreservedScroll(entry.term, () => {
            entry.term.options.theme = xtermTheme;
          });
        });
        // Re-sync palette controls (tint swatch, hex input, polarity, vibrancy)
        // so the settings panel reflects the new effective palette.
        if (settingsHandlers) settingsHandlers.syncPaletteControls();
      }
    });

    // --- State ---

    // URL ?s= hint — used only for boot, not as ongoing state.
    const explicitSession = new URLSearchParams(location.search).get("s");

    // scrolledUpBeforeDisconnect now lives in the connection store
    // (accessed via cm.setScrolledUp / cm.getState().scrolledUpBeforeDisconnect).

    // Derive the active session name from ui-store + renderer registry.
    // Replaces the old mutable `state.session.name` — the source of truth
    // is now uiStore.focusedId, and the session name is a derived value.
    // Late-bound: _uiStore is assigned when createUiStore() runs below.
    let _uiStore = null;
    const getActiveSessionName = () => {
      if (!_uiStore) return null;
      return getFocusedSession(_uiStore.getState(), getRenderer);
    };

    let shortcutBarInstance = null;

    // --- Per-session tab icon overrides ---
    const iconStore = createIconStore();

    // --- Shortcuts state management (reactive store) ---
    const shortcutsStore = createShortcutsStore();
    const loadShortcuts = () => reloadShortcuts(shortcutsStore);

    // Subscribe to shortcuts changes for render side effects
    // Note: shortcuts store subscription moved after renderBar is defined (line ~640)

    // Connection indicator is now driven by cm.subscribe() — see below.

    // --- Instance label ---
    // Show the page hostname verbatim in the sidebar footer + browser tab
    // title so two katulong instances behind different tunnels (e.g.
    // katulong-mini.felixflor.es and katulong-prime.felixflor.es) can be
    // distinguished at a glance. We previously tried to derive a short
    // pretty label by splitting on dashes, but that locked in one specific
    // naming convention; the raw hostname is operator-controlled and
    // unambiguous in every case.
    const INSTANCE_HOST = window.location.hostname || "";

    const instanceLabelEl = document.getElementById("sidebar-instance-label");
    if (instanceLabelEl && INSTANCE_HOST) {
      instanceLabelEl.textContent = INSTANCE_HOST;
      instanceLabelEl.title = INSTANCE_HOST;
    }

    // Wrap document.title assignments so the hostname suffix is always
    // present in the browser tab. The page title is otherwise replaced
    // (with the active session name or "katulong") on every session
    // switch, which would otherwise wipe the instance hint. Order is
    // `session · hostname` rather than `hostname · session` so that the
    // session name (the primary identifier) survives crowded-tab
    // truncation; the hostname is a disambiguator and is acceptable to
    // crop first.
    const setDocTitle = (name) => {
      const base = name || "katulong";
      document.title = INSTANCE_HOST ? `${base} · ${INSTANCE_HOST}` : base;
    };

    setDocTitle(explicitSession);

    // --- Terminal pool ---
    // One xterm.js Terminal per managed session, visibility-toggled on switch.

    // _uiStore is also used by onFileLinkClick below — both closures
    // share the same late-bound ref, assigned when createUiStore() runs.

    const terminalPool = createTerminalPool({
      parentEl: document.getElementById("terminal-container"),
      onResize: (sessionName, cols, rows) => {
        cm.send(JSON.stringify({ type: "resize", session: sessionName, cols, rows }));
      },
      onFileLinkClick: async (_event, filePath) => {
        if (!_uiStore) return;
        // Defense-in-depth: reject paths with traversal segments
        if (filePath.split("/").some(seg => seg === "..")) return;
        // Resolve relative paths against the active session's CWD
        let resolved = filePath;
        if (!filePath.startsWith("/")) {
          const sessionName = getActiveSessionName();
          if (sessionName) {
            try {
              const data = await api.get(`/sessions/cwd/${encodeURIComponent(sessionName)}`);
              if (data.cwd && data.cwd.startsWith("/")) resolved = data.cwd + "/" + filePath;
            } catch { /* fall through with relative path */ }
          }
        }
        const docId = `doc-${Date.now().toString(36)}`;
        _uiStore.addTile(
          { id: docId, type: "document", props: { filePath: resolved } },
          { focus: true, insertAt: "afterFocus" },
        );
      },
      terminalOptions: {
        cols: DEFAULT_COLS,
        rows: TERMINAL_ROWS_DEFAULT,
        fontSize: 14,
        fontFamily: "'JetBrainsMono NF', 'JetBrains Mono', 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
        theme: themeManager.getPalette().xterm,
        // Required for theme.background alpha to take effect. Lets card-face
        // (carousel) or #terminal-container (non-carousel) paint the backdrop
        // so the terminal area stays one uniform color with its tile.
        allowTransparency: true,
        cursorBlink: true,
        scrollback: 10000,
        convertEol: true,
        macOptionIsMeta: true,
        minimumContrastRatio: 4.5,
        cursorInactiveStyle: 'none',
        rightClickSelectsWord: true,
        rescaleOverlappingGlyphs: true,
      },
      onTerminalCreated: (sessionName, entry) => {
        // Wire up keyboard handler for each new terminal
        // Uses late-bound rawSend — safe because onTerminalCreated is only
        // called from activate() which first runs after rawSend is defined.
        const kb = createTerminalKeyboard({
          term: entry.term,
          onSend: (data) => rawSend(data),
          onToggleSearch: toggleSearchBar
        });
        kb.init();

        // Auto-copy: when the user finishes selecting text (mouse-up or
        // touch-end), copy it to the system clipboard.  On desktop this saves
        // a Ctrl+C; on mobile it works around canvas-based selection that the
        // native "Copy" menu can't read.
        entry.term.onSelectionChange(() => {
          const sel = entry.term.getSelectionPosition();
          const text = entry.term.getSelection();
          if (!text || !sel) return;

          // Unwrap application-level line breaks that were inserted to fit
          // the terminal width. The terminal buffer's isWrapped flag only
          // catches terminal-level soft wraps, but apps like Claude Code
          // insert their own \n for word-wrapping. Heuristic: if a trimmed
          // line reaches close to the terminal column width (within 2 chars),
          // it was probably wrapped and should be joined with a space. Lines
          // significantly shorter are real paragraph breaks.
          const cols = entry.term.cols;
          const buf = entry.term.buffer.active;
          const lines = text.split("\n");
          let result = "";
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trimEnd();
            if (i === 0) {
              result = line;
              continue;
            }
            const bufRow = sel.start.y + i;
            const bufLine = buf.getLine(bufRow);
            // Terminal-level soft wrap — join directly (no space)
            if (bufLine?.isWrapped) {
              result += line;
              continue;
            }
            // App-level wrap heuristic: if the previous line is "long enough"
            // and the current line starts with a non-empty continuation,
            // it's probably word-wrapped. Apps like Claude Code wrap well
            // before the terminal column limit (they add margins), so we
            // can't use cols as the threshold. Instead: if the previous
            // line has 40+ chars and the next line is non-empty and doesn't
            // look like a list item or new section, join with space.
            const prevLine = lines[i - 1].trimEnd();
            const looksLikeContinuation = line.length > 0
              && !/^\s*[-*>•▸▹❯›\d]/.test(line)  // not a list/prompt
              && !/^\s{4,}/.test(line);             // not deeply indented (code block)
            if (prevLine.length >= 40 && looksLikeContinuation) {
              result += " " + line;
            } else {
              result += "\n" + line;
            }
          }
          navigator.clipboard.writeText(result).catch(() => {});
        });

        // On touch devices, also attach long-press-to-select so finger touch
        // can select text (xterm.js only handles mouse/trackpad natively).
        if (window.matchMedia("(pointer: coarse)").matches) {
          attachTouchSelect(entry.term);
        }

        // Track user-initiated scrolling so rapid output doesn't
        // fight the user's scroll position.
        initScrollTracking(entry.term);
        initTouchScroll(entry.term);

        // Attach scroll-to-bottom button to this terminal's viewport.
        // Deferred one frame so xterm.js has rendered the viewport element.
        requestAnimationFrame(() => _attachScrollButton());

        // OSC 7337 handler: per-session tab icon override
        // Terminal processes can emit: \033]7337;icon=cube\007
        // to change their tab's icon. Empty value resets to instance default.
        entry.term.parser.registerOscHandler(7337, (data) => {
          const match = data.match(/^icon=([a-z0-9-]*)$/);
          if (!match) return false; // not our OSC, let xterm handle it
          const iconName = match[1];
          const currentName = entry.sessionName;
          if (iconName) {
            iconStore.setIcon(currentName, iconName);
          } else {
            iconStore.removeIcon(currentName);
          }
          // Re-render tabs to show the new icon
          if (shortcutBarInstance) shortcutBarInstance.render(getActiveSessionName());
          // Notify server so other clients see the change
          cm.send(JSON.stringify({ type: "set-tab-icon", session: currentName, icon: iconName || null }));
          return true; // handled
        });

        // Terminal preview snapshots (throttled per-terminal)
        // Read entry.sessionName dynamically so renames are reflected
        let lastSnapshotTime = 0;
        let timer = null;
        entry.term.onRender(() => {
          const now = Date.now();
          const elapsed = now - lastSnapshotTime;
          if (elapsed < 3000) {
            if (!timer) {
              timer = setTimeout(() => {
                timer = null;
                lastSnapshotTime = Date.now();
                updateSnapshot(entry.sessionName, entry.term);
              }, 3000 - elapsed);
            }
            return;
          }
          if (timer) { clearTimeout(timer); timer = null; }
          lastSnapshotTime = now;
          updateSnapshot(entry.sessionName, entry.term);
        });
      }
    });

    // Convenience accessors — always reference the active terminal
    const getTerm = () => terminalPool.getActive()?.term;
    const getSearchAddon = () => terminalPool.getActive()?.searchAddon;

    // --- Tile Factories ---
    // Two factories, no registry: terminals and clusters (grids of terminals).
    // The generic tile plugin system was removed — these are the only tile
    // kinds katulong ships, and both are owned by app.js directly.
    //
    // Note: terminalDeps used to carry a `get carousel()` lazy getter so
    // the tile could reach back into the container for setBackTile/flipCard.
    // That circular wiring was removed in Tier 1 T1a — the carousel now
    // exposes `ctx.faceStack` to tiles at mount time. See
    // docs/tile-clusters-design.md and public/lib/tiles/terminal-tile.js.
    const terminalDeps = { terminalPool };
    const terminalTileFactory = createTerminalTileFactory(terminalDeps);
    const clusterTileFactory = createClusterTileFactory({
      createTerminalTile: (options) => terminalTileFactory(options),
    });
    const fileBrowserTileFactory = createFileBrowserTileFactory();

    // ── UI store + Renderer registry ──────────────────────────────────
    // Create ui-store first — the file-browser renderer needs it to open
    // document tiles adjacent to the browser tile on single-click.
    const uiStore = createUiStore({ isPersistable });
    _uiStore = uiStore;

    // Initialize the renderer registry with shared deps. This must happen
    // before any tile mount — renderers wrap the existing tile factories.
    initRenderers({
      terminalPool,
      createTerminalTile: (opts) => terminalTileFactory(opts),
      uiStore,
    });

    /** Derive renderer capabilities for a tile descriptor.
     *  Returns {} for unknown tiles so callers can safely destructure. */
    function describeTile(tile) {
      if (!tile) return {};
      const renderer = getRenderer(tile.type);
      return renderer?.describe(tile.props) || {};
    }

    /**
     * Create a terminal cluster: a single card holding a 2x2 grid of new
     * tmux sessions, each its own PTY. Spawns sessions in parallel; on
     * partial failure, deletes the successfully created ones so the server
     * never ends up with orphaned sessions that have no UI owner.
     *
     * Fixed at 4 cells for now — the `+` menu is touch-driven and a
     * native `prompt()` dialog is blocked or jarring on iOS Safari.
     * A proper picker lives in the future-work list (see
     * docs/cluster-state-machine.md).
     */
    const CLUSTER_DEFAULT_CELLS = 4;

    async function createNewCluster() {
      const count = CLUSTER_DEFAULT_CELLS;
      const base = Date.now().toString(36);
      // Spawn N sessions in parallel. Each has its own PTY — there is no
      // shared shell. This is the whole reason clusters exist: PTYs have
      // exactly one size, so only separate sessions can render at
      // different dimensions across devices.
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, i) =>
          api.post("/sessions", { name: `cluster-${base}-${i}` })
        )
      );
      const created = [];
      const failures = [];
      for (const r of results) {
        if (r.status === "fulfilled") created.push(r.value);
        else failures.push(r.reason);
      }
      if (failures.length > 0) {
        // Partial failure — roll back any sessions we did create so the
        // server isn't left with orphaned tmux sessions that no UI owns.
        await Promise.allSettled(
          created.map(s => api.delete(`/sessions/by-id/${encodeURIComponent(s.id)}`))
        );
        const first = failures[0];
        console.error("Failed to create cluster:", first);
        showToast(`Failed to create cluster: ${first?.message || "unknown error"}`);
        return;
      }
      const slots = created.map(s => ({ sessionName: s.name }));
      const tileId = `cluster-${base}`;
      uiStore.addTile(
        { id: tileId, type: "cluster", props: { slots, cells: count } },
        { focus: true, insertAt: "afterFocus" },
      );
      cm.connect();
    }

    // --- Card Carousel (iPad/tablet) ---
    const carousel = createCardCarousel({
      container: document.getElementById("terminal-container"),
      isTypePersistable: isPersistable,
      createTileContext: (tileId, _tile) => ({
        tileId,
        sendWs(msg) {
          cm.send(JSON.stringify(msg));
        },
        onWsMessage(_type, _handler) {
          // Terminal tiles use the existing pull-based output system.
          // Non-terminal tiles will use this in the future.
          return () => {};
        },
        setTitle(_title) {
          // Re-render the shortcut bar so tile-provided labels (file
          // browser tracks its cwd, future tiles may have dynamic titles)
          // flow into tab labels via getSessionList()/tile.getTitle().
          if (shortcutBarInstance) shortcutBarInstance.render(getActiveSessionName());
        },
        setIcon(_icon) {
          // Future: update tab icon dynamically
        },
      }),
      // Thin dispatcher — all business logic lives in tile-host's
      // onFocusChange callback (capability-driven, no type checks).
      onFocusChange: (tileId) => {
        uiStore.focusTile(tileId);
      },
      // Thin dispatcher — tile-host's onTileRemoved handles WS cleanup
      // generically via getSessions() (no type checks).
      onCardDismissed: (tileId) => {
        uiStore.removeTile(tileId);
      },
      onAllCardsDismissed: () => {
        // Dispatch empty state — tile-host's onTileRemoved fires for
        // each tile, handling WS unsubscribe generically.
        uiStore.reset(EMPTY_STATE);
        cm.disconnect();
        setDocTitle(null);
        const url = new URL(window.location);
        url.searchParams.delete("s");
        history.replaceState(null, "", url);
        sessionStorage.setItem("katulong-empty-state", "1");
      },
    });

    // ── Tile host — reactive bridge from ui-store → carousel ──────────
    //
    // Subscribes to ui-store state changes and translates them into
    // carousel commands (activate, addCard, removeCard, focusCard,
    // reorderCards). All tile lifecycle now flows through one subscription.
    const tileHost = createTileHost({
      store: uiStore,
      carousel,
      getRenderer,
      onFocusChange: (tileId, tileType) => {
        // <tile-tab-bar> updates via store subscription — no direct call needed.

        // Capability-driven WS bookkeeping — no type checks
        const desc = getRenderer(tileType)?.describe(
          uiStore.getState().tiles[tileId]?.props || {},
        ) || {};

        // Sessionless tiles (file browser) don't need the WebSocket.
        // Set a data attribute so CSS can hide the disconnect overlay
        // regardless of how many JS paths toggle .visible on it.
        document.body.dataset.focusedNeedsWs = desc.session ? "1" : "0";

        if (desc.session) {
          setDocTitle(desc.session);

          const connReady = cm.getState().status === "ready";
          const entry = terminalPool.get(desc.session);
          const buf = entry?.term?.buffer?.active;
          const isEmpty = !buf || (buf.baseY === 0 && buf.cursorY === 0 && buf.cursorX === 0);
          if (connReady && entry) {
            if (isEmpty) {
              cm.send(JSON.stringify({ type: "switch", session: desc.session, cols: entry.term.cols, rows: entry.term.rows }));
            } else {
              cm.send(JSON.stringify({ type: "resize", session: desc.session, cols: entry.term.cols, rows: entry.term.rows }));
            }
          } else if (isEmpty) {
            cm.connect();
          }
        }
        syncCarouselSubscriptions();
        _attachScrollButton();
      },
      onTileRemoved: (id, handle) => {
        // Generic cleanup via getSessions() — works for terminals,
        // clusters (sub-sessions), and no-ops for sessionless tiles.
        const sessions = handle.getSessions?.() || [];
        for (const sessionName of sessions) {
          if (windowTabSet) windowTabSet.removeTab(sessionName);
          cm.send(JSON.stringify({ type: "unsubscribe", session: sessionName }));
        }
        // Legacy shortcut bar re-render
        if (shortcutBarInstance) shortcutBarInstance.render(getActiveSessionName());
      },
    });

    // ── Level-2 cluster overview + pinch-to-zoom ────────────────────
    // The L2 overlay is a projection of uiStore — it reads cluster state
    // and dispatches switchCluster/setLevel. It lives as a sibling to the
    // terminal container under #main-stage; the live terminal DOM stays
    // mounted so we don't tear down xterm.js state when the user zooms out.
    // Captured so future teardown paths (logout, reset) can call destroy().
    // Not wired to any call site yet — the app is single-page and lives
    // for the session — but keeping the handle matches createPinchGesture
    // below and avoids a refactor when teardown becomes real.
    const clusterStrips = createClusterStrips({
      store: uiStore,
      mountIn: document.getElementById("main-stage"),
      getTileLabel: (tile) => {
        const desc = getRenderer(tile.type)?.describe(tile.props || {});
        return desc?.title || tile.props?.sessionName || tile.type || tile.id;
      },
    });
    void clusterStrips;

    // Pinch thresholds: user must scale past these to commit a level
    // change. Chosen by feel — tight enough that a small accidental
    // two-finger scroll doesn't flip levels, loose enough that a
    // deliberate pinch always lands. The gesture emits on phase=end so
    // mid-gesture wobble never commits.
    const PINCH_OUT_COMMIT = 1.15;  // L1 → L2 (zoom out to overview)
    const PINCH_IN_COMMIT  = 0.85;  // L2 → L1 (zoom into active cluster)
    const pinch = createPinchGesture({
      target: document.getElementById("main-stage"),
      onPinch: ({ scale, phase }) => {
        if (phase !== "end") return;
        const level = uiStore.getState().level;
        if (level === 1 && scale >= PINCH_OUT_COMMIT) uiStore.setLevel(2);
        else if (level === 2 && scale <= PINCH_IN_COMMIT) uiStore.setLevel(1);
      },
    });
    pinch.attach();

    // ── URL sync (reactive subscription) ────────────────────────────
    // Keep ?s= in sync with the focused tile. Terminal tiles write their
    // session name; non-terminal tiles clear ?s= so a stale terminal
    // name doesn't override the persisted focusedId on the next refresh
    // (the file-browser focus-loss bug — see tile-host init comment).
    uiStore.subscribe((uiState) => {
      const focused = uiState.tiles[uiState.focusedId];
      const desc = describeTile(focused);
      const url = new URL(window.location);
      if (desc.updatesUrl && desc.session) {
        url.searchParams.set("s", desc.session);
      } else if (focused) {
        url.searchParams.delete("s");
      }
      if (url.href !== window.location.href) {
        history.replaceState(null, "", url);
      }
      // Keep body data attribute in sync for CSS-driven overlay hiding.
      document.body.dataset.focusedNeedsWs = desc.session ? "1" : "0";
    });

    /** Subscribe all tiles in a cluster to WS output via getSessions().
     *  ALL tiles need subscriptions — including the focused one — because
     *  carousel swipe doesn't send `switch` (no server round-trip). Without
     *  a subscription, data-available notifications are dropped and the
     *  terminal appears stuck.
     *
     *  Cluster-scoped (FP5): iterates a cluster's tile order from
     *  ui-store rather than the visible carousel's card list. This keeps
     *  subscription routing correct when MC3 introduces multiple carousels
     *  (Level 2) — each cluster's tiles are subscribed independently of
     *  whichever carousel is visually on screen.
     *
     *  @param {number} [clusterIdx] — defaults to the active cluster. */
    function syncCarouselSubscriptions(clusterIdx) {
      const state = uiStore.getState();
      const view = selectClusterView(
        state,
        typeof clusterIdx === "number" ? clusterIdx : state.activeClusterIdx,
      );
      if (view.order.length === 0) return;
      for (const tileId of view.order) {
        const handle = tileHost.getHandle(tileId);
        if (!handle) continue;
        // getSessions() returns all WS session names this tile manages:
        // one for terminals, multiple for clusters, none for file-browsers.
        const sessions = handle.getSessions?.() || [];
        for (const sessionName of sessions) {
          const entry = terminalPool.get(sessionName);
          const subMsg = { type: "subscribe", session: sessionName };
          if (entry?.term?.cols) subMsg.cols = entry.term.cols;
          if (entry?.term?.rows) subMsg.rows = entry.term.rows;
          cm.send(JSON.stringify(subMsg));
        }
      }
      carousel.fitAll();
    }

    /** Route a session through ui-store — adds the tile if absent, then
     *  focuses it. tile-host picks up the state change and drives the
     *  carousel. No direct carousel calls.
     *  @param {string} name — session name (= tile id for terminals) */
    function routeToSession(name) {
      const uiState = uiStore.getState();
      if (!uiState.tiles[name]) {
        uiStore.addTile(
          { id: name, type: "terminal", props: { sessionName: name } },
          { focus: true, insertAt: "afterFocus" },
        );
      } else {
        uiStore.focusTile(name);
      }
    }

    /** Scale the active terminal to fit its container at fixed cols.
     *  The pool's onResize callback handles server notification when
     *  dimensions actually change — no need to send unconditionally. */
    function fitActiveTerminal() {
      requestAnimationFrame(() => {
        if (uiStore.getState().focusedId) {
          carousel.fitAll();
          return;
        }
        const active = terminalPool.getActive();
        if (!active) return;
        terminalPool.scale(active.sessionName);
      });
    }

    // --- Search bar ---
    const searchBar = document.getElementById("search-bar");
    const searchInput = document.getElementById("search-input");
    const searchClose = document.getElementById("search-close");

    function toggleSearchBar() {
      const visible = searchBar.classList.toggle("visible");
      if (visible) {
        searchInput.focus();
        searchInput.select();
      } else {
        searchInput.value = "";
        getSearchAddon()?.clearDecorations();
        getTerm()?.focus();
      }
    }

    searchInput.addEventListener("input", () => {
      if (searchInput.value) {
        getSearchAddon()?.findNext(searchInput.value);
      } else {
        getSearchAddon()?.clearDecorations();
      }
    });
    searchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        toggleSearchBar();
        ev.preventDefault();
      } else if (ev.key === "Enter") {
        if (ev.shiftKey) {
          getSearchAddon()?.findPrevious(searchInput.value);
        } else {
          getSearchAddon()?.findNext(searchInput.value);
        }
        ev.preventDefault();
      }
    });
    searchClose.addEventListener("click", toggleSearchBar);

    // Initialize modals — use getters so focus goes to whichever terminal is active
    modals.register('shortcuts', 'shortcuts-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
    });
    modals.register('edit', 'edit-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
    });
    modals.register('add', 'add-modal', {
      get returnFocus() { return getTerm(); },
      onOpen: () => {
        const keyInput = document.getElementById("key-composer-input");
        if (keyInput) keyInput.focus();
      },
      onClose: () => getTerm()?.focus()
    });
    modals.register('dictation', 'dictation-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
    });
    // Late-bound so the settings modal can refresh the notification-
    // permission row each time it opens. `Notification.permission`
    // has no change event, and Safari/macOS can mutate it out-of-band
    // (Safari per-site settings, System Settings → Notifications), so
    // we can't rely on the one-shot read at init time. The real
    // implementation is assigned further down under "--- Notification
    // permission ---"; this declaration reserves the closure slot.
    let refreshNotificationRow = () => {};

    modals.register('settings', 'settings-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus(),
      onOpen: () => refreshNotificationRow(),
    });

    document.fonts.ready.then(() => {
      // Fonts loaded — refit terminal since glyph metrics may have changed
      fitActiveTerminal();
    });

    // Palette was applied synchronously inside createThemeManager(); the
    // manager also installs its own prefers-color-scheme listener. No
    // further setup needed here.

    // --- WebSocket ---

    // Create buffered input sender
    const inputSender = createInputSender({
      sendFn: (payload) => cm.send(payload),
      getSession: () => getActiveSessionName(),
      onInput: () => {},
    });

    const rawSend = (data) => {
      // Drop all input when not attached — prevents blind typing during
      // disconnection from queuing keystrokes that execute on reconnect.
      if (cm.getState().status !== "ready") return;
      inputSender.send(data);
    };

    // Create the initial terminal now that rawSend is available.
    // When no explicit ?s= param, activation is deferred until we
    // resolve which session to attach to (or none).
    if (explicitSession) {
      terminalPool.activate(explicitSession);
    }

    // --- Layout ---

    const termContainer = document.getElementById("terminal-container");
    const bar = document.getElementById("shortcut-bar");

    // --- Joystick (composable state machine) ---
    const joystickManager = createJoystickManager({
      onSend: (sequence) => rawSend(sequence)
    });
    joystickManager.init();

    // Wire Files + Upload + Settings + Feed into the joystick floating buttons
    joystickManager.setActions({
      onFilesClick: () => openFileBrowserTile(),
      onUploadClick: () => triggerImageUpload(),
      onSettingsClick: () => modals.open('settings'),
      onFeedClick: () => openClaudeFeedTile(),
    });

    // Joystick (floating action buttons) is always visible — same
    // experience on iPad and desktop.


    // --- Shortcuts popup (reactive component) ---

    const shortcutsPopup = createShortcutsPopup({
      onShortcutClick: (keys) => {
        sendSequence(keysToSequence(keys), rawSend);
      },
      modals
    });

    function openShortcutsPopup(items) {
      shortcutsPopup.render(document.getElementById("shortcuts-grid"), items);
      modals.open('shortcuts');
    }

    document.getElementById("shortcuts-edit-btn").addEventListener("click", () => {
      modals.close('shortcuts');
      shortcutsEditPanel.open(shortcutsStore.getState());
    });
    

    // --- Edit shortcuts (reactive component) ---

    const shortcutsEditPanel = createShortcutsEditPanel(shortcutsStore, { modals });

    // Subscribe to shortcuts changes to re-render edit list
    shortcutsStore.subscribe((shortcuts) => {
      const editList = document.getElementById("edit-list");
      if (editList && modals.get('edit')?.isOpen) {
        shortcutsEditPanel.render(editList, shortcuts);
      }
    });

    document.getElementById("edit-done").addEventListener("click", () => {
      shortcutsEditPanel.close();
    });

    document.getElementById("edit-add").addEventListener("click", () => {
      addShortcutModal.open();
    });

    // --- Add shortcut modal (reactive component) ---

    const addShortcutModal = createAddShortcutModal(shortcutsStore, {
      modals,
      keysLabel,
      keysString,
      displayKey,
      normalizeKey,
      VALID_KEYS
    });

    // Initialize the add modal event handlers
    addShortcutModal.init();

    

    // --- Session manager (render takes data) ---

    const sessionStore = createSessionStore(explicitSession);
    const windowTabSet = createWindowTabSet({
      getCurrentSession: () => getActiveSessionName(),
      // When another browser window kills a session, tear it down fully in
      // this window: carousel card, pooled terminal, WS unsubscribe. Without
      // this, reorderCards only reorders — it re-appends missing ids — so
      // the zombie card would linger until the /sessions reconciler caught
      // up seconds later. `removeDeadSession` is hoisted (declared below at
      // function scope) so the closure resolves correctly at call time.
      onRemoteKill: (name) => removeDeadSession(name),
    });
    // Ensure the initial session from the URL is in this window's tab set.
    // addTab grants a time-limited grace period (RECENTLY_ADDED_TTL_MS in
    // window-tab-set.js) so the reconciler doesn't prune the freshly-booted
    // session in the gap between page load and the first /sessions response.
    // The TTL ensures a stale ?s= URL bookmark eventually becomes prunable.
    if (explicitSession) {
      windowTabSet.addTab(explicitSession);
    }

    // Create session list component
    // switchSession is defined below but the callback is only invoked on click, not during init
    const sessionListComponent = createSessionListComponent(sessionStore, {
      onSessionSwitch: (name) => switchSession(name),
      windowTabSet
    });
    const sessionListEl = document.getElementById("session-list");
    if (sessionListEl) {
      sessionListComponent.mount(sessionListEl);
    }

    // --- Sidebar toggle ---
    const sidebar = document.getElementById("sidebar");
    const sidebarToggleBtn = document.getElementById("sidebar-toggle");
    const sidebarAddBtn = document.getElementById("sidebar-add-btn");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");

    // Device-based layout: phones get sidebar overlay, tablets/desktop get tab bar
    const isOverlayViewport = () =>
      !window.matchMedia("(pointer: fine)").matches &&
      !window.matchMedia("(pointer: coarse) and (min-width: 768px)").matches;

    function loadSidebarData() {
      invalidateSessions(sessionStore, getActiveSessionName());
    }

    function setOverlaySidebar(open) {
      if (!sidebar) return;
      sidebar.classList.toggle("mobile-open", open);
      sidebarBackdrop?.classList.toggle("visible", open);
      if (open) loadSidebarData();
    }

    function setSidebarCollapsed(collapsed) {
      if (!sidebar) return;
      sidebar.classList.toggle("collapsed", collapsed);
      localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "0");
      const icon = sidebarToggleBtn?.querySelector("i");
      if (icon) {
        icon.className = collapsed ? "ph ph-caret-right" : "ph ph-caret-left";
      }
    }

    function toggleSidebar() {
      if (!sidebar) return;
      if (isOverlayViewport()) {
        setOverlaySidebar(!sidebar.classList.contains("mobile-open"));
        return;
      }
      const isCollapsed = sidebar.classList.contains("collapsed");
      setSidebarCollapsed(!isCollapsed);
      if (isCollapsed) loadSidebarData();
    }

    if (sidebarBackdrop) {
      sidebarBackdrop.addEventListener("click", () => setOverlaySidebar(false));
    }

    // Restore sidebar state from localStorage (desktop only)
    const savedCollapsed = localStorage.getItem("sidebar-collapsed");
    const isInitiallyCollapsed = savedCollapsed !== "0";
    if (!isInitiallyCollapsed && sidebar) {
      sidebar.classList.remove("collapsed");
    }
    const toggleIcon = sidebarToggleBtn?.querySelector("i");
    if (toggleIcon) {
      toggleIcon.className = isInitiallyCollapsed ? "ph ph-caret-right" : "ph ph-caret-left";
    }

    if (sidebarToggleBtn) {
      sidebarToggleBtn.addEventListener("click", toggleSidebar);
    }

    // --- New session creation (shared by sidebar + and shortcut bar +) ---
    async function createNewSession() {
      try {
        const name = generateSessionName();
        const data = await api.post("/sessions", { name, copyFrom: getActiveSessionName() });
        if (sidebar?.classList.contains("collapsed")) {
          setSidebarCollapsed(false);
        }
        // routeToSession dispatches ADD_TILE with insertAt: "afterFocus"
        routeToSession(data.name);
        windowTabSet.addTab(data.name);
        cm.reconnectNow();
      } catch (err) {
        console.error("Failed to create session:", err);
        showToast(`Failed to create session: ${err.message}`);
      }
    }

    // FP3 — + button routing. Pure decision in /lib/add-target.js; this
    // factory wires it to the two side-effects (create terminal tile /
    // create empty cluster). getLevel reads the live zoom level so the
    // same button produces a tile at L1 and a new cluster at L2.
    const handleAdd = createAddHandler({
      getLevel: () => uiStore.getState().level,
      getState: () => {
        const st = uiStore.getState();
        return { activeClusterIdx: st.activeClusterIdx, focusedId: st.focusedId };
      },
      onAddTile: () => createNewSession(),
      onAddCluster: () => uiStore.addCluster({ switchTo: true }),
    });

    if (sidebarAddBtn) {
      sidebarAddBtn.addEventListener("click", handleAdd);
    }

    // Load session data: always on desktop (for tab bar), or when sidebar is expanded
    if (!isOverlayViewport() || !isInitiallyCollapsed) loadSidebarData();

    // --- Session switching (no page reload) ---
    // Late-bound: viewportManager is created after activateSession but called lazily
    let _attachScrollButton = () => {};

    function activateSession(name) {
      // Close alternative views — switching sessions returns to terminal
      if (notepad.isActive()) notepad.hide();

      // Ensure session is in this window's tab set
      if (!windowTabSet.hasTab(name)) {
        windowTabSet.addTab(name);
      }

      // Route through the carousel — onFocusChange handles state sync,
      // WS attach/subscribe, and tab bar re-render.
      routeToSession(name);
      invalidateSessions(sessionStore, name);
    }

    function switchSession(name) {
      if (name === getActiveSessionName()) return;
      const url = new URL(window.location);
      url.searchParams.set("s", name);
      history.pushState(null, "", url);
      activateSession(name);
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    window.addEventListener("popstate", () => {
      const name = new URLSearchParams(location.search).get("s");
      if (!name) return; // bare URL without ?s= — stay on current session
      if (name !== getActiveSessionName()) activateSession(name);
    });

    const openSessionManager = () => toggleSidebar();

    // --- Keyboard shortcuts (Cmd+Shift+[/], Cmd+?) ---

    // Navigation helpers: pure function → dispatch.
    // tile-host's onFocusChange handles WS bookkeeping after dispatch.
    function navigateTab(direction) {
      const action = computeNavigateTab(uiStore.getState(), direction);
      if (action) uiStore.dispatch(action);
    }

    function moveTab(direction) {
      const action = computeMoveTab(uiStore.getState(), direction);
      if (action) uiStore.dispatch(action);
    }

    function jumpToTab(position) {
      const action = computeJumpToTab(uiStore.getState(), position);
      if (action) uiStore.dispatch(action);
    }

    function renameCurrentSession() {
      const focusedId = uiStore.getState().focusedId;
      if (!focusedId || !shortcutBarInstance) return;
      shortcutBarInstance.beginRename(focusedId);
    }

    /**
     * Tear down the focused session's UI: pick a neighbor to switch to,
     * remove the card/tab, dispose the pooled terminal, and show the add
     * menu if nothing's left. Returns whether a neighbor was activated, so
     * callers can branch on "last tab closed".
     */
    // Pick the right neighbor of `id` in the current cluster's tile order,
    // falling back to the previous tile if `id` is the last one. Returns
    // null if there is no neighbor (single tile, or id not found). Shared
    // by the explicit close path (Option+W) and the reactive session-
    // removed path so both land focus on the same tile.
    function pickRightNeighbor(id) {
      const state = uiStore.getState();
      const tabs = state.order;
      const currentId = state.focusedId || id;
      const idx = tabs.indexOf(currentId);
      if (tabs.length <= 1 || idx === -1) return null;
      return tabs[idx === tabs.length - 1 ? idx - 1 : idx + 1];
    }

    function removeFocusedSessionFromUI() {
      const focusedId = uiStore.getState().focusedId;
      if (!focusedId) return { id: null, sessionName: null, hasNext: false };
      const sessionName = getActiveSessionName();
      const hasNext = !!pickRightNeighbor(focusedId);
      // Route through ui-store — tile-host's reconcile handles carousel
      // removal, unmount, and onTileRemoved (WS cleanup, pool dispose).
      uiStore.removeTile(focusedId);
      if (!hasNext && shortcutBarInstance) {
        const addBtn = document.querySelector(".ipad-add-btn, .tab-add-btn");
        shortcutBarInstance.showAddMenu(addBtn);
      }
      return { id: focusedId, sessionName, hasNext };
    }

    function closeCurrentSession() {
      removeFocusedSessionFromUI();
    }

    async function killCurrentSession() {
      const { sessionName } = removeFocusedSessionFromUI();
      if (!sessionName) return;
      // Kill on server (best-effort — may fail if disconnected)
      try {
        const sid = await resolveSessionId(sessionName);
        await api.delete(`/sessions/by-id/${encodeURIComponent(sid)}`);
        invalidateSessionIdCache(sessionName);
      } catch { /* disconnected, already dead, or never existed — that's fine */ }
    }

    function toggleKeyboardHelp() {
      const overlay = document.getElementById("kb-help-overlay");
      if (!overlay) return;
      const isVisible = overlay.classList.contains("visible");
      overlay.classList.toggle("visible", !isVisible);
      if (!isVisible) {
        const closeBtn = document.getElementById("kb-help-close");
        if (closeBtn) closeBtn.focus();
      }
    }

    // Close overlay on backdrop click or close button
    const kbHelpOverlay = document.getElementById("kb-help-overlay");
    if (kbHelpOverlay) {
      kbHelpOverlay.addEventListener("click", (ev) => {
        if (ev.target === kbHelpOverlay) toggleKeyboardHelp();
      });
      const closeBtn = document.getElementById("kb-help-close");
      if (closeBtn) closeBtn.addEventListener("click", toggleKeyboardHelp);
    }

    // Global keyboard shortcuts. Decision logic lives in app-keyboard.js
    // (decideAppKey) so it can be unit-tested. This wiring layer maps
    // action names to handlers and runs them.
    //
    // Capture phase: required so we beat xterm.js (macOptionIsMeta=true)
    // and any input/textarea bubble-phase handlers — Option+R must not
    // re-enter the rename flow while a rename input is already focused.
    const appKeyActions = {
      openPicker: () => openTilePicker(),
      newSession: () => createNewSession(),
      closeSession: () => closeCurrentSession(),
      killSession: () => killCurrentSession(),
      renameSession: () => renameCurrentSession(),
      navigateTab: (dir) => navigateTab(dir),
      moveTab: (dir) => moveTab(dir),
      jumpToTab: (n) => jumpToTab(n),
    };

    function handleAppKeydown(ev) {
      // Escape closes the keyboard help overlay. Other modals own their
      // own Escape handling via ModalRegistry.
      if (ev.key === "Escape" && kbHelpOverlay?.classList.contains("visible")) {
        ev.preventDefault();
        toggleKeyboardHelp();
        return;
      }

      const decision = decideAppKey(ev, { isTextInput: isTextInputTarget(ev.target) });
      if (!decision.action) return;

      const handler = appKeyActions[decision.action];
      if (!handler) {
        // Drift guard: if decideAppKey is extended without a matching
        // entry here, surface it loudly during development instead of
        // silently swallowing the keystroke.
        console.warn("[app-keyboard] no handler for action:", decision.action);
        return;
      }

      if (decision.preventDefault) ev.preventDefault();
      handler(decision.args);
    }

    document.addEventListener("keydown", handleAppKeydown, true);

    // Iframe focus recapture — when an iframe inside a tile steals focus,
    // keyboard events stop reaching the document. Detect this via window
    // blur (fires when focus moves into an iframe), then install a
    // transient pointerdown listener on the iframe's parent container.
    // Any Alt-key press while window is blurred is invisible to us, so
    // instead we recapture focus on the next user interaction outside
    // the iframe (pointer up anywhere on the document). This is enough
    // because navigation shortcuts require the modifier key which users
    // press outside the iframe context. For immediate recapture, we also
    // listen for mousemove on the document — as soon as the pointer
    // leaves the iframe, focus returns to the parent window.
    let iframeFocused = false;
    window.addEventListener("blur", () => {
      // Check if focus went to an iframe inside our app
      if (document.activeElement?.tagName === "IFRAME") {
        iframeFocused = true;
      }
    });
    window.addEventListener("focus", () => { iframeFocused = false; });
    document.addEventListener("mousemove", () => {
      if (iframeFocused) {
        iframeFocused = false;
        window.focus();
      }
    }, { passive: true });

    // --- Settings ---

    settingsHandlers = createSettingsHandlers({
      onAnchorChange: (hex) => themeManager.setAnchor(hex),
      onPolarityChange: (polarity) => themeManager.setPolarity(polarity),
      onVibrancyChange: (vibrancy) => themeManager.setVibrancy(vibrancy),
      // User preference, not resolved palette — see syncPaletteControls.
      getPreferences: () => ({
        anchor: themeManager.getAnchor(),
        polarity: themeManager.getPolarity(),
        vibrancy: themeManager.getVibrancy(),
      }),
      onPortProxyChange: (enabled) => {
        const btn = document.getElementById("sidebar-portfwd-btn");
        if (btn) btn.style.display = enabled ? "" : "none";
        if (shortcutBarInstance) shortcutBarInstance.setPortProxyEnabled(enabled);
      }
    });
    settingsHandlers.init();

    // --- Settings tabs (using generic tab manager) ---
    const settingsTabManager = createTabManager({
      tabSelector: '.settings-tab',
      contentSelector: '.settings-tab-content',
      onTabChange: (targetTab) => {
        if (targetTab === "remote") {
          // Clear any lingering new token display before loading tokens
          const tokensList = document.getElementById("tokens-list");
          const staleNewToken = tokensList?.querySelector('.token-item-new');
          if (staleNewToken) staleNewToken.remove();
          loadTokens();
        }
      }
    });
    settingsTabManager.init();

    // --- Notification permission ---
    //
    // Assigns the real implementation into the closure slot reserved
    // above at modals.register('settings', ...). The function is
    // idempotent: every call fully resets the DOM and rebuilds it
    // from the current Notification.permission value, so it's safe
    // to call on init, on every settings-modal open, on
    // visibilitychange, and after a requestPermission() resolves.
    refreshNotificationRow = () => {
      const statusEl = document.getElementById("notification-permission-status");
      const descEl = document.getElementById("notification-permission-desc");
      if (!statusEl || !descEl) return;

      // Clear prior content AND inline color — we may be re-rendering
      // over an earlier state (Enable button → "Enabled" text after
      // grant, "Blocked" → "Enabled" after the user unblocks in
      // Safari/macOS settings, or "Blocked" → default after a
      // Chromium-side revoke). innerHTML="" only clears children, so
      // style.color is reset explicitly to avoid leaking the previous
      // state's red/green tint into the next render.
      statusEl.innerHTML = "";
      statusEl.style.color = "";

      if ("Notification" in window) {
        const perm = Notification.permission;
        if (perm === "granted") {
          statusEl.textContent = "Enabled";
          statusEl.style.color = "var(--success)";
          descEl.textContent = "You\u2019ll receive alerts from katulong notify commands.";
        } else if (perm === "denied") {
          statusEl.textContent = "Blocked";
          statusEl.style.color = "var(--error, #f38ba8)";
          descEl.textContent = "Notifications were blocked. Reset in your browser or system settings.";
        } else {
          const btn = document.createElement("button");
          btn.className = "shortcut-btn";
          btn.textContent = "Enable";
          btn.addEventListener("click", () => {
            Notification.requestPermission().then(() => refreshNotificationRow());
          });
          statusEl.appendChild(btn);
          descEl.textContent = "Receive alerts from katulong notify commands.";
        }
      } else {
        // Notification API not available — detect browser and show install instructions
        statusEl.textContent = "Not available";
        statusEl.style.color = "var(--text-muted)";
        const ua = navigator.userAgent;
        const isIPad = /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        const isIPhone = /iPhone/.test(ua);
        const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);
        const isAndroid = /Android/.test(ua);
        if ((isIPad || isIPhone) && isSafari) {
          descEl.innerHTML = 'To enable notifications, install as an app:<br>Tap <strong>\u{1F4E4} Share</strong> \u2192 <strong>Add to Home Screen</strong>.';
        } else if (isAndroid) {
          descEl.innerHTML = 'To enable notifications, install as an app:<br>Tap <strong>\u22EE Menu</strong> \u2192 <strong>Install app</strong> or <strong>Add to Home screen</strong>.';
        } else if (/Chrome/.test(ua)) {
          descEl.innerHTML = 'To enable notifications, install as an app:<br>Click the <strong>install icon</strong> in the address bar, or <strong>\u22EE Menu \u2192 Install</strong>.';
        } else {
          descEl.textContent = "Notifications require installing this site as an app (PWA).";
        }
      }
    };
    refreshNotificationRow();

    // Safari/Chrome don't fire a permission-change event for the
    // Notification API, so we re-probe on visibility change — this
    // catches the common flow of "user tabs to Safari settings (or
    // macOS System Settings) to unblock notifications, then tabs
    // back to the PWA". Without this, the row stays stuck on its
    // initial "Blocked" reading until a full page reload.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshNotificationRow();
    });

    // --- Token management ---

    const tokenStore = createTokenStore();
    const loadTokens = () => reloadTokens(tokenStore);

    // Create token form manager with callbacks
    const tokenFormManager = createTokenFormManager({
      onCreate: (data) => {
        setNewToken(tokenStore, data);
      },
      onRename: () => {
        invalidateTokens(tokenStore);
      },
      onRevoke: (tokenId) => {
        removeToken(tokenStore, tokenId);
      }
    });
    tokenFormManager.init();

    // Create token list component
    const tokenListComponent = createTokenListComponent(tokenStore, {
      onRename: (tokenId) => tokenFormManager.renameToken(tokenId),
      onRevoke: (tokenId, hasCredential, isOrphaned) => tokenFormManager.revokeToken(tokenId, hasCredential, isOrphaned)
    });
    const tokensList = document.getElementById("tokens-list");
    if (tokensList) {
      tokenListComponent.mount(tokensList);
    }

    // --- API key management ---
    {
      const createBtn = document.getElementById("settings-create-apikey");
      const form = document.getElementById("apikey-create-form");
      const nameInput = document.getElementById("apikey-name-input");
      const submitBtn = document.getElementById("apikey-form-submit");
      const cancelBtn = document.getElementById("apikey-form-cancel");
      const listEl = document.getElementById("apikeys-list");

      async function loadApiKeys() {
        if (!listEl) return;
        try {
          const keys = await api.get("/api/api-keys");
          if (!keys.length) { listEl.innerHTML = '<p class="tokens-loading">No API keys yet.</p>'; return; }
          listEl.innerHTML = keys.map(k => `
            <div class="token-item" data-id="${escapeAttr(k.id)}">
              <div class="token-item-info">
                <span class="token-item-name">${escapeHtml(k.name)}</span>
                <span class="token-item-meta">${escapeHtml(k.prefix)}... · ${k.lastUsedAt ? "used " + new Date(k.lastUsedAt).toLocaleDateString() : "never used"}</span>
              </div>
              <button class="token-item-revoke" data-id="${escapeAttr(k.id)}">Revoke</button>
            </div>
          `).join("");
          listEl.querySelectorAll(".token-item-revoke").forEach(btn => {
            btn.addEventListener("click", async () => {
              if (!confirm("Revoke this API key?")) return;
              await api.del("/api/api-keys/" + btn.dataset.id);
              loadApiKeys();
            });
          });
        } catch { if (listEl) listEl.innerHTML = '<p class="tokens-loading">Failed to load.</p>'; }
      }

      if (createBtn && form) {
        createBtn.addEventListener("click", () => { form.style.display = ""; createBtn.style.display = "none"; nameInput?.focus(); });
        cancelBtn?.addEventListener("click", () => { form.style.display = "none"; createBtn.style.display = ""; });
        submitBtn?.addEventListener("click", async () => {
          const name = nameInput?.value?.trim();
          if (!name) return;
          try {
            const data = await api.post("/api/api-keys", { name });
            form.style.display = "none"; createBtn.style.display = ""; nameInput.value = "";
            const el = document.createElement("div");
            el.className = "token-item token-item-new";
            el.innerHTML = '<div class="token-item-info"><span class="token-item-name">' + escapeHtml(data.name) + '</span>'
              + '<code style="display:block;margin-top:0.25rem;font-size:0.75rem;word-break:break-all;color:var(--success);cursor:pointer;">' + escapeHtml(data.key) + '</code>'
              + '<span class="token-item-meta">Click key to copy. It won\'t be shown again.</span></div>';
            el.querySelector("code").addEventListener("click", () => navigator.clipboard.writeText(data.key).then(() => showToast("Copied!")));
            listEl.prepend(el);
            setTimeout(() => { el.remove(); loadApiKeys(); }, 30000);
          } catch (err) { showToast(err.message, true); }
        });
      }

      document.querySelectorAll(".settings-tab").forEach(tab => {
        tab.addEventListener("click", () => { if (tab.dataset.tab === "api") { loadApiKeys(); } });
      });
    }

    // --- Dictation modal (reactive component) ---

    const dictationModal = createDictationModal({
      modals,
      onSend: async (text, images) => {
        if (text) rawSend(text);
        for (const file of images) {
          await uploadImageToTerminal(file);
        }
      }
    });

    dictationModal.init();

    function openDictationModal() {
      dictationModal.open();
    }

    // --- Viewport manager & Shortcut bar ---
    // (Moved here after openSessionManager and openDictationModal are defined)

    const viewportManager = createViewportManager({
      term: getTerm,
      termContainer,
    });
    viewportManager.init();
    _attachScrollButton = () => viewportManager.attachScrollButton();

    shortcutBarInstance = createShortcutBar({
      container: bar,
      pinnedKeys: [
        { label: "Esc", keys: "esc" },
        { label: "Tab", keys: "tab" }
      ],
      onNewSessionClick: createNewSession,
      tileTypes: [
        { type: "terminal",     name: "Terminal", icon: "terminal-window" },
        { type: "feed",          name: "Feed",     icon: "rss" },
        { type: "localhost-browser", name: "Browser", icon: "globe-simple" },
      ],
      onCreateTile: (type) => {
        if (type === "terminal") {
          createNewSession();
        } else if (type === "cluster") {
          createNewCluster();
        } else if (type === "file-browser") {
          openFileBrowserTile();
        } else if (type === "feed") {
          openClaudeFeedTile();
        } else if (type === "localhost-browser") {
          openLocalhostBrowserTile();
        }
      },
      onTabClick: (name) => {
        // If tile exists in ui-store, just focus it. routeToSession
        // would create a phantom terminal for non-session tiles.
        const uiState = uiStore.getState();
        if (uiState.tiles[name]) {
          uiStore.focusTile(name);
        } else {
          routeToSession(name);
        }
      },
      onNotepadClick: () => toggleNotepad(),
      get notepad() { return notepad; },
      onAdoptSession: async (name) => {
        windowTabSet.addTab(name);
        try {
          const result = await api.post("/tmux-sessions/adopt", { name });
          if (result.name) switchSession(result.name);
        } catch (err) {
          // Fallback: switch directly (spawnSession auto-adopts existing tmux sessions)
          console.warn("Adopt API failed, switching directly:", err.message);
          switchSession(name);
        }
      },
      onTerminalClick: () => returnToTerminal(),
      onFilesClick: () => openFileBrowserTile(),
      onPortForwardClick: () => openLocalhostBrowserTile(),
      onSettingsClick: () => modals.open('settings'),
      onShortcutsClick: () => openShortcutsPopup(shortcutsStore.getState()),
      onDictationClick: () => openDictationModal(),
      sendFn: rawSend,
      get term() { return getTerm(); },
      terminalPool,
      sessionStore,
      windowTabSet,
      uiStore,
    });

    // Sync ui-store order when tabs are reordered via the legacy shortcut bar.
    // Routes through ui-store so tile-host drives carousel.reorderCards.
    if (windowTabSet) {
      windowTabSet.subscribe(() => {
        uiStore.reorder(windowTabSet.getTabs());
      });
    }

    // ── <tile-tab-bar> event handlers ──────────────────────────────────
    // The web component dispatches CustomEvents for actions that need
    // host involvement (server API calls, WS cleanup). Tab focus and
    // reorder go directly through ui-store inside the component.
    bar.addEventListener("tab-add", () => {
      // Delegate to the shortcut bar's + button menu
      shortcutBarInstance.showAddMenu(bar.querySelector(".ipad-add-btn") || bar);
    });

    function applyLocalRename(oldName, newName, tile, wasFocused) {
      carousel.renameCard(oldName, newName);
      terminalPool.rename(oldName, newName);
      notepad.rename(oldName, newName);
      iconStore.rename(oldName, newName);
      windowTabSet.renameTab(oldName, newName);
      invalidateSessions(sessionStore, newName);
      uiStore.removeTile(oldName);
      uiStore.addTile(
        { id: newName, type: tile.type, props: { ...tile.props, sessionName: newName } },
        { focus: wasFocused },
      );
      if (wasFocused) setDocTitle(newName);
    }

    bar.addEventListener("tab-rename", (e) => {
      const { id, oldName, newName } = e.detail;
      const uiState = uiStore.getState();
      const tile = uiState.tiles[id];
      const desc = describeTile(tile);
      if (!desc.renameable || !desc.session) return;

      const wasFocused = uiState.focusedId === id;
      // Optimistic local rename before the API call, so the WS broadcast
      // that echoes the rename becomes a no-op rather than a duplicate render.
      applyLocalRename(oldName, newName, tile, wasFocused);

      // Persist to the server. If the server canonicalized the name, apply
      // a second rename pass. On failure, roll back the optimistic update.
      // Rename via the stable id so we don't race our own optimistic update.
      resolveSessionId(oldName)
        .then((sid) => api.put(`/sessions/by-id/${encodeURIComponent(sid)}`, { name: newName }))
        .then((result) => {
          // Rename changes the friendly name → invalidate both keys in the cache
          invalidateSessionIdCache(oldName);
          invalidateSessionIdCache(newName);
          const canonical = result?.name || newName;
          if (canonical !== newName) {
            const st = uiStore.getState();
            const current = st.tiles[newName];
            if (current) applyLocalRename(newName, canonical, current, st.focusedId === newName);
          }
        })
        .catch((err) => {
          console.error("[Tab] Rename failed:", err);
          const st = uiStore.getState();
          const current = st.tiles[newName];
          if (current) applyLocalRename(newName, oldName, current, st.focusedId === newName);
        });
    });

    bar.addEventListener("tab-context-menu", (e) => {
      const { id, type, anchorEl } = e.detail;
      const tileDesc = uiStore.getState().tiles[id];
      const desc = describeTile(tileDesc);

      const items = [];
      if (desc.renameable) {
        items.push({ icon: "pencil-simple", label: "Rename", action: () => {
          const tabEl = bar.querySelector(`.tab-bar-tab[data-session="${CSS.escape(id)}"]`);
          if (tabEl) {
            const tabBarEl = bar.querySelector("tile-tab-bar");
            tabBarEl?.startRename(tabEl, id);
          }
        }});
      }
      if (desc.session) {
        // Session-backed tiles: detach (keep server session), kill, tear-off.
        // `id` is the tile id (== session friendly name today) — resolve to
        // the stable session id before hitting the server so rename races
        // don't matter.
        items.push({ icon: "eject", label: "Detach", action: async () => {
          try {
            const sid = await resolveSessionId(desc.session);
            await api.delete(`/sessions/by-id/${encodeURIComponent(sid)}?action=detach`);
            invalidateSessionIdCache(desc.session);
          } catch (_) {}
          uiStore.removeTile(id);
        }});
        items.push({ icon: "x-circle", label: "Kill session", danger: true, action: async () => {
          if (!confirm(`Kill session "${id}"?\n\nThis will terminate the tmux session and all its processes.`)) return;
          try {
            const sid = await resolveSessionId(desc.session);
            await api.delete(`/sessions/by-id/${encodeURIComponent(sid)}`);
            invalidateSessionIdCache(desc.session);
          } catch (_) {}
          uiStore.removeTile(id);
          if (windowTabSet) windowTabSet.onSessionKilled(id);
        }});
      } else {
        items.push({ icon: "x-circle", label: "Close", danger: true, action: () => {
          uiStore.removeTile(id);
        }});
      }
      if (desc.session) {
        items.push({ divider: true });
        items.push({ icon: "arrow-square-out", label: "Open in new window", action: () => {
          window.open(`${window.location.origin}?s=${encodeURIComponent(desc.session)}`, "_blank");
          uiStore.removeTile(id);
        }});
      }
      if (shortcutBarInstance?.showMenuFromHost) {
        shortcutBarInstance.showMenuFromHost(items, anchorEl);
      }
    });

    bar.addEventListener("tab-tear-off", (e) => {
      const { id } = e.detail;
      window.open(`${window.location.origin}?s=${encodeURIComponent(id)}`, "_blank");
      uiStore.removeTile(id);
    });

    // Re-render bar if pointer capability changes (e.g., external mouse connected)
    window.matchMedia("(pointer: fine)").addEventListener("change", () => {
      shortcutBarInstance.render(getActiveSessionName());
    });

    // ── Command mode (vim-style chord menu) ─────────────────────────
    // Mounts a surface inside #shortcut-bar; CSS fades the tabs/+ out
    // and the surface in when [data-command-mode="true"]. The chord
    // tree is pure data (command-tree.js) wired to host actions below.
    async function openTilePicker() {
      // Exit command mode so its capture-phase keydown listener doesn't
      // swallow "t"/"n"/"h" when typed into the picker's input. The mode
      // and the picker each own a window-level keydown; with both alive,
      // chord keys never reach the picker's filter.
      if (commandMode?.isActive()) commandMode.exit();

      // Snapshot ui-store first so open tiles resolve without a round-trip.
      const uiState = uiStore.getState();
      const openTiles = Object.entries(uiState.tiles).map(([id, tile]) => {
        const desc = describeTile(tile);
        return {
          id,
          label: desc.title || tile.props?.sessionName || id,
          kind: tile.type,
          action: "focus",
        };
      });
      const openIds = new Set(openTiles.map((t) => t.id));

      // Fetch server-side session lists in parallel; show what we have
      // even if one side fails (the other half is still useful).
      let managed = [];
      let unmanaged = [];
      try {
        const [sessData, tmuxData] = await Promise.all([
          api.get(`/sessions?_t=${Date.now()}`).catch(() => []),
          api.get(`/tmux-sessions?_t=${Date.now()}`).catch(() => []),
        ]);
        managed = sessData || [];
        unmanaged = (tmuxData || []).map((s) => typeof s === "string" ? { name: s, attached: false } : s);
      } catch (err) {
        console.error("[picker] fetch error:", err);
      }

      const closedManaged = managed
        .filter((s) => !openIds.has(s.name))
        .map((s) => ({ id: s.name, label: s.name, kind: "closed", action: "route" }));

      const tmuxItems = unmanaged
        .filter((s) => !openIds.has(s.name))
        .map((s) => ({
          id: s.name,
          label: s.name + (s.attached ? " (attached)" : ""),
          kind: "tmux",
          action: "adopt",
        }));

      const items = [...openTiles, ...closedManaged, ...tmuxItems];

      openCommandPicker({
        items,
        placeholder: "Go to tile or session…",
        onPick: async (item) => {
          if (item.action === "focus") {
            uiStore.focusTile(item.id);
          } else if (item.action === "route") {
            routeToSession(item.id);
          } else if (item.action === "adopt") {
            windowTabSet.addTab(item.id);
            try {
              const result = await api.post("/tmux-sessions/adopt", { name: item.id });
              if (result.name) switchSession(result.name);
            } catch (err) {
              console.warn("Adopt failed, switching directly:", err.message);
              switchSession(item.id);
            }
          }
        },
      });
    }

    const commandActions = {
      closeCurrentTile: () => { closeCurrentSession(); },
      renameCurrentTile: () => { renameCurrentSession(); },
      createTile: (type) => {
        if (type === "terminal") createNewSession();
        else if (type === "file-browser") openFileBrowserTile();
        else if (type === "feed") openClaudeFeedTile();
        else if (type === "localhost-browser") openLocalhostBrowserTile();
      },
      showHelp: () => toggleKeyboardHelp(),
    };
    const commandTree = buildCommandTree(commandActions);
    const commandMode = createCommandMode({ tree: commandTree });
    const commandSurface = createCommandSurface({ mountIn: bar, mode: commandMode });
    void commandSurface;

    const renderBar = (name) => shortcutBarInstance.render(name);

    // Reflect the active tile's Claude-presence state onto the joystick
    // feed button. The server flips `meta.claude.running` from tmux's
    // `pane_current_command` poll, so this fires on both the periodic
    // `session-updated` broadcast and active-tile switches.
    function syncClaudePresenceIndicator() {
      const { sessions } = sessionStore.getState();
      if (!sessions) return;
      const activeName = getActiveSessionName();
      const active = activeName ? sessions.find((s) => s.name === activeName) : null;
      joystickManager.setClaudeRunning(!!active?.meta?.claude?.running);
    }

    // Sync per-session icons from server session data
    sessionStore.subscribe(() => {
      const { sessions } = sessionStore.getState();
      if (!sessions) return;
      for (const s of sessions) {
        if (s.icon) {
          iconStore.setIcon(s.name, s.icon);
        } else {
          iconStore.removeIcon(s.name);
        }
      }
      syncClaudePresenceIndicator();
    });

    // Active tile changes (e.g. user switches sessions) need an immediate
    // refresh of the joystick presence indicator — waiting for the next
    // sessionStore push would leave a stale icon for up to 5s.
    uiStore.subscribe(syncClaudePresenceIndicator);

    // Subscribe to shortcuts changes to re-render bar
    shortcutsStore.subscribe(() => {
      // Re-render bar when shortcuts change
      renderBar(getActiveSessionName());
    });



    // --- Image upload (using imported helpers) ---
    const uploadImageToTerminal = (file, sessionName) => uploadImageToTerminalFn(file, {
      onSend: rawSend,
      toast: showToast,
      sessionName: sessionName || getActiveSessionName(),
      sendFn: (msg) => cm.send(msg)
    });

    // --- Upload button (file picker) ---

    const _uploadInput = document.createElement("input");
    _uploadInput.type = "file";
    _uploadInput.accept = "image/*";
    _uploadInput.multiple = true;
    _uploadInput.style.display = "none";
    document.body.appendChild(_uploadInput);
    _uploadInput.addEventListener("change", () => {
      const files = [..._uploadInput.files].filter(isImageFile);
      if (files.length > 0) {
        uploadImagesToTerminalFn(files, {
          onSend: rawSend,
          toast: showToast,
          sessionName: getActiveSessionName(),
          sendFn: (msg) => cm.send(msg),
        });
      }
      _uploadInput.value = ""; // reset so same file can be re-selected
    });

    function triggerImageUpload() {
      _uploadInput.click();
    }

    // --- Drag-and-drop (reactive manager) ---

    const dragDropManager = createDragDropManager({
      isImageFile,
      shouldIgnore: (_e) => {
        // Don't hijack drops when the active tile handles its own dnd
        // (e.g. file-browser has built-in file upload drag-drop).
        const state = uiStore.getState();
        const focused = state.tiles[state.focusedId];
        if (!focused) return false;
        return describeTile(focused).handlesDnd === true;
      },
      onDrop: async (imageFiles, totalFiles) => {
        if (imageFiles.length === 0) {
          if (totalFiles > 0) showToast("Not an image file", true);
          return;
        }
        // Upload in parallel, paste via single server request
        uploadImagesToTerminalFn(imageFiles, { onSend: rawSend, toast: showToast, sessionName: getActiveSessionName(), sendFn: (msg) => cm.send(msg) });
      }
    });

    dragDropManager.init();

    // --- Global paste ---

    const pasteHandler = createPasteHandler({
      getSession: () => getActiveSessionName(),
      onImage: uploadImageToTerminal,
      // Use xterm.js paste() so text is wrapped in bracketed paste
      // markers (\x1b[200~…\x1b[201~) when the app has enabled it.
      // Without this, multiline pastes arrive without brackets and
      // each newline is treated as Enter/submit by TUI apps.
      onTextPaste: (text) => {
        const term = getTerm();
        if (term) { term.paste(text); } else { rawSend(text); }
      },
    });
    pasteHandler.init();

    // --- File Browser Tile ---
    //
    // Historically a fullscreen overlay (#file-browser div toggled via
    // toggleFileBrowser). PR #533 stripped the tile plugin SDK; this
    // replaces the overlay with a first-class in-tree tile kind built
    // on the same tile-chrome primitive terminal-tile uses. See
    // public/lib/tiles/file-browser-tile.js.

    function returnToTerminal() {
      if (notepad.isActive()) notepad.hide();
      getTerm()?.focus();
    }

    /** Create a new file-browser tile at the active session's cwd.
     *
     *  Per the tile-clusters design (T1b), every click on the folder
     *  button creates a fresh file-browser tile — no singleton reuse.
     *  Two clicks from two different terminals produce two independent
     *  browser tiles that can sit side-by-side in the carousel. The
     *  previous "focus existing" shortcut was removed because it
     *  conflicts with the multi-instance file-browser UX. */
    async function openFileBrowserTile() {
      const sessionName = getActiveSessionName();
      let cwd = "";
      if (sessionName) {
        try {
          const data = await api.get(`/sessions/cwd/${encodeURIComponent(sessionName)}`);
          if (data.cwd) cwd = data.cwd;
        } catch {}
      }
      const tileId = `file-browser-${Date.now().toString(36)}`;
      // Single dispatch — tile-host mounts via renderer, <tile-tab-bar>
      // picks up the new tile via its ui-store subscription. No manual
      // bar.render() or carousel.addCard().
      uiStore.addTile(
        { id: tileId, type: "file-browser", props: { cwd, sessionName } },
        { focus: true, insertAt: "afterFocus" },
      );
      cm.connect();
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    function openFeedTile() {
      const tileId = `feed-${Date.now().toString(36)}`;
      uiStore.addTile(
        { id: tileId, type: "feed", props: {} },
        { focus: true, insertAt: "afterFocus" },
      );
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    /** Open a feed tile for the Claude session running in the current terminal.
     *
     * Three-way resolution:
     *   1. `meta.claude.uuid` present (SessionStart hook fired) → open the
     *      exact `claude/<uuid>` topic.
     *   2. `meta.claude.running` present but no uuid → Claude is running in
     *      the pane but the hook hasn't reported yet. If hooks aren't
     *      installed, POST to install them so the *next* SessionStart wires
     *      up automatically. Either way, fall through to the picker.
     *   3. No Claude signal at all → open the generic picker.
     */
    async function openClaudeFeedTile() {
      const sessionName = getActiveSessionName();

      if (!sessionName) {
        openFeedTile();
        return;
      }

      const { sessions } = sessionStore.getState();
      const active = (sessions || []).find(s => s.name === sessionName);
      const claudeMeta = active?.meta?.claude || null;

      // Primary: UUID known → open the specific feed directly.
      if (claudeMeta?.uuid) {
        const topic = `claude/${claudeMeta.uuid}`;
        const tileId = `feed-${Date.now().toString(36)}`;
        uiStore.addTile(
          { id: tileId, type: "feed", props: { topic, title: topic, meta: {} } },
          { focus: true, insertAt: "afterFocus" },
        );
        if (isOverlayViewport()) setOverlaySidebar(false);
        return;
      }

      // Running but no uuid: auto-install hooks on first encounter so the
      // next Claude session the user starts wires up without any terminal
      // plumbing. Silent if already installed; one-shot toast otherwise.
      if (claudeMeta?.running) {
        await ensureClaudeHooksInstalled();
      }

      try {
        // Legacy fallback: scan topics for a sessionName match. Resolves
        // Claude sessions that started before MC1f was deployed. Remove
        // once all live Claude sessions have been restarted under the
        // new hook wiring.
        const topics = await api.get("/api/topics");
        const match = topics
          .filter(t => t.name.startsWith("claude/") && t.meta?.sessionName === sessionName)
          .sort((a, b) => (b.messages || 0) - (a.messages || 0))[0];
        if (match) {
          const tileId = `feed-${Date.now().toString(36)}`;
          uiStore.addTile(
            { id: tileId, type: "feed", props: { topic: match.name, title: match.name, meta: match.meta || {} } },
            { focus: true, insertAt: "afterFocus" },
          );
        } else {
          openFeedTile();
        }
      } catch {
        openFeedTile();
      }
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    // Ensure `~/.claude/settings.local.json` has the katulong relay hook
    // wired. Idempotent on the server side — this client only needs to
    // care about the first install, so we track a per-tab flag to avoid
    // retoasting on every click after install.
    let _claudeHooksToasted = false;
    async function ensureClaudeHooksInstalled() {
      try {
        const status = await api.get("/api/claude-hooks/status");
        if (status?.installed) return;
        const result = await api.post("/api/claude-hooks/install", {});
        if (!_claudeHooksToasted && result?.added?.length) {
          _claudeHooksToasted = true;
          showToast("Claude hooks installed. Start a new Claude session for a direct-open feed.");
        }
      } catch {
        // Non-fatal: if install fails the user still gets the topic
        // picker, and surfacing a red error here would be more noise
        // than signal. The manual `katulong setup claude-hooks` path
        // remains available as an escape hatch.
      }
    }

    // --- Localhost Browser (tile) ---

    function openLocalhostBrowserTile() {
      const tileId = `lb-${Date.now().toString(36)}`;
      uiStore.addTile(
        { id: tileId, type: "localhost-browser", props: {} },
        { focus: true, insertAt: "afterFocus" },
      );
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    const sidebarFilesBtn = document.getElementById("sidebar-files-btn");
    if (sidebarFilesBtn) {
      sidebarFilesBtn.addEventListener("click", openFileBrowserTile);
    }

    const sidebarPortfwdBtn = document.getElementById("sidebar-portfwd-btn");
    if (sidebarPortfwdBtn) {
      sidebarPortfwdBtn.addEventListener("click", openLocalhostBrowserTile);
    }

    const sidebarSettingsBtn = document.getElementById("sidebar-settings-btn");
    if (sidebarSettingsBtn) {
      sidebarSettingsBtn.addEventListener("click", () => modals.open('settings'));
    }

    // --- Notepad ---

    const notepad = createNotepad({
      onClose: () => getTerm()?.focus(),
    });

    function toggleNotepad() {
      if (notepad.isActive()) {
        notepad.hide();
      } else {
        notepad.show(getActiveSessionName());
      }
    }

    // --- Connection Manager ---
    //
    // Replaces createWebSocketConnection + createNetworkMonitor. The
    // connection manager owns the WebSocket lifecycle: connect, disconnect,
    // reconnect, heartbeat, and visibility-based reconnection. Message
    // routing is handled by handleWsMessage (below) which dispatches to
    // the pure wsMessageHandlers table and executes side effects.

    // Helper: route output to the correct terminal by session name.
    function getOutputTerm(session) {
      return terminalPool.get(session)?.term || (typeof getTerm === "function" ? getTerm() : null);
    }

    // Pull manager — pure state machine for terminal output streaming.
    // Extracted from websocket-connection.js; callbacks now use cm.send.
    const pulls = createPullManager({
      onSendPull(session, fromSeq) {
        cm.send(JSON.stringify({ type: "pull", session, fromSeq }));
      },
      onWrite(session, data, done) {
        const term = getOutputTerm(session);
        if (term) {
          terminalWriteWithScroll(term, data, done);
        } else {
          // No terminal yet — reject the write so pull manager doesn't
          // advance the cursor. Data will be re-pulled when the terminal
          // is created and a data-available fires.
          done(false);
        }
      },
      onReset(session) {
        const term = getOutputTerm(session);
        if (!term) return;
        // Clear screen + cursor home WITHOUT resetting terminal modes.
        term.write("\x1b[2J\x1b[H");
        term.clear();
      },
    });

    // WebRTC peer for DataChannel negotiation
    let rtcPeer = null;

    // Effect handlers — data-driven lookup instead of switch.
    // Each handler receives the effect object. Moved from websocket-connection.js;
    // deps.X references replaced with direct function calls.
    const effectHandlers = {
      fit: () => requestAnimationFrame(() => fitActiveTerminal()),
      log: (e) => console.log(e.message),
      pasteComplete: (e) => onPasteComplete(e.path),
      scrollToBottomIfNeeded: (e) => { const t = getTerm(); if (e.condition && t) scrollToBottom(t); },
      seqClear: (e) => pulls.clear(e.session || null),
      pullInit: (e) => { if (e.session) pulls.init(e.session, e.seq); },
      dataAvailable: (e) => pulls.dataAvailable(e.session),
      outputReceived: (e) => pulls.outputReceived(e.session, e.data, e.cursor, e.fromSeq),
      pullResponse: (e) => pulls.pullResponse(e.session, e.data, e.cursor),
      pullSnapshot: (e) => pulls.pullSnapshot(e.session, e.data || "", e.cursor),
      stateCheck: (e) => {
        // Lamport's lesson: comparing two states requires they describe the
        // SAME logical time. The server captures fingerprint at byte `e.seq`;
        // the client must wait until its pull cursor has reached that same
        // byte position before comparing.
        const POLL_MS = 50;
        const MAX_WAIT_MS = 2000;
        const deadline = Date.now() + MAX_WAIT_MS;

        function tryCheck() {
          const term = getOutputTerm(e.session);
          if (!term) return true; // session gone — give up

          const ps = pulls.get(e.session);
          if (!ps) return true;

          if (typeof e.seq === 'number' && ps.cursor > e.seq) return true;

          const cursorReady = typeof e.seq !== 'number' || ps.cursor >= e.seq;
          if (ps.writing || ps.pulling || !cursorReady) return false;

          const clientFp = screenFingerprint(term);
          if (clientFp !== e.fingerprint) {
            console.log(`[drift] session=${e.session} server=${e.fingerprint} client=${clientFp} seq=${e.seq} — requesting resync`);
            cm.send(JSON.stringify({ type: "resync", session: e.session }));
          }
          return true;
        }

        if (tryCheck()) return;
        const poll = setInterval(() => {
          if (tryCheck() || Date.now() >= deadline) clearInterval(poll);
        }, POLL_MS);
      },
      terminalReset: () => { const t = getTerm(); if (t) { t.clear(); t.reset(); } },
      terminalWrite: (e) => { const t = e.useOutputTerm ? getOutputTerm(e.session) : getTerm(); if (t) terminalWriteWithScroll(t, e.data); },
      subscribeSnapshot: (e) => {
        const t = getOutputTerm(e.session);
        if (!t) return;
        const buf = t.buffer?.active;
        const isEmpty = buf && buf.baseY === 0 && buf.cursorY === 0 && buf.cursorX === 0;
        if (isEmpty && e.data) {
          t.clear(); t.reset();
          terminalWriteWithScroll(t, e.data);
        }
      },
      reload: () => location.reload(),
      invalidateSessions: (e) => invalidateSessions(sessionStore, e.name),
      updateSessionUI: (e) => {
        setDocTitle(e.name);
        const url = new URL(window.location);
        url.searchParams.set("s", e.name);
        history.replaceState(null, "", url);
        renderBar(e.name);
      },
      syncCarouselSubscriptions: () => syncCarouselSubscriptions(),
      refreshTokensAfterRegistration: () => {
        loadTokens();
        const form = document.getElementById("token-create-form");
        const btn = document.getElementById("settings-create-token");
        if (form) form.style.display = "none";
        if (btn) btn.style.display = "";
      },
      sessionRemoved: (e) => {
        const name = e.name;
        const wasFocused = uiStore.getState().focusedId === name;
        const next = wasFocused ? pickRightNeighbor(name) : null;
        removeDeadSession(name);
        if (!wasFocused) return;
        if (next) {
          switchSession(next);
        } else {
          clearFocusedSessionUI();
        }
      },
      carouselRename: (e) => carousel.renameCard(e.oldName, e.newName),
      poolRename: (e) => terminalPool.rename(e.oldName, e.newName),
      notepadRename: (e) => notepad.rename(e.oldName, e.newName),
      iconStoreRename: (e) => iconStore.rename(e.oldName, e.newName),
      tabRename: (e) => windowTabSet.renameTab(e.oldName, e.newName),
      // Update ui-store tile so getActiveSessionName() returns the new name.
      // Mirrors the tab-rename event path (shortcut-bar initiated rename).
      uiStoreRename: (e) => {
        const st = uiStore.getState();
        const oldTile = st.tiles[e.oldName];
        if (!oldTile) return;
        const wasFocused = st.focusedId === e.oldName;
        uiStore.removeTile(e.oldName);
        uiStore.addTile(
          { id: e.newName, type: oldTile.type, props: { ...oldTile.props, sessionName: e.newName } },
          { focus: wasFocused },
        );
      },
      resizeSync: () => {
        // Another client resized the shared PTY. Recalculate our own
        // dimensions via fitActiveTerminal (font + rows from THIS viewport).
        fitActiveTerminal();
      },
      fastReconnect: () => cm.reconnectNow(),
      tabIconChanged: (e) => {
        if (e.icon) {
          iconStore.setIcon(e.session, e.icon);
        } else {
          iconStore.removeIcon(e.session);
        }
        if (shortcutBarInstance) shortcutBarInstance.render(getActiveSessionName());
      },
      openTab: (e) => {
        windowTabSet.addTab(e.session);
        switchSession(e.session);
      },
      dispatchTopicNew: (e) => {
        window.dispatchEvent(new CustomEvent('katulong:topic-new', {
          detail: { topic: e.topic, meta: e.meta },
        }));
      },
      showNotification: (e) => {
        const t = e.title || "Katulong";
        dispatchNotification(t, e.message);
        showToast(`${t}: ${e.message}`);
      },
      showDeviceAuthRequest: (e) => {
        const overlay = document.getElementById("device-auth-overlay");
        const agentEl = document.getElementById("device-auth-modal-agent");
        const codeEl = document.getElementById("device-auth-modal-code");
        const approveBtn = document.getElementById("device-auth-approve-btn");
        const denyBtn = document.getElementById("device-auth-deny-btn");
        if (!overlay || !agentEl || !codeEl || !approveBtn || !denyBtn) return;

        agentEl.textContent = `Login request from: ${e.userAgent}`;
        codeEl.textContent = String(e.code);
        overlay.classList.add("visible");

        function cleanup() {
          overlay.classList.remove("visible");
          approveBtn.removeEventListener("click", onApprove);
          denyBtn.removeEventListener("click", onDeny);
        }

        async function onApprove() {
          try {
            await api.post("/auth/device-auth/approve", { requestId: e.requestId });
          } catch (err) {
            showToast(`Approve failed: ${err.message}`);
          }
          cleanup();
        }

        async function onDeny() {
          try {
            await api.post("/auth/device-auth/deny", { requestId: e.requestId });
          } catch (err) {
            showToast(`Deny failed: ${err.message}`);
          }
          cleanup();
        }

        approveBtn.addEventListener("click", onApprove);
        denyBtn.addEventListener("click", onDeny);
      },
    };

    function executeEffect(effect) {
      const handler = effectHandlers[effect.type];
      if (handler) handler(effect);
    }

    /**
     * WebRTC upgrade with periodic retry.
     *
     * After attach/switch, tries to upgrade WS → DataChannel. If ICE fails
     * (common through tunnels where server IPs aren't routable), retries on
     * an exponential backoff schedule. Stops retrying once upgraded or when
     * the WS connection itself drops.
     */
    const RTC_RETRY_INITIAL = 30_000;  // 30s after first failure
    const RTC_RETRY_MAX     = 300_000; // cap at 5 min
    const RTC_RETRY_FACTOR  = 2;
    let rtcRetryTimer = null;
    let rtcRetryDelay = RTC_RETRY_INITIAL;
    let rtcConsecutiveFailures = 0;
    const RTC_MAX_CONSECUTIVE = 3; // after 3 failures in a row, stop until network changes

    function clearRtcRetry() {
      if (rtcRetryTimer !== null) {
        clearTimeout(rtcRetryTimer);
        rtcRetryTimer = null;
      }
      rtcRetryDelay = RTC_RETRY_INITIAL;
      rtcConsecutiveFailures = 0;
    }

    function initiateWebRTC() {
      if (typeof RTCPeerConnection === "undefined") return;
      if (rtcConsecutiveFailures >= RTC_MAX_CONSECUTIVE) return; // give up until network changes
      if (rtcPeer) { rtcPeer.close(); rtcPeer = null; }

      rtcPeer = createWebRTCPeer({
        sendSignaling: (msg) => {
          const ws = cm.transport?.ws;
          if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
        },
        onDataChannel: (dc) => {
          const transport = cm.transport;
          if (transport) {
            transport.upgradeToDataChannel(dc);
            cm.transportChanged("datachannel");
            clearRtcRetry();
          }
        },
        onStateChange: (s) => {
          if (s === "failed" || s === "closed") {
            cm.transportChanged("websocket");
            rtcConsecutiveFailures++;
            if (rtcConsecutiveFailures < RTC_MAX_CONSECUTIVE) {
              scheduleRtcRetry();
            }
          }
        },
      });

      rtcPeer.connect();
    }

    function scheduleRtcRetry() {
      clearTimeout(rtcRetryTimer);
      rtcRetryTimer = setTimeout(() => {
        rtcRetryTimer = null;
        // Update delay before initiateWebRTC — if it fails synchronously and
        // calls scheduleRtcRetry again, the delay must already be bumped.
        rtcRetryDelay = Math.min(rtcRetryDelay * RTC_RETRY_FACTOR, RTC_RETRY_MAX);
        const { status, transport } = cm.getState();
        if (status === "ready" && transport !== "datachannel") {
          initiateWebRTC();
        }
      }, rtcRetryDelay);
    }

    // Reset WebRTC retry on network change — conditions may have improved
    if (typeof navigator.connection !== "undefined") {
      navigator.connection.addEventListener("change", () => {
        clearRtcRetry();
        const { status, transport } = cm.getState();
        if (status === "ready" && transport !== "datachannel") initiateWebRTC();
      });
    }

    /** Handle parsed WS messages — dispatches to pure handlers, then executes effects. */
    function handleWsMessage(msg) {
      // WebRTC signaling — handle before regular dispatch
      if (msg.type === "rtc-answer") {
        if (rtcPeer) rtcPeer.handleAnswer(msg.sdp);
        return;
      }
      if (msg.type === "rtc-ice-candidate") {
        if (rtcPeer) rtcPeer.handleCandidate(msg.candidate);
        return;
      }

      const handler = wsMessageHandlers[msg.type];
      if (!handler) return;

      const { stateUpdates, effects } = handler(msg, {
        currentSessionName: getActiveSessionName(),
        scroll: { userScrolledUpBeforeDisconnect: cm.getState().scrolledUpBeforeDisconnect },
      });

      // Apply state updates — session.name updates are now no-ops (derived
      // from uiStore.focusedId). Only scroll state is still mutable here.
      if (stateUpdates) {
        if ('scroll.userScrolledUpBeforeDisconnect' in stateUpdates) {
          cm.setScrolledUp(stateUpdates['scroll.userScrolledUpBeforeDisconnect']);
        }
      }

      // Post-handler: initiate WebRTC on attach/switch
      if (msg.type === "attached" || msg.type === "switched") {
        initiateWebRTC();
      }

      // Execute effects sequentially
      effects.forEach(executeEffect);
    }

    /** When transport is ready, send the attach message. */
    function handleTransportReady(transport) {
      const sessionName = getActiveSessionName();
      if (sessionName) {
        const term = getTerm();
        cm.send(JSON.stringify({
          type: "attach",
          session: sessionName,
          cols: term?.cols || 80,
          rows: term?.rows || 24,
        }));
      }
    }

    // Create connection manager (replaces createWebSocketConnection + createNetworkMonitor)
    const cm = createConnectionManager({
      getSessionName: () => getActiveSessionName(),
      onMessage: handleWsMessage,
      onTransportReady: handleTransportReady,
    });
    cm.init(); // Wire DOM listeners (offline/online/visibilitychange)

    // Connection indicator subscriber — replaces updateConnectionIndicator function.
    // Reacts to connection store state changes and updates all indicator dots.
    let connTooltip = document.getElementById("connection-tooltip");
    if (!connTooltip) {
      connTooltip = document.createElement("div");
      connTooltip.id = "connection-tooltip";
      document.body.appendChild(connTooltip);
    }
    const dotIds = ["sidebar-connection-dot", "joystick-connection-dot"];
    let connTooltipText = "Disconnected";

    // Wire hover listeners to all connection dots. Uses event delegation
    // pattern: dots that don't exist yet (e.g. connection-indicator created
    // by shortcut-bar.js) get wired when the subscriber first finds them.
    const wiredDots = new Set();
    function showTooltipAt(dot) {
      const r = dot.getBoundingClientRect();
      connTooltip.textContent = connTooltipText;
      connTooltip.style.left = `${r.left + r.width / 2}px`;
      connTooltip.style.top = `${r.top - 4}px`;
      connTooltip.style.transform = "translate(-50%, -100%)";
      connTooltip.classList.add("visible");
    }
    function hideTooltip() {
      connTooltip.classList.remove("visible");
    }
    function wireDotTooltip(dot) {
      if (wiredDots.has(dot)) return;
      wiredDots.add(dot);
      // Desktop hover
      dot.addEventListener("mouseenter", () => showTooltipAt(dot));
      dot.addEventListener("mouseleave", hideTooltip);
      // Touch: tap to toggle, tap elsewhere to dismiss
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        if (connTooltip.classList.contains("visible")) {
          hideTooltip();
        } else {
          showTooltipAt(dot);
        }
      });
    }
    // Dismiss tooltip on any outside tap
    document.addEventListener("click", hideTooltip);
    // Wire any dots that exist now
    for (const id of dotIds) {
      const dot = document.getElementById(id);
      if (dot) wireDotTooltip(dot);
    }

    cm.subscribe((connState) => {
      let cssClass = "";
      connTooltipText = "Disconnected";

      if (connState.status === "connecting") {
        cssClass = "connecting";
        connTooltipText = "Connecting\u2026";
      } else if (connState.status === "ready") {
        cssClass = connState.transport === "datachannel" ? "direct" : "relay";
        connTooltipText = connState.transport === "datachannel" ? "Direct (P2P)" : "Relay (WebSocket)";
      }

      for (const id of dotIds) {
        const dot = document.getElementById(id);
        if (!dot) continue;
        wireDotTooltip(dot);
        dot.classList.remove("connected", "relay", "direct", "connecting");
        if (cssClass) dot.classList.add(cssClass);
        dot.removeAttribute("title");
      }

      // Update tooltip text live if it's currently visible
      if (connTooltip.classList.contains("visible")) {
        connTooltip.textContent = connTooltipText;
      }

      const overlay = document.getElementById("disconnect-overlay");
      if (overlay) {
        const showOverlay = connState.status === "disconnected" || connState.status === "connecting";
        overlay.classList.toggle("visible", showOverlay);
        const reconnLabel = overlay.querySelector(".reconnecting-label");
        const disconnLabel = overlay.querySelector(".disconnect-label");
        if (reconnLabel) reconnLabel.style.display = connState.status === "connecting" ? "" : "none";
        if (disconnLabel) disconnLabel.style.display = connState.status === "disconnected" ? "" : "none";
      }

      // joystick dot is now updated via dotIds subscriber above
    });

    // Disconnect handler subscriber — clears pull state and captures scroll position
    // when connection drops (replaces the onclose + onDisconnect callbacks from
    // websocket-connection.js).
    cm.subscribe((connState) => {
      if (connState.status === "disconnected") {
        const term = getTerm();
        cm.setScrolledUp(term ? !isAtBottom(term) : false);
        pulls.clear();
        // Clean up WebRTC peer and retry timer on disconnect
        clearRtcRetry();
        if (rtcPeer) { rtcPeer.close(); rtcPeer = null; }
      }
    });

    // --- Reconcile local tiles against the authoritative server session list ---
    //
    // The server's /sessions response is the only source of truth for which
    // terminal sessions actually exist. When a session is killed on another
    // device while this client is offline, no live event reaches us — but the
    // next sessions fetch (on reconnect, focus, sidebar open) reflects reality.
    // This reconciler removes any terminal tile / tab whose backing session
    // is missing from that list.
    //
    // Threshold pattern: the first server response after RECONNECT can be a
    // partial list (e.g., only the attached session — see adb859d). Pruning
    // on that wipes every other tab. We require RECONCILE_PRUNE_THRESHOLD
    // consecutive non-loading responses where THE SAME dead set persists
    // before acting. Tracking the dead-set identity (not just the count)
    // matters: if pass 1 sees [A] dead and pass 2 sees [B] dead, the counter
    // would otherwise reach 2 and prune B without B getting two confirmations.
    //
    // Boot-pass exemption: the VERY FIRST reconcile after page load is
    // exempt from the threshold. On fresh boot the server is fully
    // initialized before we hit /sessions — the partial-response race only
    // exists post-reconnect. Without this exemption, a user opening the
    // page with N stale phantoms in localStorage gets exactly one reconcile
    // (from the initial store load), it bumps the counter to 1, returns,
    // and nothing ever prunes them unless the user takes another action.
    // That was the failure mode behind the 90-phantom retry storm. The
    // recentlyAdded grace period in windowTabSet already protects URL-boot
    // sessions (?s=liveN) from being mistaken for phantoms during this
    // first pass.
    //
    // Non-terminal tiles (clusters) are skipped here — a cluster is a
    // container, not a session, so serverSet never knows about it. The
    // cluster's own slots own their sub-session lifecycle.
    const RECONCILE_PRUNE_THRESHOLD = 2;
    const reconcilerStore = createReconcilerStore();

    function removeDeadSession(name) {
      // Remove from ui-store if it's a session-backed tile
      const uiState = uiStore.getState();
      const desc = describeTile(uiState.tiles[name]);
      if (desc.session) {
        uiStore.removeTile(name);
      }
      // Tab set: remove + broadcast to other windows on this browser
      windowTabSet.onSessionKilled(name);
      // Pooled terminal
      terminalPool.dispose(name);
    }

    /** Tear down all UI state for the focused session — used when the focused
     *  session is gone and there's nothing to fall back to. Both the live
     *  removal path (onSessionRemoved) and the reconciler call this. */
    function clearFocusedSessionUI() {
      cm.disconnect();
      setDocTitle(null);
      const url = new URL(window.location);
      url.searchParams.delete("s");
      history.replaceState(null, "", url);
      renderBar(null);
    }

    function reconcileTilesAgainstServer() {
      const { sessions: serverList, loading } = sessionStore.getState();
      // An empty server list is valid data — when all sessions have been
      // killed remotely, we still need to drive pruning of stale local tabs.
      // Only bail on in-flight loads or non-array junk.
      if (loading || !Array.isArray(serverList)) return;

      const serverSet = new Set(serverList.map(s => s.name));

      // Confirm any recently-added tabs that the server now knows about,
      // ending their grace period.
      for (const tab of windowTabSet.getTabs()) {
        if (serverSet.has(tab)) windowTabSet.confirmTab(tab);
      }

      // Find dead session-backed tiles: present in ui-store with a
      // server session, but missing from the server list and not in the
      // just-added grace period. Sessionless tiles (file browser) are
      // skipped — they have no server-side session to reconcile against.
      const dead = new Set();
      const uiState = uiStore.getState();
      for (const [tileId, tile] of Object.entries(uiState.tiles)) {
        if (!describeTile(tile).session) continue;
        if (!serverSet.has(tileId) && !windowTabSet.isRecentlyAdded(tileId)) {
          dead.add(tileId);
        }
      }
      // Also check tab-set entries not in ui-store (race condition safety net)
      for (const tab of windowTabSet.getTabs()) {
        if (serverSet.has(tab) || windowTabSet.isRecentlyAdded(tab)) continue;
        const tile = uiState.tiles[tab];
        if (tile && !describeTile(tile).session) continue;
        dead.add(tab);
      }

      if (dead.size === 0) {
        // Consume the boot exemption here too. Without this, a user who
        // loads the page with no phantoms leaves the flag armed; the
        // NEXT reconcile (e.g. after a reconnect that returns a partial
        // /sessions list — the adb859d race) would then bypass the
        // 2-pass threshold and could prune a live session that is only
        // temporarily absent. The exemption must fire exactly once on
        // the first settled server response, regardless of whether
        // anything needed pruning on that pass.
        reconcilerStore.markBootDone();
        reconcilerStore.reset();
        return;
      }

      // Stable key over the dead set. The store resets the counter
      // internally when the dead set changes.
      const deadKey = JSON.stringify([...dead].sort());
      reconcilerStore.confirm(deadKey);

      // Boot-pass exemption: bypass the 2-consecutive-pass threshold on
      // the very first reconcile after page load. See the long comment
      // above RECONCILE_PRUNE_THRESHOLD for why this is safe.
      const rState = reconcilerStore.getState();
      const bootBypass = !rState.bootDone;
      reconcilerStore.markBootDone();
      if (!bootBypass && rState.confirmations < RECONCILE_PRUNE_THRESHOLD) return;
      reconcilerStore.reset();

      const wasFocusedDead = dead.has(uiStore.getState().focusedId);
      for (const name of dead) {
        removeDeadSession(name);
      }

      if (wasFocusedDead) {
        const next = serverList.find(s => !dead.has(s.name));
        if (next) {
          switchSession(next.name);
        } else {
          // No live sessions left — clear UI and stay on page
          clearFocusedSessionUI();
        }
      }
    }

    sessionStore.subscribe(reconcileTilesAgainstServer);

    // --- Boot ---
    //
    // One RESET dispatch. No setTimeout(500), no "carousel-already-active"
    // merge path, no dual URL-vs-restore branches. The boot sequence:
    //
    //   1. Load persisted tile state from localStorage (ui-store).
    //   2. Merge the ?s= URL hint (adds/focuses that terminal).
    //   3. If no persisted state AND no URL hint, fetch /sessions to find
    //      an existing session (avoids creating throwaway tmux sessions).
    //   4. Dispatch RESET — tile-host subscribes and activates the carousel.
    //   5. Connect WebSocket.
    //
    // The old boot had three entry points that each called carousel.activate
    // separately, then a setTimeout(500) restore that merged persisted tiles
    // with whatever the first activate set up. This collapsed into a single
    // RESET because ui-store IS the persistence layer — loadFromStorage()
    // returns the same state the old legacy-carousel restore + merge produced.
    const wasEmptyState = sessionStorage.getItem("katulong-empty-state");
    if (wasEmptyState) sessionStorage.removeItem("katulong-empty-state");

    /** Gather boot-state deps from the window, delegate to the pure
     *  buildBootState() composer, and clear the legacy carousel key if
     *  migration fired. `parseLegacyCarouselStorage` reads localStorage
     *  directly — app.js never queries live carousel state. */
    function gatherBootState() {
      const { state, migratedLegacy } = buildBootState({
        persisted: loadFromStorage(),
        legacyCarousel: parseLegacyCarouselStorage({ isTypePersistable: isPersistable }),
        urlSession: explicitSession,
        tabSetSessions: windowTabSet ? windowTabSet.getTabs() : [],
        getRenderer,
      });
      if (migratedLegacy) {
        try { localStorage.removeItem("katulong-carousel"); } catch {}
      }
      return state;
    }

    function bootFromState(bootState) {
      if (Object.keys(bootState.tiles).length === 0) return;

      // Set doc title from the focused tile's session (if any)
      const focused = bootState.tiles[bootState.focusedId];
      const desc = describeTile(focused);
      if (desc.session) {
        setDocTitle(desc.session);
      }

      // Single dispatch — tile-host is already subscribed (init'd
      // unconditionally above) and will pick up the state change.
      // getActiveSessionName() will derive session from focusedId after this.
      uiStore.reset(bootState);
      cm.connect();
    }

    // Subscribe tile-host unconditionally BEFORE any boot path can
    // dispatch tiles. This ensures the carousel is driven reactively
    // from the store regardless of which boot branch fires — persisted
    // state, server-fetched sessions, empty start, or delayed async.
    // With an empty store, reconcile is a no-op; once tiles arrive
    // (via RESET or ADD_TILE), the subscription picks them up.
    tileHost.init();
    renderBar(getActiveSessionName() || "");

    if (!explicitSession && !wasEmptyState) {
      // No URL hint — check for persisted tiles first, then fall back to
      // fetching /sessions to find an existing session.
      const bootState = gatherBootState();
      if (Object.keys(bootState.tiles).length > 0) {
        bootFromState(bootState);
      } else {
        // No persisted tiles — ask the server for existing sessions.
        // tileHost is already subscribed, so we dispatch via addTile +
        // connect rather than rebuilding a boot state from scratch.
        fetch("/sessions").then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }).then(sessions => {
          if (cm.getState().status !== "disconnected" || uiStore.getState().focusedId !== null) return;
          if (sessions.length > 0 && sessions[0].name) {
            const name = sessions[0].name;
            uiStore.addTile(
              { id: name, type: "terminal", props: { sessionName: name } },
              { focus: true },
            );
            setDocTitle(name);
            cm.connect();
          }
        }).catch(err => {
          console.warn("Failed to fetch sessions on load:", err);
        });
      }
    } else if (!wasEmptyState) {
      // Explicit ?s= — build and boot immediately
      bootFromState(gatherBootState());
    }
    // If wasEmptyState, stay empty — user explicitly closed all tabs.

    if ("serviceWorker" in navigator) {
      // Track whether a controller already exists when the page loads.
      // If controllerchange fires later, a new SW version took over — reload
      // to pick up the updated assets. The guard prevents a reload loop on
      // first-ever SW install (where controller goes from null → active).
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (hadController) window.location.reload();
      });
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    // Safari PWA install hint — show once for non-standalone Safari users
    if (!window.matchMedia("(display-mode: standalone)").matches
        && !window.navigator.standalone
        && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)
        && !localStorage.getItem("katulong_pwa_hint_dismissed")) {
      const isMac = /Macintosh/.test(navigator.userAgent);
      const hint = isMac
        ? "Tip: File → Add to Dock for full app experience"
        : "Tip: Share → Add to Home Screen for full app experience";
      setTimeout(() => {
        showToast(hint);
        localStorage.setItem("katulong_pwa_hint_dismissed", "1");
      }, 3000);
    }

    // Expose the carousel for console testing (flip, focus, inspect).
    window.__tiles = { carousel };
