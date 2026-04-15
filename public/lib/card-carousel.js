/**
 * Card Carousel — the single unified tile layout for all platforms.
 *
 * Horizontal strip of tile "cards". Each card is a generic container that
 * holds a TilePrototype instance (terminal, dashboard, web preview, etc.).
 * Single card = full width. Multiple cards share width proportionally with
 * horizontal scroll if they overflow.
 *
 * Tab management (rendering, drag-reorder, rename, + button) is handled by
 * the shortcut bar — the carousel only manages the card tile layout.
 */

import { createTileChrome } from "./tile-chrome.js";
import { createResizeHandles } from "./tile-resize.js";

const STORAGE_KEY = "katulong-carousel";

// Hard cap on persisted cards. Defensive backstop against unbounded
// localStorage growth. In normal use a user keeps a handful of tabs open;
// but bugs, multi-device drift, or races can leak phantom tile entries into
// storage. Once the list crosses this size every subsequent boot has to pay
// the cost of re-subscribing, polling status, and reconciling dozens of
// dead sessions — the observed failure mode was 90+ phantoms producing a
// subscribe/status retry storm and an unresponsive UI. Cap is generous
// enough to never hit in legitimate use; entries beyond the cap are dropped
// oldest-first on save, keeping the most recently focused cards.
const MAX_PERSISTED_CARDS = 50;

/**
 * Is the given tile instance persistable across page reloads?
 *
 * Tile persistence is a *capability*, not a default. A tile opts out of
 * persistence by setting `persistable: false` on its prototype. Today
 * the file-browser tile is the only opt-out — it has no tmux-backed
 * state, so "remember across reload" would just resurrect an empty
 * pane for no reason. Terminal and cluster tiles omit the flag and
 * default to persistable, preserving prior behavior.
 *
 * Tier 2 will generalize this to a richer capability snapshot emitted
 * by the tile prototype; until then, a single boolean at the save /
 * restore seam keeps the opt-out one-line per tile kind.
 */
function isTilePersistable(tile) {
  return tile?.persistable !== false;
}

/**
 * Pure parser for the legacy `katulong-carousel` localStorage blob.
 * Returns `{ tiles, focused }` or null when storage is missing / malformed.
 *
 * Used by app.js boot to migrate pre-ui-store persistence without reaching
 * into a carousel instance — the MC1d "no state reads" contract. The
 * instance's `restore()` delegates to this so both paths share one
 * format-migration implementation.
 *
 * @param {object} [opts]
 * @param {(type: string) => boolean} [opts.isTypePersistable] — drop tiles whose type returns false.
 * @param {object} [opts.snapshot] — pre-parsed state (from parseStoredState)
 *   to use in place of reading live localStorage. Preserves the "snapshot at
 *   carousel-construction" protection for in-instance callers.
 */
export function parseLegacyCarouselStorage({ isTypePersistable = () => true, snapshot = null } = {}) {
  const state = snapshot || parseStoredState();
  if (!state) return null;

  let rawCards = state.cards;
  if (rawCards.length > MAX_PERSISTED_CARDS) {
    const overflow = rawCards.length - MAX_PERSISTED_CARDS;
    console.warn(
      `[carousel] restored ${rawCards.length} cards exceeds cap ` +
      `${MAX_PERSISTED_CARDS}; dropping ${overflow} oldest on load`
    );
    const tail = rawCards.slice(-MAX_PERSISTED_CARDS);
    const focusedEntry = state.focused
      ? rawCards.find(c => (typeof c === "string" ? c : c?.id) === state.focused)
      : null;
    const focusedInTail = focusedEntry
      ? tail.some(c => (typeof c === "string" ? c : c?.id) === state.focused)
      : true;
    rawCards = focusedInTail || !focusedEntry
      ? tail
      : [focusedEntry, ...tail.slice(0, -1)];
  }

  if (typeof rawCards[0] === "string") {
    return {
      tiles: rawCards.map(name => ({
        id: name,
        type: "terminal",
        sessionName: name,
      })),
      focused: state.focused,
    };
  }

  const tiles = rawCards.filter(c => isTypePersistable(c?.type));
  const focused = tiles.some(c => (typeof c === "string" ? c : c?.id) === state.focused)
    ? state.focused
    : null;
  return { tiles, focused };
}

