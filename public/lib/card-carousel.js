/**
 * Card Carousel (iPad/tablet only)
 *
 * Horizontal strip of terminal "cards". Each card is a live xterm.js terminal
 * at full available height. Single card = full width. Multiple cards share
 * width proportionally with horizontal scroll if they overflow.
 *
 * A shared header bar above the cards shows session names as tabs.
 * Cards can be resized by dragging edges and dismissed (detaches tmux
 * session, doesn't kill it).
 */

const STORAGE_KEY = "katulong-carousel";

/**
 * Detect iPad / tablet devices that should use the card carousel.
 * Works for real iPads and "Desktop-mode" iPads that report as Macintosh.
 */
export function isCarouselDevice() {
  return navigator.maxTouchPoints > 0 &&
    (/iPad/.test(navigator.userAgent) ||
     (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
}

export function createCardCarousel({
  container,
  terminalPool,
  sendResize,
  onFocusChange,
  onCardDismissed,
  onAddClick,
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
        const newWidth = Math.max(200, startWidth + delta);
        wrapper.style.flex = `0 0 ${newWidth}px`;
      }

      function onEnd() {
        wrapper.classList.remove("resizing");
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

  let addBtn = null;

  function ensureAddButton() {
    if (addBtn) return;
    addBtn = document.createElement("button");
    addBtn.className = "carousel-add";
    addBtn.setAttribute("aria-label", "Add session");
    addBtn.innerHTML = '<i class="ph ph-plus-circle"></i>';
    addBtn.addEventListener("click", () => { if (onAddClick) onAddClick(addBtn); });
  }

  function showAddButton() {
    ensureAddButton();
    if (!addBtn.parentElement) {
      // Place it outside the scrollable carousel (fixed position via CSS)
      const target = document.getElementById("main-stage") || container.parentElement || document.body;
      if (target) target.appendChild(addBtn);
    }
  }

  function hideAddButton() {
    if (addBtn?.parentElement) addBtn.remove();
  }

  // ── Header ──────────────────────────────────────────────────────────

  let headerEl = null;

  /** Full rebuild of the header — used only by buildLayout/activate */
  function buildHeader() {
    // Remove old header
    if (headerEl) headerEl.remove();
    headerEl = document.createElement("div");
    headerEl.className = "carousel-header";

    for (const session of cards) {
      const tab = _createHeaderTab(session);
      headerEl.appendChild(tab);
    }

    // Insert header before the carousel container
    container.parentElement?.insertBefore(headerEl, container);
  }

  /** Create a single header tab element */
  function _createHeaderTab(session) {
    const tab = document.createElement("button");
    tab.className = "carousel-header-tab" + (session === focusedSession ? " active" : "");
    tab.dataset.session = session;

    const name = document.createElement("span");
    name.className = "header-tab-name";
    name.textContent = session;
    tab.appendChild(name);

    const dismiss = document.createElement("button");
    dismiss.className = "header-tab-dismiss";
    dismiss.innerHTML = '<i class="ph ph-x"></i>';
    dismiss.addEventListener("click", (e) => { e.stopPropagation(); removeCard(session); });
    tab.appendChild(dismiss);

    tab.addEventListener("click", () => focusCard(session));
    return tab;
  }

  /** Add a single tab to the header incrementally */
  function addHeaderTab(sessionName) {
    if (!headerEl) return;
    const tab = _createHeaderTab(sessionName);
    headerEl.appendChild(tab);
  }

  /** Remove a single tab from the header incrementally */
  function removeHeaderTab(sessionName) {
    if (!headerEl) return;
    const tab = headerEl.querySelector(`.carousel-header-tab[data-session="${sessionName}"]`);
    if (tab) tab.remove();
  }

  /** Rename a tab in the header incrementally */
  function renameHeaderTab(oldName, newName) {
    if (!headerEl) return;
    const tab = headerEl.querySelector(`.carousel-header-tab[data-session="${oldName}"]`);
    if (tab) {
      tab.dataset.session = newName;
      const nameEl = tab.querySelector(".header-tab-name");
      if (nameEl) nameEl.textContent = newName;
    }
  }

  /** Update which header tab has the active class */
  function updateHeaderFocus(sessionName) {
    if (!headerEl) return;
    for (const tab of headerEl.querySelectorAll(".carousel-header-tab")) {
      tab.classList.toggle("active", tab.dataset.session === sessionName);
    }
  }

  function removeHeader() {
    if (headerEl) { headerEl.remove(); headerEl = null; }
  }

  /** Scroll the focused card fully into view after layout settles */
  function scrollToFocused() {
    if (!focusedSession) return;
    const el = cardEls.get(focusedSession);
    if (el?.wrapper?.scrollIntoView) {
      requestAnimationFrame(() => {
        el.wrapper.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      });
    }
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

    for (let i = 0; i < cards.length; i++) {
      const session = cards[i];
      const entry = terminalPool.getOrCreate(session);
      const { wrapper } = createCardWrapper(session);

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

      cardEls.set(session, { wrapper });
      container.appendChild(wrapper);
    }

    // Build the shared header bar above the cards
    buildHeader();
    // Show the floating + button
    showAddButton();

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
    removeHeader();
    // Keep the + button visible so the user can create new sessions
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
    addHeaderTab(sessionName);

    // Animate: start collapsed, then grow to natural size
    wrapper.style.flex = "0 0 0px";
    wrapper.style.opacity = "0";
    wrapper.style.transform = "scale(0.95)";
    wrapper.offsetHeight; // force reflow
    requestAnimationFrame(() => {
      wrapper.style.flex = "";
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
      // Remove the card wrapper (edge handles are children, removed with it)
      if (el?.wrapper?.parentElement) {
        el.wrapper.remove();
      }
      cardEls.delete(sessionName);
      cards.splice(idx, 1);
      terminalPool.unprotect(sessionName);

      // Move terminal pane back to container root (hidden by default CSS)
      const entry = terminalPool.get(sessionName);
      if (entry) {
        entry.container.style.display = "none";
        container.appendChild(entry.container);
      }

      if (onCardDismissed) onCardDismissed(sessionName);

      // Remove header tab incrementally
      removeHeaderTab(sessionName);

      // Shift focus
      if (focusedSession === sessionName) {
        if (cards.length > 0) {
          focusedSession = cards[Math.min(idx, cards.length - 1)];
          if (onFocusChange) onFocusChange(focusedSession);
          // Update focused class
          for (const [name, { wrapper }] of cardEls) {
            wrapper.classList.toggle("focused", name === focusedSession);
          }
          updateHeaderFocus(focusedSession);
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

    // Update focused class on cards and header tabs
    for (const [name, { wrapper }] of cardEls) {
      wrapper.classList.toggle("focused", name === sessionName);
    }
    updateHeaderFocus(sessionName);

    // Focus the terminal and scroll into view
    const entry = terminalPool.get(sessionName);
    if (entry?.term?.focus) entry.term.focus();
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

    // Update header tab incrementally
    renameHeaderTab(oldName, newName);
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

  window.addEventListener("resize", () => {
    if (active) fitAll();
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
    fitAll,
    save,
    restore,
    buildLayout,
  };
}
