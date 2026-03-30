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
import { createTileChrome } from "./tile-chrome.js";

const STORAGE_KEY = "katulong-carousel";

/**
 * All platforms use the card carousel layout.
 * Previously iPad-only; now the single unified UI.
 */
export function isCarouselDevice() {
  return true;
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
  const cardEls = new Map();  // tileId -> { wrapper, frontFace, backFace, tile, backTile, context, flipped }

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
      const { wrapper, inner, frontFace, backFace } = createCardWrapper(id);
      const frontChrome = createTileChrome(frontFace);
      entry.tile.mount(frontChrome.contentEl, entry.context);
      if (entry.backTile) {
        const backChrome = createTileChrome(backFace);
        entry.backTile.mount(backChrome.contentEl, entry.context);
        entry.backChrome = backChrome;
      }
      if (entry.flipped) inner.classList.add("flipped");
      entry.wrapper = wrapper;
      entry.inner = inner;
      entry.frontFace = frontFace;
      entry.backFace = backFace;
      entry.frontChrome = frontChrome;
      container.appendChild(wrapper);
    }

    positionCards(false); // instant positioning on build
    fitAll();
  }

  // ── Tile context builder ────────────────────────────────────────────

  /** Build a TileContext for a tile, including chrome and flip access. */
  function buildTileContext(tileId, tile, entry) {
    const base = createTileContext ? createTileContext(tileId, tile) : { tileId };
    // Determine which chrome this tile is mounted in
    const isFront = tile === entry.tile;
    return {
      ...base,
      flip: () => flipCard(tileId),
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

    // Store tile references and create contexts
    for (const { id, tile } of tiles) {
      const { wrapper, inner, frontFace, backFace } = createCardWrapper(id);
      const frontChrome = createTileChrome(frontFace);
      const entry = { wrapper, inner, frontFace, backFace, frontChrome, backChrome: null, tile, backTile: null, context: null, flipped: false };
      const ctx = buildTileContext(id, tile, entry);
      entry.context = ctx;
      tile.mount(frontChrome.contentEl, ctx);
      cardEls.set(id, entry);
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

    // Unmount all tiles and destroy chrome
    for (const [, entry] of cardEls) {
      entry.tile.unmount();
      if (entry.backTile) entry.backTile.unmount();
      if (entry.frontChrome) entry.frontChrome.destroy();
      if (entry.backChrome) entry.backChrome.destroy();
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
    const { wrapper, inner, frontFace, backFace } = createCardWrapper(tileId);
    const frontChrome = createTileChrome(frontFace);
    const entry = { wrapper, inner, frontFace, backFace, frontChrome, backChrome: null, tile, backTile: null, context: null, flipped: false };
    const ctx = buildTileContext(tileId, tile, entry);
    entry.context = ctx;
    tile.mount(frontChrome.contentEl, ctx);
    cardEls.set(tileId, entry);

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

      // Unmount tiles, destroy chrome, remove the wrapper
      if (entry) {
        entry.tile.unmount();
        if (entry.backTile) entry.backTile.unmount();
        if (entry.frontChrome) entry.frontChrome.destroy();
        if (entry.backChrome) entry.backChrome.destroy();
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
    resizeTimer = setTimeout(() => { resizeTimer = null; fitAll(); }, 150);
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
    buildLayout,
    setBackTile,
    flipCard,
    isFlipped,
  };
}