function parseStoredState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || !Array.isArray(state.cards) || state.cards.length === 0) return null;
    return state;
  } catch { /* localStorage unavailable or malformed JSON — treat as absent */ }
  return null;
}

export function createCardCarousel({
  container,
  onFocusChange,
  onCardDismissed,
  onAllCardsDismissed,
  createTileContext,
  /**
   * Optional predicate for the *restore* path: given a tile type string
   * from persisted JSON, should we rebuild it? Save() already filters
   * non-persistable tiles from being written, but users upgrading from
   * a buggy build may have stale entries in their localStorage. This
   * hook lets the host (app.js) drop them on read so nobody has to
   * manually clear their storage. Defaults to "yes, restore everything".
   */
  isTypePersistable = () => true,
}) {
  let active = false;
  let cards = [];             // ordered tile IDs
  let focusedId = null;
  const cardEls = new Map();  // tileId -> { wrapper, frontFace, backFace, tile, backTile, context, flipped, resizeHandles }

  // Snapshot localStorage at construction, BEFORE anything can call save().
  // The boot sequence in app.js activates a terminal tile from the ?s= URL
  // param and only calls restore() later inside a setTimeout. That initial
  // activate() fires save() with only the terminal, overwriting any
  // previously persisted non-terminal tiles (e.g. file browsers). Capturing
  // the raw state here preserves the pre-boot snapshot for restore().
  let initialStoredState = null;

  // ── Persistence ──────────────────────────────────────────────────────

  function save() {
    try {
      // Filter out non-persistable tiles (e.g. file-browser). Persistence
      // is a capability the tile opts into by omitting `persistable:
      // false`. Doing the filter at the top of save() — not inside the
      // map — means the MAX_PERSISTED_CARDS cap below is computed over
      // *persistable* cards, so a window full of ephemeral file-browser
      // tiles can't push real terminal tabs out of the cap.
      const persistableCards = cards.filter(id => {
        const entry = cardEls.get(id);
        return entry && isTilePersistable(entry.tile);
      });
      if (active && persistableCards.length > 0) {
        // Cap: if we're somehow above MAX_PERSISTED_CARDS, drop the oldest
        // entries (beginning of the array) and keep the most recent. The
        // focused card is promoted to the kept tail so user focus is never
        // the one thrown away. This is defensive — the UI shouldn't
        // normally mount this many cards, but phantom-leak bugs can push
        // past it, and the cap keeps one bad boot from cascading forever.
        let toPersist = persistableCards;
        if (toPersist.length > MAX_PERSISTED_CARDS) {
          const overflow = toPersist.length - MAX_PERSISTED_CARDS;
          console.warn(
            `[carousel] ${toPersist.length} cards exceeds persist cap ` +
            `${MAX_PERSISTED_CARDS}; dropping ${overflow} oldest entries from storage`
          );
          toPersist = toPersist.slice(-MAX_PERSISTED_CARDS);
          // Promote focused card to the kept tail only if it's itself
          // persistable — otherwise we'd be writing a non-persistable id.
          if (focusedId && !toPersist.includes(focusedId) && persistableCards.includes(focusedId)) {
            toPersist = [focusedId, ...toPersist.slice(0, -1)];
          }
        }
        const serialized = toPersist.map(id => {
          const entry = cardEls.get(id);
          if (!entry) return null;
          const base = { id, type: entry.tile.type };
          if (typeof entry.tile.serialize === "function") {
            Object.assign(base, entry.tile.serialize());
          }
          // Persist custom card width if set
          if (entry.resizeHandles) {
            const w = entry.resizeHandles.serialize();
            if (w !== null) base.cardWidth = w;
          }
          return base;
        }).filter(Boolean);
        // Only persist `focused` if it's actually in the serialized set.
        // Focusing a non-persistable tile (e.g. a file browser) should
        // not leave a dangling focused id pointing at nothing after
        // reload — restore() would try to focus a tile it didn't
        // rebuild and fall back to the first tile silently, which
        // works but looks like a bug.
        const persistedIds = new Set(serialized.map(s => s.id));
        const persistedFocus = persistedIds.has(focusedId) ? focusedId : null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          cards: serialized,
          focused: persistedFocus,
        }));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch { /* localStorage unavailable */ }
  }

  // Capture the pre-boot snapshot immediately at construction, before any
  // activate()/addCard() call can fire save() and clobber it.
  initialStoredState = parseStoredState();

  function restore() {
    return parseLegacyCarouselStorage({
      isTypePersistable,
      snapshot: initialStoredState,
    });
  }

  /**
   * Read the persisted per-card widths from localStorage, keyed by tile id.
   *
   * Callers of activate() typically don't know or care about cardWidth —
   * the carousel owns that persistence. By reading it here we make refresh
   * restoration transparent to every call site (explicit ?s= boot,
   * resolved-session boot, routeToSession), which previously constructed
   * tiles with no cardWidth and silently discarded the saved dimensions.
   *
   * The filter requires `cardWidth` to be a finite positive number so
   * a tampered or corrupted entry (NaN, "foo", {}, -1) cannot reach
   * tile-resize and corrupt the layout with `--w: NaNpx`.
   */
  function readSavedCardWidths() {
    const widths = new Map();
    const state = parseStoredState();
    if (!state) return widths;
    for (const c of state.cards) {
      if (c && typeof c === "object" && c.id
          && typeof c.cardWidth === "number" && Number.isFinite(c.cardWidth) && c.cardWidth > 0) {
        widths.set(c.id, c.cardWidth);
      }
    }
    return widths;
  }

  // ── Resize handles ──────────────────────────────────────────────────

  /** Attach resize handles to a card entry. */
  function attachResizeHandles(tileId, entry) {
    const handles = createResizeHandles({
      card: entry.wrapper,
      onResize: (width) => {
        // Don't refit terminal during drag — causes garble from rapid
        // SIGWINCH during TUI render. Just reposition cards visually.
        // Terminal refit happens in onResizeEnd.
        if (tileId === focusedId) {
          positionCards(false, width);
        }
      },
      onResizeEnd: (width) => {
        // Refit terminal once at final width — single SIGWINCH
        requestAnimationFrame(() => {
          entry.tile.resize();
          if (entry.backTile) entry.backTile.resize();
        });
        save();
      },
      minWidth: 280,
    });
    handles.attach();
    entry.resizeHandles = handles;
    return handles;
  }

  // ── DOM helpers ──────────────────────────────────────────────────────

  function createCardWrapper(tileId) {
    const wrapper = document.createElement("div");
    wrapper.className = "carousel-card";
    wrapper.dataset.tileId = tileId;

    // ── Flip structure ───────────────────────────────────────────────
    // wrapper (.carousel-card)          — perspective container
    //   └─ inner (.card-inner)          — rotates on flip
    //       ├─ frontFace (.card-face.card-front) — primary tile
    //       └─ backFace (.card-face.card-back)   — secondary tile (lazy)
    const inner = document.createElement("div");
    inner.className = "card-inner";

    const frontFace = document.createElement("div");
    frontFace.className = "card-face card-front";
    inner.appendChild(frontFace);

    const backFace = document.createElement("div");
    backFace.className = "card-face card-back";
    inner.appendChild(backFace);

    wrapper.appendChild(inner);

    // ── Tap handling ─────────────────────────────────────────────────
    // Tap on a non-focused card to make it active.
    // For the focused card, let events pass through normally.
    //
    // We listen on BOTH pointerdown and click because on iPad, the focused
    // card's scroll handler calls setPointerCapture() on pointerdown,
    // which can steal subsequent pointer events. A tap on a non-focused card
    // that overlaps with pointer capture may never fire pointerdown on the
    // wrapper. The click event always fires after pointerup regardless of
    // capture, so it serves as a reliable fallback.
    let handledByPointerdown = false;

    wrapper.addEventListener("pointerdown", (e) => {
      if (!active) return;
      if (focusedId === tileId) {
        const entry = cardEls.get(tileId);
        if (entry) {
          const visibleTile = entry.flipped ? entry.backTile : entry.tile;
          if (visibleTile) visibleTile.focus();
        }
        return;
      }
      handledByPointerdown = true;
      e.preventDefault();
      e.stopPropagation();
      focusCard(tileId);
    });

    wrapper.addEventListener("click", (e) => {
      if (!active) return;
      if (focusedId === tileId) {
        const entry = cardEls.get(tileId);
        if (entry) {
          const visibleTile = entry.flipped ? entry.backTile : entry.tile;
          if (visibleTile) visibleTile.focus();
        }
        return;
      }
      if (handledByPointerdown) { handledByPointerdown = false; return; }
      e.preventDefault();
      e.stopPropagation();
      focusCard(tileId);
    });

    return { wrapper, inner, frontFace, backFace };
  }

  /**
   * Position all cards via translateX relative to the focused card.
   * Focused = translateX(0), neighbors spaced outward with a consistent
   * gap between each pair of adjacent cards.
   * Far cards are hidden via visibility:hidden.
   */
  // Cache card width to avoid reading offsetWidth mid-transition (which
  // returns the animated intermediate value and causes position jumps).
  let cachedCardW = 0;
  let defaultCardGap = 16;

  // Default card width mirrors the CSS clamp on .carousel-card:
  //   clamp(--card-min-width, 100% - 2 * --card-peek, --card-max-width)
  //
  // Previously this clamp was encoded in four hardcoded copies — CSS
  // `width`, CSS `margin-left`, a phone media query duplicate, and this
  // JS function — which drifted and caused v0.46.6/7/8 visual bugs
  // (diwa: ca1aed5, 918cc5b, cb4c3a1). Today CSS owns one formula via
  // `--card-peek`/`--card-min-width`/`--card-max-width` on
  // `#terminal-container[data-carousel]`; both `.carousel-card { width }`
  // and `.carousel-card { margin-left }` derive from the same `--w`
  // intra-rule variable. This function reads those same CSS vars via
  // `getComputedStyle`, so it stays in sync automatically — do NOT
  // reintroduce a hardcoded fallback like `cw - 160`.
  //
  // `readCssVar` is hoisted out of this function so the same resolution
  // pattern (same guard, same fallback check) can also populate
  // `defaultCardGap` from the same cached style snapshot.
  function readCssVar(cs, name, fallback) {
    if (!cs) return fallback;
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  let defaultCardW = 0;
  function computeDefaultCardWidth() {
    const cw = container.offsetWidth || 800;
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(container) : null;
    const peek = readCssVar(cs, "--card-peek", 80);
    const minW = readCssVar(cs, "--card-min-width", 280);
    const maxW = readCssVar(cs, "--card-max-width", 720);
    defaultCardW = Math.max(minW, Math.min(cw - 2 * peek, maxW));
    // Keep --card-gap resolution in the same cached style snapshot
    // instead of re-running getComputedStyle from positionCards().
    defaultCardGap = readCssVar(cs, "--card-gap", 16);
  }

  /** Get the effective width of a card (custom resize or CSS default). */
  function cardWidthOf(id) {
    const entry = cardEls.get(id);
    if (entry?.resizeHandles) {
      const cw = entry.resizeHandles.getWidth();
      if (cw) return cw;
    }
    return defaultCardW;
  }

  function positionCards(animate = true, focusedWidth) {
    if (!focusedId) return;
    const focusedIdx = cards.indexOf(focusedId);
    if (focusedIdx === -1) return;

    if (!defaultCardW) computeDefaultCardWidth();
    // --card-gap is resolved inside computeDefaultCardWidth() using
    // the same cached style snapshot, so we don't force a second
    // forced-style-recalc here. Phone vs desktop cascade already
    // decided the correct value.
    const gap = defaultCardGap;

    // Cache focused card's actual width for swipe threshold calculations.
    // During resize drag, the caller passes the exact width so we don't
    // need to read the DOM (which may not have reflowed yet).
    if (focusedWidth > 0) {
      cachedCardW = focusedWidth;
    } else {
      const focusedEntry = cardEls.get(focusedId);
      if (focusedEntry) {
        const w = focusedEntry.wrapper.offsetWidth || focusedEntry.wrapper.getBoundingClientRect().width;
        if (w > 0) cachedCardW = w;
      }
    }

    const focusedW = cachedCardW || defaultCardW;

    // Compute per-card translateX by walking outward from the focused card.
    // Each card is centered via left:50% + marginLeft:-width/2, so we
    // accumulate: half of prev card + gap + half of next card per step.
    const positions = new Map();
    positions.set(focusedId, 0);

    // Cards to the right of focus
    let reach = focusedW / 2;
    for (let i = focusedIdx + 1; i < cards.length; i++) {
      const w = cardWidthOf(cards[i]);
      positions.set(cards[i], reach + gap + w / 2);
      reach += gap + w;
    }

    // Cards to the left of focus
    reach = focusedW / 2;
    for (let i = focusedIdx - 1; i >= 0; i--) {
      const w = cardWidthOf(cards[i]);
      positions.set(cards[i], -(reach + gap + w / 2));
      reach += gap + w;
    }

    for (const [id, { wrapper }] of cardEls) {
      const cardX = positions.get(id);
      if (cardX === undefined) continue;
      const dist = Math.abs(cards.indexOf(id) - focusedIdx);

      if (!animate) wrapper.style.transition = "none";
      wrapper.style.transform = `translateX(${cardX}px)`;
      wrapper.classList.toggle("focused", id === focusedId);
      wrapper.classList.toggle("carousel-hidden", dist > 2);

      if (!animate) {
        wrapper.offsetHeight; // force reflow
        requestAnimationFrame(() => { wrapper.style.transition = ""; });
      }
    }
  }

  // ── Tile context builder ────────────────────────────────────────────

  /** Build a TileContext for a tile, including chrome and faceStack access.
   *
   * `ctx.faceStack` is the tile-facing abstraction that replaced the
   * previous `deps.carousel.{setBackTile,flipCard,isFlipped}` reach-around
   * (see Tier 1 T1a, docs/tile-clusters-design.md). It exposes a minimal
   * "this tile may have a secondary face" affordance:
   *
   *   setSecondary(tile)     — attach/replace the back-face tile
   *   showSecondary(bool)    — flip to the secondary face (true) or primary (false)
   *   isShowingSecondary()   — is the back face currently visible?
   *
   * Shaped deliberately to be additive for T2c (face-stack-of-N). Today
   * there are only two faces (primary + secondary), so the API stays
   * boolean; when N>2 lands, `setSecondary` will gain index-aware siblings
   * without breaking existing callers. The terminal tile uses this to
   * drive its auto-flip-on-idle behavior without ever touching
   * deps.carousel — which kills the circular wiring that app.js used to
   * plumb via a lazy getter.
   */
  function buildTileContext(tileId, tile, entry) {
    const base = createTileContext ? createTileContext(tileId, tile) : { tileId };
    // Determine which chrome this tile is mounted in
    const isFront = tile === entry.tile;
    return {
      ...base,
      flip: () => flipCard(tileId),
      // Tile-initiated close. A tile calls this when it wants to be
      // removed from its container (e.g. file-browser's own X button).
      // Routes through removeCard so onCardDismissed fires and the
      // windowTabSet / subscriptions stay consistent. Deferred via
      // queueMicrotask so callers can finish their click handler
      // before the DOM is torn out from under them.
      requestClose: () => { queueMicrotask(() => removeCard(tileId)); },
      faceStack: {
        setSecondary: (secondary) => setBackTile(tileId, secondary),
        showSecondary: (show) => flipCard(tileId, show),
        isShowingSecondary: () => isFlipped(tileId),
      },
      get chrome() {
        // Return the chrome for whichever face this tile is on
        return isFront ? entry.frontChrome?.chrome : entry.backChrome?.chrome;
      },
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Activate the carousel with the given tiles.
   * @param {Array<{id: string, tile: TilePrototype}>} tiles
   * @param {string} focused — tile ID to focus initially
   */
  function activate(tiles, focused) {
    active = true;
    cards = tiles.map(t => t.id);
    focusedId = focused || cards[0] || null;

    // Look up persisted widths so refresh boots (which construct tiles
    // without cardWidth) still get their dimensions back. An explicit
    // cardWidth on the incoming tile wins over the saved value.
    const savedWidths = readSavedCardWidths();

    // Store tile references and create contexts
    for (const { id, tile, cardWidth, defaultWidth } of tiles) {
      const { wrapper, inner, frontFace, backFace } = createCardWrapper(id);
      const frontChrome = createTileChrome(frontFace);
      const entry = { wrapper, inner, frontFace, backFace, frontChrome, backChrome: null, tile, backTile: null, context: null, flipped: false, resizeHandles: null };
      const ctx = buildTileContext(id, tile, entry);
      entry.context = ctx;
      tile.mount(frontChrome.contentEl, ctx);
      cardEls.set(id, entry);
      container.appendChild(wrapper);
      // Attach resize handles
      const handles = attachResizeHandles(id, entry);
      // Restore persisted width: explicit cardWidth (from the saved
      // tiles restore path) wins, else fall back to the per-id width
      // we just read from localStorage, else the tile-type default.
      const effectiveWidth = cardWidth ?? savedWidths.get(id) ?? defaultWidth;
      if (effectiveWidth) handles.restore(effectiveWidth);
    }

    container.dataset.carousel = "true";
    positionCards(false);
    save();

    // Focus the initial tile
    if (focusedId) {
      const entry = cardEls.get(focusedId);
      if (entry) entry.tile.focus();
    }

    // Notify listener of the initial focused tile so app.js
    // doesn't need to duplicate state sync after activation
    if (onFocusChange && focusedId) onFocusChange(focusedId);

    fitAll();
  }

  function deactivate(opts = {}) {
    if (!active) return;
    const silent = opts.silent === true;

    // Unmount all tiles, destroy chrome, detach resize handles
    for (const [, entry] of cardEls) {
      entry.tile.unmount();
      if (entry.backTile) entry.backTile.unmount();
      if (entry.frontChrome) entry.frontChrome.destroy();
      if (entry.backChrome) entry.backChrome.destroy();
      if (entry.resizeHandles) entry.resizeHandles.detach();
    }

    // Remove card wrappers
    delete container.dataset.carousel;
    for (const el of [...container.querySelectorAll(".carousel-card")]) {
      el.remove();
    }
    cardEls.clear();

    active = false;
    cards = [];
    focusedId = null;

    save();
    if (!silent && onAllCardsDismissed) onAllCardsDismissed();
  }

  // ── Card management ────────────────────────────────────────────────

  /**
   * Add a tile to the carousel.
   * @param {string} tileId
   * @param {TilePrototype} tile
   * @param {number} [position] — insertion index; appends to end when omitted.
   *   Used by "new tab right of active" (Chrome-style) behavior. Positioning
   *   is driven by the `cards` array order because positionCards() walks that
   *   array to compute translateX — the DOM child order does not matter.
   */
  function addCard(tileId, tile, position, defaultWidth) {
    if (!active) return;
    if (cards.includes(tileId)) return;

    if (typeof position === "number" && position >= 0 && position <= cards.length) {
      cards.splice(position, 0, tileId);
    } else {
      cards.push(tileId);
    }
    const { wrapper, inner, frontFace, backFace } = createCardWrapper(tileId);
    const frontChrome = createTileChrome(frontFace);
    const entry = { wrapper, inner, frontFace, backFace, frontChrome, backChrome: null, tile, backTile: null, context: null, flipped: false, resizeHandles: null };
    const ctx = buildTileContext(tileId, tile, entry);
    entry.context = ctx;
    tile.mount(frontChrome.contentEl, ctx);
    cardEls.set(tileId, entry);

    container.appendChild(wrapper);
    const handles = attachResizeHandles(tileId, entry);
    // Fall back to the tile-type default if no saved width exists for
    // this id. A user-dragged width will already be in localStorage
    // from a prior session; the default only applies on first open.
    const savedWidth = readSavedCardWidths().get(tileId);
    const effectiveWidth = savedWidth ?? defaultWidth;
    if (effectiveWidth) handles.restore(effectiveWidth);

    positionCards(false);
    fitAll();
    save();
  }

  /**
   * Remove a card from the carousel.
   *
   * @param {string} tileId
   * @param {object} [opts]
   * @param {boolean} [opts.silent] When true, suppress onCardDismissed and
   *   onAllCardsDismissed callbacks. Used by tile-host when a tile leaves
   *   the visible cluster but still exists in store (cluster switch). The
   *   default false matches the user-initiated dismiss path: callbacks
   *   fire so the host can dispatch removeTile / reset.
   */
  function removeCard(tileId, opts = {}) {
    if (!active) return;
    const idx = cards.indexOf(tileId);
    if (idx === -1) return;

    const silent = opts.silent === true;
    const entry = cardEls.get(tileId);

    const doRemove = () => {
      const currentIdx = cards.indexOf(tileId);
      if (currentIdx === -1) return;

      // Unmount tiles, destroy chrome, detach resize handles, remove the wrapper
      if (entry) {
        entry.tile.unmount();
        if (entry.backTile) entry.backTile.unmount();
        if (entry.frontChrome) entry.frontChrome.destroy();
        if (entry.backChrome) entry.backChrome.destroy();
        if (entry.resizeHandles) entry.resizeHandles.detach();
        if (entry.wrapper?.parentElement) {
          entry.wrapper.remove();
        }
      }
      cardEls.delete(tileId);
      cards.splice(currentIdx, 1);

      if (!silent && onCardDismissed) onCardDismissed(tileId);

      // Shift focus
      if (focusedId === tileId) {
        if (cards.length > 0) {
          focusedId = cards[Math.min(currentIdx, cards.length - 1)];
          const newEntry = cardEls.get(focusedId);
          if (newEntry) newEntry.tile.focus();
          if (onFocusChange) onFocusChange(focusedId);
          positionCards(true);
        } else {
          focusedId = null;
          deactivate({ silent });
          return;
        }
      } else {
        positionCards(true);
      }

      fitAll();
      save();
    };

    doRemove();
  }

  function focusCard(tileId) {
    if (!active) return;
    if (!cards.includes(tileId)) return;
    if (focusedId === tileId) return;

    // Blur the previously focused tile (whichever face is visible)
    const prevEntry = cardEls.get(focusedId);
    if (prevEntry) {
      const prevTile = prevEntry.flipped ? prevEntry.backTile : prevEntry.tile;
      if (prevTile) prevTile.blur();
    }

    focusedId = tileId;

    // Slide cards to new positions (animated)
    positionCards(true);

    // Focus the new tile (whichever face is visible)
    const entry = cardEls.get(tileId);
    if (entry) {
      const visibleTile = entry.flipped ? entry.backTile : entry.tile;
      if (visibleTile) visibleTile.focus();
    }

    fitAll();
    if (onFocusChange) onFocusChange(tileId);
    save();
  }

  function renameCard(oldId, newId) {
    const idx = cards.indexOf(oldId);
    if (idx === -1) return;

    cards[idx] = newId;
    if (focusedId === oldId) focusedId = newId;

    const entry = cardEls.get(oldId);
    if (entry) {
      entry.wrapper.dataset.tileId = newId;
      cardEls.delete(oldId);
      cardEls.set(newId, entry);
      // Push the new name into the tile so its internal sessionName,
      // serialize(), and pool lookups stay aligned with the carousel
      // key. Without this, findCard(t => t.sessionName === newId) and
      // serialize() return the stale pre-rename name — which leaves
      // orphan tiles when the renamed session is later removed.
      if (typeof entry.tile.setSessionName === "function") {
        entry.tile.setSessionName(newId);
      }
      if (entry.backTile && typeof entry.backTile.setSessionName === "function") {
        entry.backTile.setSessionName(newId);
      }
    }

    save();
  }

  /** Reorder cards to match the given order (called when tabs are reordered) */
  function reorderCards(orderedIds) {
    const newOrder = orderedIds.filter(id => cards.includes(id));
    for (const id of cards) {
      if (!newOrder.includes(id)) newOrder.push(id);
    }
    if (newOrder.join(",") === cards.join(",")) return;

    cards = newOrder;

    positionCards(true);
    fitAll();
    save();
  }

  // ── Fit ────────────────────────────────────────────────────────────

  function fitAll() {
    if (!active) return;
    requestAnimationFrame(() => {
      if (!active) return;
      for (const [, entry] of cardEls) {
        entry.tile.resize();
        if (entry.backTile) entry.backTile.resize();
      }
    });
  }

  // Rescale tiles on orientation change / window resize.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!active) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      cachedCardW = 0; // invalidate — card width changes on resize
      computeDefaultCardWidth(); // recompute stride basis for new viewport
      positionCards(false);
      fitAll();
    }, 150);
  });

  // ── Tile access ────────────────────────────────────────────────────

  /** Get the tile instance for a given ID (front face). */
  function getTile(tileId) {
    return cardEls.get(tileId)?.tile || null;
  }

  /** Find the tile ID for a tile matching a predicate. */
  function findCard(predicate) {
    for (const [id, { tile }] of cardEls) {
      if (predicate(tile, id)) return id;
    }
    return null;
  }

  // ── Flip ──────────────────────────────────────────────────────────

  /**
   * Assign a back-face tile to a card. The back tile is mounted lazily
   * and revealed with flipCard().
   */
  function setBackTile(tileId, backTile) {
    const entry = cardEls.get(tileId);
    if (!entry) return;

    // Unmount previous back tile and chrome if any
    if (entry.backTile) entry.backTile.unmount();
    if (entry.backChrome) entry.backChrome.destroy();

    // Create chrome for the back face
    const backChrome = createTileChrome(entry.backFace);
    entry.backChrome = backChrome;
    entry.backTile = backTile;

    const ctx = buildTileContext(tileId, backTile, entry);
    backTile.mount(backChrome.contentEl, ctx);
    backTile.resize();
  }

  /**
   * Flip a card to show its other face. If no back tile is set, this is a no-op.
   * @param {string} tileId
   * @param {boolean} [toBack] — force direction. Omit to toggle.
   */
  function flipCard(tileId, toBack) {
    const entry = cardEls.get(tileId);
    if (!entry || !entry.backTile) return;

    const shouldFlip = toBack !== undefined ? toBack : !entry.flipped;
    if (shouldFlip === entry.flipped) return;

    entry.flipped = shouldFlip;
    entry.inner.classList.toggle("flipped", shouldFlip);

    // Focus the now-visible face
    const visibleTile = shouldFlip ? entry.backTile : entry.tile;
    const hiddenTile = shouldFlip ? entry.tile : entry.backTile;
    if (hiddenTile) hiddenTile.blur();
    if (visibleTile) {
      visibleTile.resize();
      visibleTile.focus();
    }
  }

  /** Check if a card is currently showing its back face. */
  function isFlipped(tileId) {
    return cardEls.get(tileId)?.flipped || false;
  }

  return {
    isActive: () => active,
    getCards: () => [...cards],
    getFocusedCard: () => focusedId,
    getTile,
    findCard,
    activate,
    deactivate,
    addCard,
    removeCard,
    focusCard,
    renameCard,
    reorderCards,
    fitAll,
    save,
    restore,
  };
}
