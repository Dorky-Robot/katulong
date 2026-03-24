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
  const cardEls = new Map(); // sessionName -> { wrapper, intendedWidth }

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

    // Focus on tap
    wrapper.addEventListener("pointerdown", () => {
      if (active && focusedSession !== sessionName) {
        focusCard(sessionName);
      }
    });

    return { wrapper };
  }

  /** Create left/right edge resize handles inside a card wrapper */
  function attachEdgeHandles(wrapper, sessionName) {
    for (const side of ["left", "right"]) {
      const handle = document.createElement("div");
      handle.className = `carousel-handle carousel-handle-${side}`;

      let startX = 0;
      let startWidth = 0;

      function onStart(cx) {
        startX = cx;
        startWidth = wrapper.getBoundingClientRect().width;
        wrapper.classList.add("resizing");
        return true;
      }

      function onMove(cx) {
        const dx = cx - startX;
        const delta = side === "right" ? dx : -dx;
        const maxWidth = container.clientWidth - 12;
        const newWidth = Math.max(200, Math.min(startWidth + delta, maxWidth));
        wrapper.style.flex = `0 0 ${newWidth}px`;
      }

      function onEnd() {
        wrapper.classList.remove("resizing");
        // Store the intended width so it survives browser resizes
        const el = cardEls.get(sessionName);
        const w = wrapper.getBoundingClientRect().width;
        if (el && w > 0) el.intendedWidth = w;
        fitAll();
        save();
      }

      handle.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        onStart(e.touches[0].clientX);
        const move = (te) => { te.preventDefault(); onMove(te.touches[0].clientX); };
        const end = () => { document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); onEnd(); };
        document.addEventListener("touchmove", move, { passive: false });
        document.addEventListener("touchend", end);
      }, { passive: false });

      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onStart(e.clientX);
        const move = (me) => { me.preventDefault(); onMove(me.clientX); };
        const end = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", end); onEnd(); };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", end);
      });

      wrapper.appendChild(handle);
    }
  }

  /** Scroll the focused card fully into view after layout settles */
  function scrollToFocused(smooth) {
    if (!focusedSession) return;
    const el = cardEls.get(focusedSession);
    if (!el?.wrapper) return;
    const behavior = smooth === false ? "instant" : "smooth";
    // Wait for layout to settle (fitAll uses setTimeout 50ms, so 80ms
    // ensures flex widths have been applied before we measure scroll).
    setTimeout(() => {
      if (!active) return;
      el.wrapper.scrollIntoView({ behavior, inline: "center", block: "nearest" });
    }, 80);
  }

  // ── Layout ───────────────────────────────────────────────────────────

  function buildLayout() {
    // Remove carousel elements but preserve terminal panes
    for (const el of [...container.querySelectorAll(".carousel-card, .carousel-handle")]) {
      el.remove();
    }
    // Move any terminal panes back to container root before rebuilding
    // (safely handles terminals already in wrappers)
    terminalPool.forEach((_name, entry) => {
      if (entry.container.parentElement && entry.container.parentElement !== container) {
        container.appendChild(entry.container);
      }
    });
    cardEls.clear();

    if (!active || cards.length === 0) return;

    container.dataset.carousel = "true";

    // Determine initial card widths:
    //   1 card  → 100% of container
    //   2 cards → 50% each if container is wide enough (~70% of max iPad width),
    //             otherwise 100% each (scroll horizontally)
    //   3+ cards → 100% each (scroll horizontally)
    const containerWidth = container.clientWidth - 12; // account for padding
    const WIDE_THRESHOLD = 750; // ~70% of 1024px (iPad landscape)

    for (let i = 0; i < cards.length; i++) {
      const session = cards[i];
      const entry = terminalPool.getOrCreate(session);
      const { wrapper } = createCardWrapper(session);

      // Set explicit pixel width — no CSS-driven reflow
      let cardWidth;
      if (cards.length === 1) {
        cardWidth = containerWidth;
      } else if (cards.length === 2 && containerWidth >= WIDE_THRESHOLD) {
        cardWidth = Math.floor((containerWidth - 10) / 2); // split minus gap
      } else {
        cardWidth = containerWidth; // full-width, scroll horizontally
      }
      wrapper.style.flex = `0 0 ${cardWidth}px`;

      // Move the terminal pane into the card wrapper and ensure it's visible
      // (deactivate sets display:none which overrides CSS)
      entry.container.style.display = "";
      wrapper.appendChild(entry.container);

      // Mark focused
      if (session === focusedSession) {
        wrapper.classList.add("focused");
      }

      // Attach left/right edge resize handles
      attachEdgeHandles(wrapper, session);

      cardEls.set(session, { wrapper, intendedWidth: cardWidth });
      container.appendChild(wrapper);
    }

    // Fit terminals after layout, then scroll focused card into view
    fitAll();
    scrollToFocused();
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
    for (const el of [...container.querySelectorAll(".carousel-card, .carousel-handle")]) {
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
    attachEdgeHandles(wrapper, sessionName);
    cardEls.set(sessionName, { wrapper });

    container.appendChild(wrapper);

    // New cards get full container width (scroll horizontally to reach them)
    const cardWidth = container.clientWidth - 12;
    const el = cardEls.get(sessionName);
    if (el) el.intendedWidth = cardWidth;

    // Animate: start collapsed, then grow to intended size
    wrapper.style.flex = "0 0 0px";
    wrapper.style.opacity = "0";
    wrapper.style.transform = "scale(0.95)";
    wrapper.offsetHeight; // force reflow
    requestAnimationFrame(() => {
      wrapper.style.flex = `0 0 ${cardWidth}px`;
      wrapper.style.opacity = "";
      wrapper.style.transform = "";
    });

    // Scroll into view AFTER the grow animation finishes (300ms CSS transition)
    setTimeout(() => {
      wrapper.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      fitAll();
    }, 350);

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
          // Update focused class
          for (const [name, { wrapper }] of cardEls) {
            wrapper.classList.toggle("focused", name === focusedSession);
          }
          scrollToFocused();
        } else {
          focusedSession = null;
          deactivate();
          return;
        }
      }

      fitAll();
      save();
    };

    // Animate out: shrink + fade, then remove
    if (el?.wrapper?.style) {
      let done = false;
      const finish = () => { if (!done) { done = true; doRemove(); } };
      el.wrapper.style.transition = "flex 0.3s ease, opacity 0.2s ease, transform 0.3s ease, min-width 0.3s ease";
      el.wrapper.style.flex = "0 0 0px";
      el.wrapper.style.minWidth = "0";
      el.wrapper.style.opacity = "0";
      el.wrapper.style.transform = "scale(0.92)";
      el.wrapper.style.overflow = "hidden";
      el.wrapper.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 350);
    } else {
      doRemove();
    }
  }

  function focusCard(sessionName) {
    if (!active) return;
    if (!cards.includes(sessionName)) return;
    if (focusedSession === sessionName) return;

    focusedSession = sessionName;

    // Update focused class on cards
    for (const [name, { wrapper }] of cardEls) {
      wrapper.classList.toggle("focused", name === sessionName);
    }

    // Focus the terminal, move controls into this card, and scroll into view
    const entry = terminalPool.get(sessionName);
    if (entry?.term?.focus) entry.term.focus();
    terminalPool.attachControls(sessionName);
    scrollToFocused();

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

    // FLIP animation: capture old positions, reorder DOM, animate
    const positions = new Map();
    for (const [session, { wrapper }] of cardEls) {
      positions.set(session, wrapper.getBoundingClientRect());
    }

    // Reorder DOM to match cards array
    for (const session of cards) {
      const el = cardEls.get(session);
      if (el) container.appendChild(el.wrapper);
    }

    // Animate from old position to new
    for (const [session, { wrapper }] of cardEls) {
      const oldRect = positions.get(session);
      const newRect = wrapper.getBoundingClientRect();
      if (!oldRect) continue;
      const dx = oldRect.left - newRect.left;
      if (Math.abs(dx) < 1) continue;
      wrapper.style.transition = "none";
      wrapper.style.transform = `translateX(${dx}px)`;
      wrapper.offsetHeight; // force reflow
      wrapper.style.transition = "transform 0.3s ease";
      wrapper.style.transform = "";
    }

    // Clean up transitions after animation
    setTimeout(() => {
      for (const [, { wrapper }] of cardEls) {
        wrapper.style.transition = "";
      }
      fitAll();
    }, 350);

    save();
  }

  // ── Fit ──────────────────────────────────────────────────────────────

  function fitAll() {
    if (!active) return;
    // Use setTimeout instead of rAF — the flex layout needs a
    // full layout pass to settle before xterm can measure its container.
    // rAF fires before layout on iPad Safari in some cases.
    setTimeout(() => {
      if (!active) return;
      for (const session of cards) {
        const entry = terminalPool.get(session);
        if (!entry) continue;
        entry.fit.fit();
        if (entry.term.refresh) entry.term.refresh(0, entry.term.rows - 1);
        if (sendResize) sendResize(session, entry.term.cols, entry.term.rows);
      }
    }, 50);
  }

  // ── Resize listener ──────────────────────────────────────────────────

  // On window resize: refit terminals inside their cards but don't change
  // card widths — the user controls widths via drag handles.
  window.addEventListener("resize", () => {
    if (!active) return;
    fitAll();
    scrollToFocused(false);
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
