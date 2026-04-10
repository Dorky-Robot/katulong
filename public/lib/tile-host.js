/**
 * Tile Host — reactive bridge between ui-store and card-carousel.
 *
 * Subscribes to the ui-store and translates state changes into carousel
 * commands: mount new tiles, unmount removed ones, reorder, and shift
 * focus. The carousel keeps its visual presentation (gestures, animations,
 * expose mode) — tile-host just drives it declaratively from state.
 *
 * This replaces the imperative activate/addCard/removeCard/focusCard
 * calls scattered across app.js, shortcut-bar.js, and the restore path.
 * All tile lifecycle now flows through one subscription.
 *
 * Design: docs/tile-state-rewrite.md, Step 3.
 */

/**
 * Create a tile host.
 *
 * @param {object} opts
 * @param {object} opts.store — ui-store instance (getState, subscribe, dispatch)
 * @param {object} opts.carousel — card-carousel instance
 * @param {function} opts.getRenderer — (type) → renderer object (from tile-renderers registry)
 * @param {function} [opts.onFocusChange] — called after carousel focus settles,
 *   with (tileId, tileType). App.js uses this for WS subscription switching.
 */
export function createTileHost({ store, carousel, getRenderer, onFocusChange, onTileRemoved }) {
  // Map<tileId, { unmount, focus, blur, resize, tile }>
  const handles = new Map();
  let prevState = null;
  let unsubscribe = null;
  // Guard against re-entrant subscription notifications. When tile-host
  // dispatches UPDATE_PROPS (e.g. from a file-browser cwd change routed
  // through the renderer's setTitle shim), the store fires subscribers
  // synchronously. Without this guard, reconcile() would re-enter itself,
  // see a half-updated prevState, and double-mount or double-unmount.
  let reconciling = false;

  function reconcile(state) {
    if (reconciling) return;
    reconciling = true;
    try {
      _reconcile(state);
    } finally {
      reconciling = false;
    }
  }

  function _reconcile(state) {
    const prev = prevState || { tiles: {}, order: [], focusedId: null };
    prevState = state;

    // ── Diff tiles ─────────────────────────────────────────────────
    const prevIds = new Set(Object.keys(prev.tiles));
    const nextIds = new Set(Object.keys(state.tiles));

    // Removed tiles
    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        const handle = handles.get(id);
        if (handle) {
          // Notify host before teardown so it can do cleanup (WS
          // unsubscribe, tab-set removal) while the handle is still live.
          if (onTileRemoved) onTileRemoved(id, handle);
          // Let carousel handle DOM teardown (wrapper removal, chrome
          // destroy, resize handles). We just need to tell it.
          carousel.removeCard(id);
          handles.delete(id);
        }
      }
    }

    // Added tiles — must activate carousel first if it's not active
    const added = [];
    for (const id of state.order) {
      if (!prevIds.has(id) && nextIds.has(id)) {
        added.push(id);
      }
    }

    if (added.length > 0 && !carousel.isActive()) {
      // First tiles ever — activate the carousel with all current tiles
      const tilesToActivate = state.order.map(id => {
        const tileDesc = state.tiles[id];
        const renderer = getRenderer(tileDesc.type);
        if (!renderer) return null;
        // Create a thin tile adapter that carousel can mount
        const adapter = _createAdapter(id, tileDesc, renderer, store.dispatch);
        return { id, tile: adapter };
      }).filter(Boolean);

      carousel.activate(tilesToActivate, state.focusedId);

      // Stash handles from the adapters that carousel just mounted
      for (const { id, tile: adapter } of tilesToActivate) {
        if (adapter._handle) handles.set(id, adapter._handle);
      }
    } else {
      // Carousel already active — add new tiles individually
      for (const id of added) {
        const tileDesc = state.tiles[id];
        const renderer = getRenderer(tileDesc.type);
        if (!renderer) continue;
        const adapter = _createAdapter(id, tileDesc, renderer, store.dispatch);
        // Insert at the correct position in the carousel
        const position = state.order.indexOf(id);
        carousel.addCard(id, adapter, position >= 0 ? position : undefined);
        if (adapter._handle) handles.set(id, adapter._handle);
      }
    }

    // ── Reorder ────────────────────────────────────────────────────
    // Only call reorder if the order actually changed and we didn't just
    // activate (activate already sets the order).
    if (added.length === 0 || carousel.isActive()) {
      const currentCards = carousel.getCards();
      if (!arraysEqual(currentCards, state.order)) {
        carousel.reorderCards(state.order);
      }
    }

    // ── Focus ──────────────────────────────────────────────────────
    if (state.focusedId && state.focusedId !== carousel.getFocusedCard()) {
      carousel.focusCard(state.focusedId);
    }

    // Notify app.js of focus change so it can do WS bookkeeping
    if (state.focusedId !== prev.focusedId && onFocusChange) {
      const tile = state.tiles[state.focusedId];
      onFocusChange(state.focusedId, tile?.type || null);
    }
  }

  /**
   * Create a tile adapter that bridges the renderer interface to the
   * carousel's TilePrototype duck-type expectations.
   *
   * The carousel calls tile.mount(el, ctx), tile.unmount(), tile.focus(),
   * etc. on TilePrototype objects. The adapter implements this interface
   * and delegates to the renderer's mount() handle internally.
   */
  function _createAdapter(id, tileDesc, renderer, dispatch) {
    let handle = null;
    const adapter = {
      type: tileDesc.type,
      // The carousel reads persistable on save — route through renderer
      get persistable() { return renderer.describe(tileDesc.props).persistable !== false; },
      get sessionName() {
        // Terminal and cluster tiles need sessionName for WS bookkeeping
        return tileDesc.props.sessionName || id;
      },
      setSessionName(newName) {
        // Carousel rename — update the underlying tile handle if it exists
        handle?.tile?.setSessionName?.(newName);
      },
      mount(el, ctx) {
        handle = renderer.mount(el, { id, props: tileDesc.props, dispatch, ctx });
        adapter._handle = handle;
      },
      unmount() {
        handle?.unmount();
        handle = null;
      },
      focus() { handle?.focus(); },
      blur() { handle?.blur(); },
      resize() { handle?.resize(); },
      getTitle() { return renderer.describe(tileDesc.props).title; },
      getIcon() { return renderer.describe(tileDesc.props).icon; },
      serialize() {
        return { type: tileDesc.type, ...tileDesc.props };
      },
      // For cluster sub-tiles
      getSubTiles() { return handle?.tile?.getSubTiles?.() || []; },
      // Stash for tile-host to grab after carousel.activate mounts it
      _handle: null,
    };
    return adapter;
  }

  function init() {
    // Leave prevState as null so the first reconcile sees an empty
    // "previous" state and treats every tile in the store as "added".
    // Without this, a pre-populated store (e.g. from loadFromStorage +
    // RESET before init) would match prev === next, nothing would mount,
    // and the carousel would stay empty after a page refresh.
    reconcile(store.getState());
    unsubscribe = store.subscribe((state) => {
      reconcile(state);
    });
  }

  function destroy() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    handles.clear();
    prevState = null;
  }

  /** Get the renderer handle for a tile (for WS bookkeeping, sub-tile access). */
  function getHandle(id) {
    return handles.get(id) || null;
  }

  return { init, destroy, getHandle };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
