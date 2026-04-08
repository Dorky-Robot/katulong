    import { ModalRegistry } from "/lib/modal.js";
    import { createTerminalPool } from "/lib/terminal-pool.js";
    import {
      createSessionStore, invalidateSessions,
      createTokenStore, setNewToken, invalidateTokens, removeToken, loadTokens as reloadTokens,
      createShortcutsStore, loadShortcuts as reloadShortcuts,
    } from "/lib/stores.js";
    import { createSessionListComponent, updateSnapshot } from "/lib/session-list-component.js";
    import { api } from "/lib/api-client.js";
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
    import { createWindowTabSet } from "/lib/window-tab-set.js";
    import { createPasteHandler } from "/lib/paste-handler.js";
    import { createNetworkMonitor } from "/lib/network-monitor.js";
    import { createSettingsHandlers } from "/lib/settings-handlers.js";
    import { createTerminalKeyboard } from "/lib/terminal-keyboard.js";
    import { decideAppKey, isTextInputTarget } from "/lib/app-keyboard.js";
    import { createInputSender } from "/lib/input-sender.js";
    import { createViewportManager } from "/lib/viewport-manager.js";
    import { createHelmComponent } from "/lib/helm/helm-component.js";
    import { createWebSocketConnection } from "/lib/websocket-connection.js";
    import { createFileBrowserStore, loadRoot } from "/lib/file-browser/file-browser-store.js";
    import { createFileBrowserComponent } from "/lib/file-browser/file-browser-component.js";
    import { createPortForwardComponent } from "/lib/port-forward/port-forward-component.js";
    import { createNotepad } from "/lib/notepad.js";
    import { createCardCarousel, isCarouselDevice } from "/lib/card-carousel.js";
    import { registerTileType, createTile } from "/lib/tile-registry.js";
    import { createTerminalTileFactory } from "/lib/tiles/terminal-tile.js";
    import { createDashboardTileFactory } from "/lib/tiles/dashboard-tile.js";
    import { createHtmlTileFactory } from "/lib/tiles/html-tile.js";
    import { dispatchNotification } from "/lib/notify.js";
    import { createDispatchPanel } from "/lib/dispatch-panel.js";

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

    // --- Centralized application state (at edge) ---
    const explicitSession = new URLSearchParams(location.search).get("s");
    const createAppState = () => {
      const initialSessionName = explicitSession || null;

      return {
        session: {
          name: initialSessionName,
          shortcuts: []
        },
        connection: {
          ws: null,
          attached: false,
          reconnectDelay: 1000
        },
        scroll: {
          userScrolledUpBeforeDisconnect: false
        },
        // Controlled state updates
        update(path, value) {
          const keys = path.split('.');
          let obj = this;
          for (let i = 0; i < keys.length - 1; i++) {
            obj = obj[keys[i]];
          }
          obj[keys[keys.length - 1]] = value;
          return this;
        },
        // Batch updates
        updateMany(updates) {
          Object.entries(updates).forEach(([path, value]) => {
            this.update(path, value);
          });
          return this;
        }
      };
    };

    const state = createAppState();

    let shortcutBarInstance = null;
    const getInstanceIcon = () => "terminal-window";

    // --- Per-session tab icon overrides ---
    // sessionName -> Phosphor icon name (set via OSC 7337 from terminal processes)
    const sessionIcons = new Map();
    const getSessionIcon = (name) => sessionIcons.get(name) || null;

    // --- Shortcuts state management (reactive store) ---
    const shortcutsStore = createShortcutsStore();
    const loadShortcuts = () => reloadShortcuts(shortcutsStore);

    // Subscribe to shortcuts changes for render side effects
    // Note: shortcuts store subscription moved after renderBar is defined (line ~640)

    // --- Connection Indicator ---

    const updateConnectionIndicator = () => {
      const attached = state.connection.attached;
      const transportType = state.connection.transportType || "websocket";

      // Three-state indicator: grey (disconnected) → yellow (relay/WS) → green (direct/P2P)
      let cssClass, title;
      if (!attached) {
        cssClass = "";
        title = "Disconnected";
      } else if (transportType === "datachannel") {
        cssClass = "direct";
        title = "Direct (P2P)";
      } else {
        cssClass = "relay";
        title = "Relay (WebSocket)";
      }

      for (const id of ["sidebar-connection-dot", "connection-indicator", "island-connection-dot"]) {
        const dot = document.getElementById(id);
        if (!dot) continue;
        dot.classList.remove("connected", "relay", "direct");
        if (cssClass) dot.classList.add(cssClass);
        dot.title = title;
      }
      joystickManager.setConnected(attached);
      // Show/hide disconnect overlay to give visual feedback that input is disabled
      const overlay = document.getElementById("disconnect-overlay");
      if (overlay) overlay.classList.toggle("visible", !attached);
    };

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

    setDocTitle(state.session.name);

    // --- Terminal pool ---
    // One xterm.js Terminal per managed session, visibility-toggled on switch.

    const terminalPool = createTerminalPool({
      parentEl: document.getElementById("terminal-container"),
      onResize: (sessionName, cols, rows) => {
        const ws = state.connection.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", session: sessionName, cols, rows }));
        }
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
            sessionIcons.set(currentName, iconName);
          } else {
            sessionIcons.delete(currentName);
          }
          // Re-render tabs to show the new icon
          if (shortcutBarInstance) shortcutBarInstance.render(state.session.name);
          // Notify server so other clients see the change
          const ws = state.connection.ws;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "set-tab-icon", session: currentName, icon: iconName || null }));
          }
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

    // --- Tile Registry ---
    // terminalDeps uses a getter for carousel since it's created after the registry.
    const terminalDeps = {
      terminalPool,
      createTileFn: createTile,
      get carousel() { return carousel; },
    };
    registerTileType("terminal", createTerminalTileFactory(terminalDeps));
    registerTileType("dashboard", createDashboardTileFactory({ createTileFn: createTile }));
    registerTileType("html", createHtmlTileFactory());

    /** Create a terminal tile for a session, using the session name as tile ID. */
    function makeTerminalTile(sessionName) {
      return { id: sessionName, tile: createTile("terminal", { sessionName }) };
    }

    /** Resolve the session name for a tile ID (works for terminal tiles). */
    function tileSessionName(tileId) {
      const tile = carousel.getTile(tileId);
      return tile?.sessionName || tileId;
    }

    // --- Card Carousel (iPad/tablet) ---
    const carousel = createCardCarousel({
      container: document.getElementById("terminal-container"),
      createTileContext: (tileId, _tile) => ({
        tileId,
        sendWs(msg) {
          const ws = state.connection.ws;
          if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
        },
        onWsMessage(_type, _handler) {
          // Terminal tiles use the existing pull-based output system.
          // Non-terminal tiles will use this in the future.
          return () => {};
        },
        setTitle(_title) {
          // Future: update tab bar dynamically
        },
        setIcon(_icon) {
          // Future: update tab icon dynamically
        },
      }),
      onFocusChange: (tileId) => {
        const sessionName = tileSessionName(tileId);
        state.update('session.name', sessionName);
        setDocTitle(sessionName);
        const url = new URL(window.location);
        url.searchParams.set("s", sessionName);
        history.replaceState(null, "", url);
        if (shortcutBarInstance) shortcutBarInstance.setActiveTab(sessionName);
        // For terminals with content (tab switch): just resize, no switch needed.
        // For empty terminals (new session): send switch to get seq-init + start pulling.
        const ws = state.connection.ws;
        const wsOpen = ws?.readyState === WebSocket.OPEN;
        const entry = terminalPool.get(sessionName);
        const buf = entry?.term?.buffer?.active;
        // Treat undefined buffer as empty — safer to send switch than to skip it.
        // A skipped switch leaves the terminal with no seq-init and no output,
        // making it appear permanently unresponsive to keyboard input.
        const isEmpty = !buf || (buf.baseY === 0 && buf.cursorY === 0 && buf.cursorX === 0);
        if (wsOpen && entry) {
          if (isEmpty) {
            // New session — need switch to get attached + seq-init
            ws.send(JSON.stringify({ type: "switch", session: sessionName, cols: entry.term.cols, rows: entry.term.rows }));
          } else {
            // Existing session — just resize, content is already there
            ws.send(JSON.stringify({ type: "resize", session: sessionName, cols: entry.term.cols, rows: entry.term.rows }));
          }
        } else if (isEmpty) {
          // WS not open but we're switching to a new empty terminal.
          // Trigger reconnection — onopen will send "attach" for the
          // current state.session.name (just updated above), which
          // attaches the client to the new session and initializes
          // the pull mechanism. Without this, the terminal stays
          // permanently stuck with no output and no input routing.
          wsConnection.enableReconnect();
          wsConnection.connect();
        }
        syncCarouselSubscriptions();
        // Reattach scroll-to-bottom button to the newly focused terminal
        _attachScrollButton();
      },
      onCardDismissed: (tileId) => {
        const sessionName = tileSessionName(tileId);
        // Detach: remove from this window's tab set (session stays on server)
        if (windowTabSet) windowTabSet.removeTab(sessionName);
        wsConnection.sendUnsubscribe(sessionName);
      },
      onAllCardsDismissed: () => {
        // All cards dismissed — clear state so refresh shows blank stage
        wsConnection.disconnect();
        state.update('session.name', null);
        setDocTitle(null);
        const url = new URL(window.location);
        url.searchParams.delete("s");
        history.replaceState(null, "", url);
        sessionStorage.setItem("katulong-empty-state", "1");
      },
    });

    /** Subscribe all carousel terminal tiles to WS output.
     *  ALL tiles need subscriptions — including the focused one — because
     *  carousel swipe doesn't send `switch` (no server round-trip). Without
     *  a subscription, data-available notifications are dropped and the
     *  terminal appears stuck. */
    function syncCarouselSubscriptions() {
      if (!carousel.isActive()) return;
      const cards = carousel.getCards();
      for (const tileId of cards) {
        const tile = carousel.getTile(tileId);
        if (tile?.type === "terminal") {
          // Send cols/rows so the server resizes the PTY before serializing
          // the snapshot. Without this, the snapshot wraps at the wrong
          // column width and live output renders garbled.
          const entry = terminalPool.get(tile.sessionName);
          const cols = entry?.term?.cols;
          const rows = entry?.term?.rows;
          wsConnection.sendSubscribe(tile.sessionName, cols, rows);
        }
      }
      carousel.fitAll();
    }

    /** Compute the insertion index that places a new card immediately right
     *  of the currently focused one (Chrome-style "new tab right of active").
     *
     *  Reads from `carousel.getCards()` when the carousel is active — that is
     *  the visible order the user sees, and it can drift from `windowTabSet`
     *  after drag-reorders or isolated removals. Falls back to the tab set
     *  during empty-state boot, before the carousel has been activated.
     *
     *  Returns `undefined` (→ append to end) when there is no active anchor. */
    function insertAtRightOfActive() {
      const order = carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs();
      const idx = order.indexOf(state.session.name);
      return idx >= 0 ? idx + 1 : undefined;
    }

    /** Route a session to the appropriate view (carousel on iPad, switchSession on desktop).
     *  @param {string} name
     *  @param {number} [insertAt] — insertion index for new cards (Chrome-style
     *    "right of active"). Ignored when the card already exists. */
    function routeToSession(name, insertAt) {
      if (!isCarouselDevice()) {
        switchSession(name);
        return;
      }
      if (carousel.isActive()) {
        // Check if a terminal tile for this session already exists
        const existing = carousel.findCard((tile) => tile.sessionName === name);
        if (!existing) {
          const { id, tile } = makeTerminalTile(name);
          carousel.addCard(id, tile, insertAt);
        }
        carousel.focusCard(existing || name);
      } else {
        const allNames = windowTabSet ? [...windowTabSet.getTabs()] : [];
        if (!allNames.includes(name)) allNames.push(name);
        const tiles = allNames.map(n => makeTerminalTile(n));
        carousel.activate(tiles, name);
        if (shortcutBarInstance) shortcutBarInstance.render(name);
      }
    }

    /** Scale the active terminal to fit its container at fixed cols.
     *  The pool's onResize callback handles server notification when
     *  dimensions actually change — no need to send unconditionally. */
    function fitActiveTerminal() {
      requestAnimationFrame(() => {
        if (carousel.isActive()) {
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
    modals.register('settings', 'settings-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
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
      getWebSocket: () => state.connection.ws,
      getTransport: () => state.connection.transport,
      getSession: () => state.session.name,
      onInput: () => {},
    });

    const rawSend = (data) => {
      // Drop all input when not attached — prevents blind typing during
      // disconnection from queuing keystrokes that execute on reconnect.
      if (!state.connection.attached) return;
      inputSender.send(data);
    };

    // Create the initial terminal now that rawSend is available.
    // When no explicit ?s= param, activation is deferred until we
    // resolve which session to attach to (or none).
    if (explicitSession) {
      terminalPool.activate(state.session.name);
    }

    // --- Layout ---

    const termContainer = document.getElementById("terminal-container");
    const bar = document.getElementById("shortcut-bar");

    // --- Joystick (composable state machine) ---
    const joystickManager = createJoystickManager({
      onSend: (sequence) => rawSend(sequence)
    });
    joystickManager.init();

    // Wire Files + Upload + Settings into the joystick floating buttons
    joystickManager.setActions({
      onFilesClick: () => toggleFileBrowser(),
      onUploadClick: () => triggerImageUpload(),
      onSettingsClick: () => modals.open('settings'),
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

    const sessionStore = createSessionStore(state.session.name);
    const windowTabSet = createWindowTabSet({
      sessionStore,
      getCurrentSession: () => state.session.name
    });
    // Ensure the initial session from the URL is in this window's tab set
    if (explicitSession) {
      windowTabSet.addTab(state.session.name);
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
      invalidateSessions(sessionStore, state.session.name);
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
        const name = `session-${Date.now().toString(36)}`;
        const data = await api.post("/sessions", { name, copyFrom: state.session.name });
        if (sidebar?.classList.contains("collapsed")) {
          setSidebarCollapsed(false);
        }
        // Re-enable reconnect if we were in empty state
        wsConnection.enableReconnect();
        // Insert right of the active card (Chrome-style) instead of at the end.
        const insertAt = insertAtRightOfActive();
        windowTabSet.addTab(data.name, insertAt);
        // routeToSession handles both iPad (carousel) and desktop (switchSession)
        routeToSession(data.name, insertAt);
        // If carousel was just activated from empty state, reconnect WS
        if (isCarouselDevice() && carousel.isActive()) {
          wsConnection.connect();
        }
      } catch (err) {
        console.error("Failed to create session:", err);
        showToast(`Failed to create session: ${err.message}`);
      }
    }

    if (sidebarAddBtn) {
      sidebarAddBtn.addEventListener("click", createNewSession);
    }

    // Load session data: always on desktop (for tab bar), or when sidebar is expanded
    if (!isOverlayViewport() || !isInitiallyCollapsed) loadSidebarData();

    // --- Session switching (no page reload) ---
    let pendingSwitch = null;
    // Late-bound: viewportManager is created after activateSession but called lazily
    let _attachScrollButton = () => {};

    function activateSession(name) {
      // Close alternative views — switching sessions returns to terminal
      if (portForwardEl?.classList.contains("active")) closePortForward();
      if (fileBrowserEl?.classList.contains("active")) closeFileBrowser();
      if (notepad.isActive()) notepad.hide();
      // If the target session has an active helm session, show helm view; otherwise terminal
      if (helmActiveSessions.has(name)) {
        showHelmView();
        helmComponent?.showSession(name);
      } else if (helmViewEl?.classList.contains("active")) {
        hideHelmView();
      }

      // Ensure session is in this window's tab set
      if (!windowTabSet.hasTab(name)) {
        windowTabSet.addTab(name);
      }

      // On iPad/tablet, route through carousel (onFocusChange handles state sync)
      if (isCarouselDevice()) {
        routeToSession(name);
        invalidateSessions(sessionStore, name);
        return;
      }

      const ws = state.connection.ws;
      const wsOpen = ws && ws.readyState === WebSocket.OPEN;

      const wasCached = terminalPool.has(name);
      const entry = terminalPool.activate(name);

      // If this is a fresh terminal (not cached), clear it so we start clean
      if (!wasCached) {
        entry.term.clear();
        entry.term.reset();
      }

      // Visual updates only — state.session.name is set by the server's
      // "switched" or "attached" confirmation to avoid stale routing during
      // the switch window.
      setDocTitle(name);

      if (wsOpen) {
        // Switch session over the existing WebSocket — no disconnect/reconnect needed
        pendingSwitch = name;
        ws.send(JSON.stringify({ type: "switch", session: name, cols: entry.term.cols, rows: entry.term.rows, cached: wasCached }));
      } else if (!ws || ws.readyState === WebSocket.CLOSED) {
        // No WebSocket yet — set session name for the attach message, then connect
        state.update('session.name', name);
        wsConnection.connect();
      }
      if (shortcutBarInstance) shortcutBarInstance.render(name);
      invalidateSessions(sessionStore, name);
      // Attach scroll-to-bottom button listener to the new viewport.
      // scroll events don't bubble, so we must listen on the viewport directly.
      _attachScrollButton();
    }

    function switchSession(name) {
      if (name === state.session.name || name === pendingSwitch) return;
      const url = new URL(window.location);
      url.searchParams.set("s", name);
      history.pushState(null, "", url);
      activateSession(name);
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    window.addEventListener("popstate", () => {
      const name = new URLSearchParams(location.search).get("s");
      if (!name) return; // bare URL without ?s= — stay on current session
      if (name !== state.session.name && name !== pendingSwitch) activateSession(name);
    });

    const openSessionManager = () => toggleSidebar();

    // --- Keyboard shortcuts (Cmd+Shift+[/], Cmd+?) ---

    function navigateTab(direction) {
      // Use carousel order (source of truth) when active, fall back to tab set
      const tabs = carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs();
      if (tabs.length <= 1) return;
      const idx = tabs.indexOf(state.session.name);
      if (idx === -1) return;
      switchSession(tabs[(idx + direction + tabs.length) % tabs.length]);
    }

    function moveTab(direction) {
      const tabs = carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs();
      if (tabs.length <= 1) return;
      const idx = tabs.indexOf(state.session.name);
      if (idx === -1) return;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= tabs.length) return; // don't wrap
      // Swap in the tab array
      const reordered = [...tabs];
      [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
      windowTabSet.reorderTabs(reordered);
      if (carousel.isActive()) carousel.reorderCards(reordered);
    }

    // Positional tab jump — Option+1..9 → tabs 1..9, Option+0 → tab 10.
    // Silently no-ops if the target index doesn't exist (e.g., Option+7 with
    // only 4 tabs open). Pure positional; deliberately does NOT implement the
    // Chrome "Cmd+9 = last tab" trick, because we also expose Option+0 as
    // "tab 10" — mixing "last" and "10th" would be inconsistent.
    function jumpToTab(position) {
      const tabs = carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs();
      const idx = position - 1;
      if (idx < 0 || idx >= tabs.length) return;
      const name = tabs[idx];
      if (name === state.session.name) return;
      if (isCarouselDevice() && carousel.isActive()) {
        routeToSession(name);
      } else {
        switchSession(name);
      }
    }

    function renameCurrentSession() {
      const name = state.session.name;
      if (!name || !shortcutBarInstance) return;
      shortcutBarInstance.beginRename(name);
    }

    function closeCurrentSession() {
      const name = state.session.name;
      if (!name) return;
      const tabs = carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs();
      const idx = tabs.indexOf(name);
      const next = tabs.length > 1
        ? tabs[idx === tabs.length - 1 ? idx - 1 : idx + 1]
        : null;
      if (next) switchSession(next);
      if (carousel.isActive()) {
        carousel.removeCard(name);
      } else {
        windowTabSet.removeTab(name);
        wsConnection.sendUnsubscribe(name);
      }
      terminalPool.dispose(name);
      // Last tab closed — show the add session menu
      if (!next && shortcutBarInstance) {
        const addBtn = document.querySelector(".ipad-add-btn, .tab-add-btn");
        shortcutBarInstance.showAddMenu(addBtn);
      }
    }

    async function killCurrentSession() {
      const name = state.session.name;
      if (!name) return;
      const tabs = carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs();
      const idx = tabs.indexOf(name);
      const next = tabs.length > 1
        ? tabs[idx === tabs.length - 1 ? idx - 1 : idx + 1]
        : null;
      if (next) switchSession(next);
      // Remove from UI immediately
      if (carousel.isActive()) {
        carousel.removeCard(name);
      } else {
        windowTabSet.removeTab(name);
        wsConnection.sendUnsubscribe(name);
      }
      terminalPool.dispose(name);
      // Kill on server (best-effort — may fail if disconnected)
      try {
        await api.delete(`/sessions/${encodeURIComponent(name)}`);
      } catch { /* disconnected or already dead — that's fine */ }
      // Last tab — show add menu
      if (!next && shortcutBarInstance) {
        const addBtn = document.querySelector(".ipad-add-btn, .tab-add-btn");
        shortcutBarInstance.showAddMenu(addBtn);
      }
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
      toggleHelp: () => toggleKeyboardHelp(),
      newSession: () => createNewSession(),
      closeSession: () => closeCurrentSession(),
      killSession: () => killCurrentSession(),
      renameSession: () => renameCurrentSession(),
      navigateTab: (dir) => navigateTab(dir),
      moveTab: (dir) => moveTab(dir),
      jumpToTab: (n) => jumpToTab(n),
    };

    document.addEventListener("keydown", (ev) => {
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
    }, true); // Capture phase to intercept before browser defaults

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
        if (!enabled && portForwardEl.classList.contains("active")) {
          closePortForward();
          getTerm()?.focus();
        }
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
    {
      const statusEl = document.getElementById("notification-permission-status");
      const descEl = document.getElementById("notification-permission-desc");
      const row = document.getElementById("notification-permission-row");
      if (row && statusEl && descEl) {
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
            // Create enable button inline
            statusEl.innerHTML = "";
            const btn = document.createElement("button");
            btn.className = "shortcut-btn";
            btn.textContent = "Enable";
            btn.addEventListener("click", () => {
              Notification.requestPermission().then((p) => {
                if (p === "granted") {
                  btn.replaceWith(document.createTextNode("Enabled"));
                  statusEl.style.color = "var(--success)";
                  descEl.textContent = "You\u2019ll receive alerts from katulong notify commands.";
                } else {
                  btn.replaceWith(document.createTextNode("Blocked"));
                  statusEl.style.color = "var(--error, #f38ba8)";
                  descEl.textContent = "Notifications were blocked. Reset in your browser or system settings.";
                }
              });
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
      }
    }

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
      const baseUrlEl = document.getElementById("api-base-url");

      async function loadApiKeys() {
        if (!listEl) return;
        try {
          const keys = await api.get("/api/api-keys");
          if (!keys.length) { listEl.innerHTML = '<p class="tokens-loading">No API keys yet.</p>'; return; }
          listEl.innerHTML = keys.map(k => `
            <div class="token-item" data-id="${k.id}">
              <div class="token-item-info">
                <span class="token-item-name">${k.name}</span>
                <span class="token-item-meta">${k.prefix}... · ${k.lastUsedAt ? "used " + new Date(k.lastUsedAt).toLocaleDateString() : "never used"}</span>
              </div>
              <button class="token-item-revoke" data-id="${k.id}">Revoke</button>
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

      async function loadBaseUrl() {
        if (!baseUrlEl) return;
        try {
          const { url } = await api.get("/api/external-url");
          baseUrlEl.innerHTML = url ? "Base URL: <code>" + url + "</code>" : "Create API keys for external access.";
        } catch { baseUrlEl.textContent = "Create API keys for external access."; }
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
            el.innerHTML = '<div class="token-item-info"><span class="token-item-name">' + data.name + '</span>'
              + '<code style="display:block;margin-top:0.25rem;font-size:0.75rem;word-break:break-all;color:var(--success);cursor:pointer;">' + data.key + '</code>'
              + '<span class="token-item-meta">Click key to copy. It won\'t be shown again.</span></div>';
            el.querySelector("code").addEventListener("click", () => navigator.clipboard.writeText(data.key).then(() => showToast("Copied!")));
            listEl.prepend(el);
            setTimeout(() => { el.remove(); loadApiKeys(); }, 30000);
          } catch (err) { showToast(err.message, true); }
        });
      }

      document.querySelectorAll(".settings-tab").forEach(tab => {
        tab.addEventListener("click", () => { if (tab.dataset.tab === "api") { loadApiKeys(); loadBaseUrl(); } });
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
      onSessionClick: openSessionManager,
      onNewSessionClick: createNewSession,
      tileTypes: [
        { type: "terminal", name: "Terminal", icon: "terminal-window" },
      ],
      onCreateTile: (type, _meta) => {
        if (type === "terminal") {
          // Terminal tiles create a server-side session
          createNewSession();
        } else if (carousel.isActive()) {
          // Non-terminal tiles: create directly in the carousel. We require
          // `carousel.isActive()` (not just `isCarouselDevice()`) — otherwise
          // `carousel.addCard` silently no-ops while `windowTabSet.addTab`
          // would still run, leaving a tab-set entry with no matching card.
          const id = `${type}-${Date.now().toString(36)}`;
          const options = type === "dashboard"
            ? { cols: 2, rows: 1, title: "Dashboard", slots: [] }
            : { title: `New ${_meta?.name || type}`, html: `<div style="padding:40px;text-align:center;opacity:0.5"><h2>${_meta?.name || type}</h2><p>Empty tile — content will appear here.</p></div>` };
          const tile = createTile(type, options);
          // Insert right of the active card (Chrome-style). Same insertAt
          // goes to both stores so their order cannot drift apart.
          const insertAt = insertAtRightOfActive();
          carousel.addCard(id, tile, insertAt);
          carousel.focusCard(id);
          windowTabSet.addTab(id, insertAt);
          if (shortcutBarInstance) shortcutBarInstance.render(id);
        }
      },
      onTabClick: (name) => {
        if (isCarouselDevice() && carousel.isActive()) {
          routeToSession(name);
        } else {
          switchSession(name);
        }
      },
      onNotepadClick: () => toggleNotepad(),
      get notepad() { return notepad; },
      onTabRenamed: (oldName, newName) => {
        // Rename carousel card BEFORE tab set — the tab set's notify()
        // triggers reorderCards which needs the card ID already updated.
        if (carousel.isActive()) carousel.renameCard(oldName, newName);
        terminalPool.rename(oldName, newName);
        notepad.rename(oldName, newName);
        // Update the tab element in-place BEFORE triggering store updates
        // to prevent a full re-render that causes the tab to visually jump.
        if (shortcutBarInstance) shortcutBarInstance.renameTabEl(oldName, newName);
        windowTabSet.renameTab(oldName, newName);
        invalidateSessions(sessionStore, newName);
        if (state.session.name === oldName) {
          state.update('session.name', newName);
          setDocTitle(newName);
          const url = new URL(window.location);
          url.searchParams.set("s", newName);
          history.replaceState(null, "", url);
        }
      },
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
      onFilesClick: () => toggleFileBrowser(),
      onPortForwardClick: () => togglePortForward(),
      onSettingsClick: () => modals.open('settings'),
      onShortcutsClick: () => openShortcutsPopup(state.session.shortcuts),
      onDictationClick: () => openDictationModal(),
      onAllTabsClosed: () => {
        // Hide all terminal panes, disconnect WS, clear state
        terminalPool.forEach((name) => terminalPool.dispose(name));
        wsConnection.disconnect();
        state.update('session.name', null);
        setDocTitle(null);
        const url = new URL(window.location);
        url.searchParams.delete("s");
        history.replaceState(null, "", url);
      },
      sendFn: rawSend,
      get term() { return getTerm(); },
      terminalPool,
      updateConnectionIndicator,
      getInstanceIcon,
      getSessionIcon,
      sessionStore,
      windowTabSet,
      carousel,
    });

    // Sync carousel card order when tabs are reordered via the shortcut bar
    if (windowTabSet) {
      windowTabSet.subscribe(() => {
        if (carousel.isActive()) {
          carousel.reorderCards(windowTabSet.getTabs());
        }
      });
    }

    // Re-render bar if pointer capability changes (e.g., external mouse connected)
    window.matchMedia("(pointer: fine)").addEventListener("change", () => {
      shortcutBarInstance.render(state.session.name);
    });

    const renderBar = (name) => shortcutBarInstance.render(name);

    // Sync per-session icons from server session data
    sessionStore.subscribe(() => {
      const { sessions } = sessionStore.getState();
      if (!sessions) return;
      for (const s of sessions) {
        if (s.icon) {
          sessionIcons.set(s.name, s.icon);
        } else {
          sessionIcons.delete(s.name);
        }
      }
    });

    // Subscribe to shortcuts changes to re-render bar
    shortcutsStore.subscribe((shortcuts) => {
      // Update legacy state object (for backward compatibility)
      state.update('session.shortcuts', shortcuts);

      // Re-render bar when shortcuts change
      renderBar(state.session.name);
    });



    // --- Image upload (using imported helpers) ---
    const uploadImageToTerminal = (file, sessionName) => uploadImageToTerminalFn(file, {
      onSend: rawSend,
      toast: showToast,
      sessionName: sessionName || state.session.name,
      getWebSocket: () => state.connection.ws
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
          sessionName: state.session.name,
          getWebSocket: () => state.connection.ws,
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
      shouldIgnore: (e) => fileBrowserEl.classList.contains("active"),
      onDrop: async (imageFiles, totalFiles) => {
        if (imageFiles.length === 0) {
          if (totalFiles > 0) showToast("Not an image file", true);
          return;
        }
        // Upload in parallel, paste via single server request
        uploadImagesToTerminalFn(imageFiles, { onSend: rawSend, toast: showToast, sessionName: state.session.name, getWebSocket: () => state.connection.ws });
      }
    });

    dragDropManager.init();

    // --- Global paste ---

    const pasteHandler = createPasteHandler({
      getSession: () => state.session.name,
      onImage: (file, sessionName) => uploadImageToTerminal(file, sessionName),
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

    // --- File Browser ---

    const fileBrowserStore = createFileBrowserStore();
    const fileBrowserEl = document.getElementById("file-browser");
    let fileBrowserMounted = false;
    let fileBrowserComponent = null;

    function returnToTerminal() {
      if (portForwardEl?.classList.contains("active")) closePortForward();
      if (fileBrowserEl?.classList.contains("active")) closeFileBrowser();
      if (notepad.isActive()) notepad.hide();
      if (helmViewEl?.classList.contains("active")) hideHelmView();
      getTerm()?.focus();
    }

    function closePortForward() {
      portForwardEl.classList.remove("active");
      termContainer.classList.remove("pf-hidden");
      bar.style.display = "";
      if (joystickEl) joystickEl.style.display = "";
    }

    function closeFileBrowser() {
      fileBrowserEl.classList.remove("active");
      termContainer.classList.remove("fb-hidden");
    }

    async function toggleFileBrowser() {
      const isActive = fileBrowserEl.classList.contains("active");
      if (isActive) {
        closeFileBrowser();
        getTerm()?.focus();
      } else {
        // Close other panels if open (mutual exclusion)
        if (portForwardEl.classList.contains("active")) closePortForward();

        // Get the active terminal's working directory
        let cwd = "";
        const sessionName = state.session.name;
        if (sessionName) {
          try {
            const data = await api.get(`/sessions/cwd/${encodeURIComponent(sessionName)}`);
            if (data.cwd) cwd = data.cwd;
          } catch {}
        }

        if (!fileBrowserMounted) {
          fileBrowserComponent = createFileBrowserComponent(fileBrowserStore, {
            onClose: () => toggleFileBrowser(),
          });
          fileBrowserComponent.mount(fileBrowserEl);
          fileBrowserMounted = true;
        }
        loadRoot(fileBrowserStore, cwd);
        termContainer.classList.add("fb-hidden");
        fileBrowserEl.classList.add("active");
        fileBrowserComponent.focus();
      }
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    // --- Port Forward ---

    const portForwardEl = document.getElementById("port-forward");
    let portForwardMounted = false;
    let portForwardComponent = null;

    function togglePortForward() {
      const isActive = portForwardEl.classList.contains("active");
      if (isActive) {
        closePortForward();
        getTerm()?.focus();
      } else {
        // Close other panels if open (mutual exclusion)
        if (fileBrowserEl.classList.contains("active")) closeFileBrowser();
        if (!portForwardMounted) {
          portForwardComponent = createPortForwardComponent({
            onClose: () => togglePortForward(),
          });
          portForwardComponent.mount(portForwardEl);
          portForwardMounted = true;
        }
        termContainer.classList.add("pf-hidden");
        portForwardEl.classList.add("active");
        bar.style.display = "none";
        if (joystickEl) joystickEl.style.display = "none";
        portForwardComponent.focus();
      }
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    // --- Dispatch panel (right-side, independent of session sidebar) ---
    const dispatchSidebar = document.getElementById("dispatch-sidebar");
    const dispatchContainer = document.getElementById("dispatch-container");
    const dispatchFab = document.getElementById("dispatch-fab");
    const dispatchCloseBtn = document.getElementById("dispatch-close-btn");
    let dispatchPanel = null;

    function openDispatch() {
      if (!dispatchPanel && dispatchContainer) {
        dispatchPanel = createDispatchPanel(dispatchContainer);
      }
      dispatchSidebar?.classList.remove("dispatch-closed");
      dispatchFab?.classList.add("dispatch-open");
      // Blur terminal so keystrokes go to the dispatch input
      getTerm()?.blur();
    }

    function closeDispatch() {
      dispatchSidebar?.classList.add("dispatch-closed");
      dispatchFab?.classList.remove("dispatch-open");
      getTerm()?.focus();
    }

    if (dispatchFab) dispatchFab.addEventListener("click", openDispatch);
    if (dispatchCloseBtn) dispatchCloseBtn.addEventListener("click", closeDispatch);

    const sidebarFilesBtn = document.getElementById("sidebar-files-btn");
    if (sidebarFilesBtn) {
      sidebarFilesBtn.addEventListener("click", toggleFileBrowser);
    }

    const sidebarPortfwdBtn = document.getElementById("sidebar-portfwd-btn");
    if (sidebarPortfwdBtn) {
      sidebarPortfwdBtn.addEventListener("click", togglePortForward);
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
        notepad.show(state.session.name);
      }
    }

    // --- Helm Mode ---

    const helmViewEl = document.getElementById("helm-view");
    let helmMounted = false;
    let helmComponent = null;
    // Track which sessions are in helm mode (per-session, not global)
    const helmActiveSessions = new Set();

    function ensureHelmMounted() {
      if (helmMounted) return;
      helmComponent = createHelmComponent({
        onSendMessage: (session, content) => {
          const ws = state.connection.ws;
          if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "helm-input", session, content }));
          }
        },
        onAbort: (session) => {
          const ws = state.connection.ws;
          if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "helm-abort", session }));
          }
        },
        onToggleTerminal: () => toggleHelmView(),
      });
      helmComponent.mount(helmViewEl);
      helmMounted = true;
    }

    function showHelmView() {
      ensureHelmMounted();
      if (fileBrowserEl?.classList.contains("active")) closeFileBrowser();
      if (portForwardEl?.classList.contains("active")) closePortForward();
      termContainer.classList.add("helm-hidden");
      helmViewEl.classList.add("active");
      helmComponent.showSession(state.session.name);
      helmComponent.focus();
    }

    function hideHelmView() {
      helmViewEl.classList.remove("active");
      termContainer.classList.remove("helm-hidden");
      getTerm()?.focus();
    }

    function toggleHelmView() {
      if (helmViewEl.classList.contains("active")) {
        hideHelmView();
      } else if (helmActiveSessions.has(state.session.name)) {
        showHelmView();
      }
    }

    function onHelmModeChanged(effect) {
      if (effect.active) {
        helmActiveSessions.add(effect.session);
        ensureHelmMounted();
        helmComponent.helmStarted(effect.session, {
          agent: effect.agent,
          prompt: effect.prompt,
          cwd: effect.cwd,
        });
        // Auto-switch to helm view if this is the active session
        if (effect.session === state.session.name) {
          showHelmView();
        }
      } else {
        helmActiveSessions.delete(effect.session);
        helmComponent?.helmEnded(effect.session, {
          result: effect.result,
          error: effect.error,
        });
        // If viewing helm for this session and it ended, switch back to terminal
        if (effect.session === state.session.name && helmViewEl.classList.contains("active")) {
          hideHelmView();
        }
      }
      // Re-render the tab bar to show/hide helm indicator
      renderBar(state.session.name);
    }

    // --- Network change monitoring ---

    const networkMonitor = createNetworkMonitor({
      onNetworkChange: () => {
        // Network changed — WebSocket will handle reconnection if needed
      }
    });
    networkMonitor.init();

    // --- WebSocket Connection ---

    const wsConnection = createWebSocketConnection({
      term: getTerm,
      getTermForSession: (session) => terminalPool.get(session)?.term || null,
      state,
      updateConnectionIndicator,
      isAtBottom,
      invalidateSessions: (name) => invalidateSessions(sessionStore, name),
      syncCarouselSubscriptions: () => syncCarouselSubscriptions(),
      updateSessionUI: (name) => {
        pendingSwitch = null;
        setDocTitle(name);
        const url = new URL(window.location);
        url.searchParams.set("s", name);
        history.replaceState(null, "", url);
        renderBar(name);
      },
      refreshTokensAfterRegistration: () => {
        loadTokens();
        const form = document.getElementById("token-create-form");
        const btn = document.getElementById("settings-create-token");
        if (form) form.style.display = "none";
        if (btn) btn.style.display = "";
      },
      onSessionRemoved: (name) => {
        windowTabSet.onSessionKilled(name);
        terminalPool.dispose(name);
        fetch("/sessions").then(r => r.json()).then(allSessions => {
          // Filter out the session that was just removed (may still be in the response)
          const sessions = allSessions.filter(s => s.name !== name);
          if (sessions.length > 0) {
            const next = sessions[0].name;
            switchSession(next);
          } else {
            // No sessions left — disconnect WS, clear UI, stay on page
            wsConnection.disconnect();
            state.update('session.name', null);
            setDocTitle(null);
            const url = new URL(window.location);
            url.searchParams.delete("s");
            history.replaceState(null, "", url);
            renderBar(null);
          }
        }).catch(() => {
          wsConnection.disconnect();
          state.update('session.name', null);
          setDocTitle(null);
        });
      },
      onDisconnect: () => { pendingSwitch = null; },
      poolRename: (oldName, newName) => terminalPool.rename(oldName, newName),
      tabRename: (oldName, newName) => windowTabSet.renameTab(oldName, newName),
      fit: fitActiveTerminal,
      // Helm mode
      onHelmModeChanged,
      onHelmEvent: (session, event) => helmComponent?.helmEvent(session, event),
      onHelmTurnComplete: (session) => helmComponent?.helmTurnComplete(session),
      onHelmWaitingForInput: (session) => helmComponent?.helmWaitingForInput(session),
      onPasteComplete: (path) => onPasteComplete(path),
      onTabIconChanged: (session, icon) => {
        if (icon) {
          sessionIcons.set(session, icon);
        } else {
          sessionIcons.delete(session);
        }
        if (shortcutBarInstance) shortcutBarInstance.render(state.session.name);
      },
      onOpenTab: (session) => {
        windowTabSet.addTab(session);
        switchSession(session);
      },
      onNotification: (title, message) => {
        const t = title || "Katulong";
        dispatchNotification(t, message);
        // Always show in-app toast so notifications are visible even
        // when native notifications aren't available (e.g., Android
        // Chrome without PWA install, or permission not granted).
        showToast(`${t}: ${message}`);
      },
      onDeviceAuthRequest: (requestId, code, userAgent) => {
        const overlay = document.getElementById("device-auth-overlay");
        const agentEl = document.getElementById("device-auth-modal-agent");
        const codeEl = document.getElementById("device-auth-modal-code");
        const approveBtn = document.getElementById("device-auth-approve-btn");
        const denyBtn = document.getElementById("device-auth-deny-btn");
        if (!overlay || !agentEl || !codeEl || !approveBtn || !denyBtn) return;

        // Use textContent to prevent XSS from user-agent strings
        agentEl.textContent = `Login request from: ${userAgent}`;
        codeEl.textContent = String(code);
        overlay.classList.add("visible");

        function cleanup() {
          overlay.classList.remove("visible");
          approveBtn.removeEventListener("click", onApprove);
          denyBtn.removeEventListener("click", onDeny);
        }

        async function onApprove() {
          try {
            await api.post("/auth/device-auth/approve", { requestId });
          } catch (err) {
            showToast(`Approve failed: ${err.message}`);
          }
          cleanup();
        }

        async function onDeny() {
          try {
            await api.post("/auth/device-auth/deny", { requestId });
          } catch (err) {
            showToast(`Deny failed: ${err.message}`);
          }
          cleanup();
        }

        approveBtn.addEventListener("click", onApprove);
        denyBtn.addEventListener("click", onDeny);
      },
    });
    wsConnection.initVisibilityReconnect();

    // --- Boot ---

    // If no explicit ?s= param, resolve an existing session before connecting
    // to avoid creating a throwaway "default" tmux session.
    // If user explicitly closed all tabs, stay in empty state.
    const wasEmptyState = sessionStorage.getItem("katulong-empty-state");
    if (wasEmptyState) sessionStorage.removeItem("katulong-empty-state");

    if (!explicitSession) {
      fetch("/sessions").then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }).then(sessions => {
        // Guard: if the user already picked a session while the fetch was in-flight, skip
        if (state.connection.ws || state.session.name !== null) return;
        // If user explicitly closed all tabs, don't auto-attach
        if (wasEmptyState) return;
        if (sessions.length > 0 && sessions[0].name) {
          const name = sessions[0].name;
          state.update('session.name', name);
          setDocTitle(name);
          const url = new URL(window.location);
          url.searchParams.set("s", name);
          history.replaceState(null, "", url);
          if (isCarouselDevice()) {
            const tabSessions = windowTabSet.getTabs();
            const allNames = tabSessions.length > 0 ? [...tabSessions] : [name];
            if (!allNames.includes(name)) allNames.unshift(name);
            carousel.activate(allNames.map(n => makeTerminalTile(n)), name);
            renderBar(name);
          } else {
            terminalPool.activate(name);
            renderBar(name);
          }
          windowTabSet.addTab(name);
          wsConnection.connect();
        }
        // If no sessions exist, stay empty — user can create one via session list
      }).catch((err) => {
        console.warn("Failed to fetch sessions on load:", err);
        // Stay empty rather than creating a throwaway "default" session.
        // User can create or pick a session via the sidebar.
      });
    } else {
      // Explicit ?s= session — activate carousel on iPad/tablet
      if (isCarouselDevice()) {
        const tabSessions = windowTabSet.getTabs();
        const allNames = tabSessions.length > 0 ? [...tabSessions] : [state.session.name];
        if (state.session.name && !allNames.includes(state.session.name)) allNames.unshift(state.session.name);
        carousel.activate(allNames.map(n => makeTerminalTile(n)), state.session.name);
        renderBar(state.session.name);
      } else {
        renderBar(state.session.name);
      }
      wsConnection.connect();
    }
    loadShortcuts();
    getTerm()?.focus();

    // Restore carousel state from sessionStorage after a short delay
    setTimeout(() => {
      const carouselState = carousel.restore();
      if (carouselState && carouselState.tiles?.length > 0 && !carousel.isActive()) {
        const tiles = carouselState.tiles.map(t => {
          const tile = createTile(t.type, t);
          return { id: t.id, tile, cardWidth: t.cardWidth };
        });
        carousel.activate(tiles, carouselState.focused);
        // Sync tab set to carousel order (carousel is source of truth)
        if (windowTabSet) windowTabSet.reorderTabs(carousel.getCards());
      }
    }, 500);

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

    // Expose tile system for console testing / plugin development
    window.__tiles = { carousel, createTile, registerTileType };
