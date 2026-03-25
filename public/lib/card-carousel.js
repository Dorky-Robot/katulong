/**
 * Card Carousel (iPad/tablet only)
 *
 * Horizontal strip of tile "cards". Each card is a generic container that
 * holds a TilePrototype instance (terminal, dashboard, web preview, etc.).
 * Single card = full width. Multiple cards share width proportionally with
 * horizontal scroll if they overflow.
 *
 * Tab management (rendering, drag-reorder, rename, + button) is handled by
 * the shortcut bar — the carousel only manages the card tile layout.
 */

import { isIPad } from "./platform.js";

const STORAGE_KEY = "katulong-carousel";

/**
 * Detect iPad / tablet devices that should use the card carousel.
 */
export function isCarouselDevice() {
  return isIPad();
}

export function createCardCarousel({
  container,
  onFocusChange,
  onCardDismissed,
  onAllCardsDismissed,
  createTileContext,
}) {
  let active = false;
  let cards = [];             // ordered tile IDs
  let focusedId = null;
  const cardEls = new Map();  // tileId -> { wrapper, tile, context }

  // ── Persistence ──────────────────────────────────────────────────────

  function save() {
    try {
      if (active && cards.length > 0) {
        const serialized = cards.map(id => {
          const entry = cardEls.get(id);
          if (!entry) return null;
          const base = { id, type: entry.tile.type };
          if (typeof entry.tile.serialize === "function") {
            Object.assign(base, entry.tile.serialize());
          }
          return base;
        }).filter(Boolean);
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          cards: serialized,
          focused: focusedId,
        }));
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch { /* sessionStorage unavailable */ }
  }

  function restore() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state.cards?.length) return null;

      // Detect legacy format (array of session name strings)
      if (typeof state.cards[0] === "string") {
        return {
          tiles: state.cards.map(name => ({
            id: name,
            type: "terminal",
            sessionName: name,
          })),
          focused: state.focused,
        };
      }

      return { tiles: state.cards, focused: state.focused };
    } catch { /* ignore */ }
    return null;
  }

  // ── DOM helpers ──────────────────────────────────────────────────────

  function createCardWrapper(tileId) {
    const wrapper = document.createElement("div");
    wrapper.className = "carousel-card";
    wrapper.dataset.tileId = tileId;

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
        // Focused card: call tile.focus() in user gesture context.
        // Safari/iPad silently ignores programmatic focus() calls outside
        // user gesture handlers, so this ensures the tile can grab focus.
        const entry = cardEls.get(tileId);
        if (entry) entry.tile.focus();
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
        // Focused card click: ensure tile focus (user gesture context)
        const entry = cardEls.get(tileId);
        if (entry) entry.tile.focus();
        return;
      }
      // Skip if pointerdown already handled this interaction
      if (handledByPointerdown) { handledByPointerdown = false; return; }
      e.preventDefault();
      e.stopPropagation();
      focusCard(tileId);
    });

    return wrapper;
  }

  /**
   * Position all cards via translateX relative to the focused card.
   * Focused = translateX(0), neighbors offset by calc(100% + 16px).
   * Far cards are hidden via visibility:hidden.
   */
  function positionCards(animate = true) {
    if (!focusedId) return;
    const focusedIdx = cards.indexOf(focusedId);
    if (focusedIdx === -1) return;

    for (const [id, { wrapper }] of cardEls) {
      const idx = cards.indexOf(id);
      const offset = idx - focusedIdx;

      if (!animate) wrapper.style.transition = "none";
      // Use the card's actual width + gap for offset so neighbors peek on wide screens
      const cardW = wrapper.offsetWidth || wrapper.getBoundingClientRect().width;
      const gap = 16;
      wrapper.style.transform = `translateX(${offset * (cardW + gap)}px)`;
      wrapper.classList.toggle("focused", offset === 0);
      // Show neighbors within 2 positions (visible on wide screens)
      wrapper.classList.toggle("carousel-hidden", Math.abs(offset) > 2);

      if (!animate) {
        wrapper.offsetHeight; // force reflow
        requestAnimationFrame(() => { wrapper.style.transition = ""; });
      }
    }
  }

  // ── Layout ───────────────────────────────────────────────────────────

  function buildLayout() {
    // Remove carousel wrapper elements
    for (const el of [...container.querySelectorAll(".carousel-card")]) {
      el.remove();
    }
    cardEls.clear();

    if (!active || cards.length === 0) return;

    container.dataset.carousel = "true";

    // Re-mount tiles into fresh wrappers.
    // We iterate a snapshot of `cards` because tiles are already tracked
    // in the tiles map passed to activate().
    for (const id of cards) {
      const entry = cardEls.get(id);
      if (!entry) continue;
      const wrapper = createCardWrapper(id);
      entry.tile.mount(wrapper, entry.context);
      entry.wrapper = wrapper;
      container.appendChild(wrapper);
    }

    positionCards(false); // instant positioning on build
    fitAll();
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

    // Store tile references and create contexts
    for (const { id, tile } of tiles) {
      const ctx = createTileContext ? createTileContext(id, tile) : { tileId: id };
      const wrapper = createCardWrapper(id);
      tile.mount(wrapper, ctx);
      cardEls.set(id, { wrapper, tile, context: ctx });
      container.appendChild(wrapper);
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

  function deactivate() {
    if (!active) return;

    // Unmount all tiles
    for (const [, entry] of cardEls) {
      entry.tile.unmount();
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
    if (onAllCardsDismissed) onAllCardsDismissed();
  }

  // ── Card management ────────────────────────────────────────────────

  /**
   * Add a tile to the carousel.
   * @param {string} tileId
   * @param {TilePrototype} tile
   */
  function addCard(tileId, tile) {
    if (!active) return;
    if (cards.includes(tileId)) return;

    cards.push(tileId);
    const ctx = createTileContext ? createTileContext(tileId, tile) : { tileId };
    const wrapper = createCardWrapper(tileId);
    tile.mount(wrapper, ctx);
    cardEls.set(tileId, { wrapper, tile, context: ctx });

    container.appendChild(wrapper);

    positionCards(false);
    fitAll();
    save();
  }

  function removeCard(tileId) {
    if (!active) return;
    const idx = cards.indexOf(tileId);
    if (idx === -1) return;

    const entry = cardEls.get(tileId);

    const doRemove = () => {
      const currentIdx = cards.indexOf(tileId);
      if (currentIdx === -1) return;

      // Unmount the tile and remove the wrapper
      if (entry) {
        entry.tile.unmount();
        if (entry.wrapper?.parentElement) {
          entry.wrapper.remove();
        }
      }
      cardEls.delete(tileId);
      cards.splice(currentIdx, 1);

      if (onCardDismissed) onCardDismissed(tileId);

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
          deactivate();
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

    // Blur the previously focused tile
    const prevEntry = cardEls.get(focusedId);
    if (prevEntry) prevEntry.tile.blur();

    focusedId = tileId;

    // Slide cards to new positions (animated)
    positionCards(true);

    // Focus the new tile
    const entry = cardEls.get(tileId);
    if (entry) entry.tile.focus();

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
      }
    });
  }

  // Rescale tiles on orientation change / window resize.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!active) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; fitAll(); }, 150);
  });

  // ── Tile access ────────────────────────────────────────────────────

  /** Get the tile instance for a given ID. */
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
    buildLayout,
  };
}
