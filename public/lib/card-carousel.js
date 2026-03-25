/**
 * Card Carousel (iPad/tablet only)
 *
 * Horizontal strip of terminal "cards". Each card is a live xterm.js terminal
 * at full available height. Single card = full width. Multiple cards share
 * width proportionally with horizontal scroll if they overflow.
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
  terminalPool,
  sendResize,
  onFocusChange,
  onCardDismissed,
  onAllCardsDismissed,
}) {
  let active = false;
  let cards = [];           // ordered session names
  let focusedSession = null;
  const cardEls = new Map(); // sessionName -> { wrapper }

  // ── Persistence ──────────────────────────────────────────────────────

  function save() {
    try {
      if (active && cards.length > 0) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          cards: [...cards],
          focused: focusedSession,
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
      if (state.cards?.length > 0) {
        return { sessions: state.cards, focused: state.focused };
      }
    } catch { /* ignore */ }
    return null;
  }

  // ── DOM helpers ──────────────────────────────────────────────────────

  function createCardWrapper(sessionName) {
    const wrapper = document.createElement("div");
    wrapper.className = "carousel-card";
    wrapper.dataset.session = sessionName;

    // Tap on a non-focused card to make it active.
    // For the focused card, let events pass through to the terminal normally.
    wrapper.addEventListener("pointerdown", (e) => {
      if (!active || focusedSession === sessionName) return;
      e.preventDefault();
      e.stopPropagation();
      focusCard(sessionName);
    });

    return { wrapper };
  }


  /**
   * Position all cards via translateX relative to the focused card.
   * Focused = translateX(0), neighbors offset by calc(100% + 16px).
   * Far cards are hidden via visibility:hidden.
   */
  function positionCards(animate = true) {
    if (!focusedSession) return;
    const focusedIdx = cards.indexOf(focusedSession);
    if (focusedIdx === -1) return;

    for (const [session, { wrapper }] of cardEls) {
      const idx = cards.indexOf(session);
      const offset = idx - focusedIdx;

      if (!animate) wrapper.style.transition = 'none';
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
    // Remove carousel elements but preserve terminal panes
    for (const el of [...container.querySelectorAll(".carousel-card")]) {
      el.remove();
    }
    // Move any terminal panes back to container root before rebuilding
    terminalPool.forEach((_name, entry) => {
      if (entry.container.parentElement && entry.container.parentElement !== container) {
        container.appendChild(entry.container);
      }
    });
    cardEls.clear();

    if (!active || cards.length === 0) return;

    container.dataset.carousel = "true";

    for (const session of cards) {
      const entry = terminalPool.getOrCreate(session);
      const { wrapper } = createCardWrapper(session);

      entry.container.style.display = "";
      wrapper.appendChild(entry.container);
      cardEls.set(session, { wrapper });
      container.appendChild(wrapper);
    }

    positionCards(false); // instant positioning on build
    fitAll();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  function activate(sessions, focused) {
    active = true;
    cards = [...sessions];
    focusedSession = focused || sessions[0] || null;

    // Ensure all terminals exist and are protected
    for (const session of cards) {
      terminalPool.getOrCreate(session);
      terminalPool.protect(session);
    }

    buildLayout();
    save();

    // Notify listener of the initial focused session so app.js
    // doesn't need to duplicate state sync after activation
    if (onFocusChange && focusedSession) onFocusChange(focusedSession);
  }

  function deactivate() {
    if (!active) return;

    // Unprotect and move terminals back to container
    for (const session of cards) {
      terminalPool.unprotect(session);
    }

    // Move all terminal panes back to container root, hidden
    terminalPool.forEach((_name, entry) => {
      if (entry.container.parentElement !== container) {
        container.appendChild(entry.container);
      }
      entry.container.classList.remove("active");
      entry.container.style.display = "none";
    });

    // Remove only carousel elements (card wrappers, handles), NOT terminal panes
    delete container.dataset.carousel;
    for (const el of [...container.querySelectorAll(".carousel-card")]) {
      el.remove();
    }
    cardEls.clear();

    active = false;
    cards = [];
    focusedSession = null;

    save();
    if (onAllCardsDismissed) onAllCardsDismissed();
  }

  // ── Card management ──────────────────────────────────────────────────

  function addCard(sessionName) {
    if (!active) return;
    if (cards.includes(sessionName)) return;

    cards.push(sessionName);
    const entry = terminalPool.getOrCreate(sessionName);
    terminalPool.protect(sessionName);

    // Surgically insert the card — no full rebuild
    const { wrapper } = createCardWrapper(sessionName);
    entry.container.style.display = "";
    wrapper.appendChild(entry.container);
    cardEls.set(sessionName, { wrapper });

    container.appendChild(wrapper);

    positionCards(false);
    fitAll();

    save();
  }

  function removeCard(sessionName) {
    if (!active) return;
    const idx = cards.indexOf(sessionName);
    if (idx === -1) return;

    const el = cardEls.get(sessionName);

    const doRemove = () => {
      // Re-lookup index at removal time — the array may have changed
      // during the animation delay (e.g. another card removed/reordered).
      const currentIdx = cards.indexOf(sessionName);
      if (currentIdx === -1) return;

      // Remove the card wrapper (edge handles are children, removed with it)
      if (el?.wrapper?.parentElement) {
        el.wrapper.remove();
      }
      cardEls.delete(sessionName);
      cards.splice(currentIdx, 1);
      terminalPool.unprotect(sessionName);

      // Move terminal pane back to container root (hidden by default CSS)
      const entry = terminalPool.get(sessionName);
      if (entry) {
        entry.container.style.display = "none";
        container.appendChild(entry.container);
      }

      if (onCardDismissed) onCardDismissed(sessionName);

      // Shift focus
      if (focusedSession === sessionName) {
        if (cards.length > 0) {
          focusedSession = cards[Math.min(currentIdx, cards.length - 1)];
          if (onFocusChange) onFocusChange(focusedSession);
          positionCards(true);
        } else {
          focusedSession = null;
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

  function focusCard(sessionName) {
    if (!active) return;
    if (!cards.includes(sessionName)) return;
    if (focusedSession === sessionName) return;

    focusedSession = sessionName;

    // Slide cards to new positions (animated)
    positionCards(true);

    // Focus the terminal, rescale it, and move controls into this card
    const entry = terminalPool.get(sessionName);
    if (entry?.term?.focus) entry.term.focus();
    terminalPool.attachControls(sessionName);
    fitAll();

    if (onFocusChange) onFocusChange(sessionName);
    save();
  }

  function renameCard(oldName, newName) {
    const idx = cards.indexOf(oldName);
    if (idx === -1) return;

    cards[idx] = newName;
    if (focusedSession === oldName) focusedSession = newName;

    // Update card wrapper
    const el = cardEls.get(oldName);
    if (el) {
      el.wrapper.dataset.session = newName;
      cardEls.delete(oldName);
      cardEls.set(newName, el);
    }

    save();
  }

  /** Reorder cards to match the given order (called when tabs are reordered) */
  function reorderCards(orderedNames) {
    // Filter to only names that are actually in the carousel
    const newOrder = orderedNames.filter(n => cards.includes(n));
    // Add any cards not in the ordered list (shouldn't happen, but be safe)
    for (const n of cards) {
      if (!newOrder.includes(n)) newOrder.push(n);
    }
    if (newOrder.join(",") === cards.join(",")) return; // no change

    cards = newOrder;

    positionCards(true);
    fitAll();

    save();
  }

  // ── Fit ──────────────────────────────────────────────────────────────

  function fitAll() {
    if (!active) return;
    requestAnimationFrame(() => {
      if (!active) return;
      terminalPool.scaleAll();
      for (const session of cards) {
        const entry = terminalPool.get(session);
        if (entry && sendResize) sendResize(session, entry.term.cols, entry.term.rows);
      }
    });
  }

  // Rescale terminals on orientation change / window resize.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!active) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; fitAll(); }, 150);
  });



  return {
    isActive: () => active,
    getCards: () => [...cards],
    getFocusedCard: () => focusedSession,
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
