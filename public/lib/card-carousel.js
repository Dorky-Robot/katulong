/**
 * Card Carousel (iPad/tablet only)
 *
 * Horizontal strip of terminal "cards". Each card is a live xterm.js terminal
 * at full available height. Single card = full width. Multiple cards share
 * width proportionally with horizontal scroll if they overflow.
 *
 * Each card has a subtle editable title (session name) centered at the top.
 * Cards can be reordered by dragging, resized by dragging edges, and
 * dismissed (detaches tmux session, doesn't kill it).
 */

const STORAGE_KEY = "katulong-carousel";

export function createCardCarousel({
  container,
  terminalPool,
  sendResize,
  onFocusChange,
  onCardDismissed,
  onAddClick,
}) {
  let active = false;
  let cards = [];           // ordered session names
  let focusedSession = null;
  const cardEls = new Map(); // sessionName -> { wrapper, titleInput }

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

    // Title bar
    const titleBar = document.createElement("div");
    titleBar.className = "card-title";

    const titleInput = document.createElement("input");
    titleInput.className = "card-title-input";
    titleInput.value = sessionName;
    titleInput.setAttribute("autocorrect", "off");
    titleInput.setAttribute("autocapitalize", "off");
    titleInput.setAttribute("spellcheck", "false");
    titleInput.readOnly = true;

    // Tap to edit
    titleInput.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      titleInput.readOnly = false;
      titleInput.select();
    });
    titleInput.addEventListener("blur", () => { titleInput.readOnly = true; });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      if (e.key === "Escape") { titleInput.value = sessionName; titleInput.blur(); }
      e.stopPropagation();
    });

    titleBar.appendChild(titleInput);

    // Dismiss button
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "card-dismiss";
    dismissBtn.setAttribute("aria-label", `Close ${sessionName}`);
    dismissBtn.innerHTML = '<i class="ph ph-x"></i>';
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeCard(sessionName);
    });
    titleBar.appendChild(dismissBtn);

    wrapper.appendChild(titleBar);

    // Focus on tap
    wrapper.addEventListener("pointerdown", () => {
      if (active && focusedSession !== sessionName) {
        focusCard(sessionName);
      }
    });

    return { wrapper, titleInput };
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

  function createAddButton() {
    const btn = document.createElement("button");
    btn.className = "carousel-add";
    btn.setAttribute("aria-label", "Add session");
    btn.innerHTML = '<i class="ph ph-plus-circle"></i>';
    btn.addEventListener("click", () => { if (onAddClick) onAddClick(btn); });
    return btn;
  }

  // ── Layout ───────────────────────────────────────────────────────────

  function buildLayout() {
    // Clear container
    container.innerHTML = "";
    cardEls.clear();

    if (!active || cards.length === 0) return;

    container.dataset.carousel = "true";

    for (let i = 0; i < cards.length; i++) {
      const session = cards[i];
      const entry = terminalPool.getOrCreate(session);
      const { wrapper, titleInput } = createCardWrapper(session);

      // Move the terminal pane into the card wrapper
      wrapper.appendChild(entry.container);

      // Mark focused
      if (session === focusedSession) {
        wrapper.classList.add("focused");
      }

      // Attach left/right edge resize handles
      attachEdgeHandles(wrapper, session);

      cardEls.set(session, { wrapper, titleInput });
      container.appendChild(wrapper);
    }

    // Add button at the end
    container.appendChild(createAddButton());

    // Fit terminals after layout
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
  }

  function deactivate() {
    if (!active) return;

    // Unprotect and move terminals back to container
    for (const session of cards) {
      terminalPool.unprotect(session);
    }

    // Move all terminal panes back to container root
    terminalPool.forEach((_name, entry) => {
      if (entry.container.parentElement !== container) {
        container.appendChild(entry.container);
      }
    });

    // Clean up carousel DOM
    delete container.dataset.carousel;
    container.innerHTML = "";
    cardEls.clear();

    active = false;
    cards = [];
    focusedSession = null;

    save();
  }

  // ── Card management ──────────────────────────────────────────────────

  function addCard(sessionName) {
    if (!active) return;
    if (cards.includes(sessionName)) return;

    cards.push(sessionName);
    const entry = terminalPool.getOrCreate(sessionName);
    terminalPool.protect(sessionName);

    // Create the card wrapper and insert it before the + button
    const { wrapper, titleInput } = createCardWrapper(sessionName);
    wrapper.appendChild(entry.container);
    attachEdgeHandles(wrapper, sessionName);
    cardEls.set(sessionName, { wrapper, titleInput });

    const addBtn = container.querySelector(".carousel-add");
    container.insertBefore(wrapper, addBtn);

    // Animate: start collapsed, then grow to natural size
    wrapper.style.flex = "0 0 0px";
    wrapper.style.opacity = "0";
    wrapper.style.transform = "scale(0.95)";
    wrapper.offsetHeight; // force reflow
    requestAnimationFrame(() => {
      wrapper.style.flex = "";
      wrapper.style.opacity = "";
      wrapper.style.transform = "";
      wrapper.scrollIntoView({ behavior: "smooth", inline: "center" });
    });

    fitAll();
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
      cards.splice(cards.indexOf(sessionName), 1);
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
          focusedSession = cards[Math.min(idx, cards.length - 1)];
          if (onFocusChange) onFocusChange(focusedSession);
          // Update focused class
          for (const [name, { wrapper }] of cardEls) {
            wrapper.classList.toggle("focused", name === focusedSession);
          }
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
      setTimeout(finish, 400);
    } else {
      doRemove();
    }
  }

  function focusCard(sessionName) {
    if (!active) return;
    if (!cards.includes(sessionName)) return;
    if (focusedSession === sessionName) return;

    focusedSession = sessionName;

    // Update focused class
    for (const [name, { wrapper }] of cardEls) {
      wrapper.classList.toggle("focused", name === sessionName);
    }

    // Focus the terminal
    const entry = terminalPool.get(sessionName);
    if (entry?.term?.focus) entry.term.focus();

    // Scroll focused card to center
    const el = cardEls.get(sessionName);
    if (el?.wrapper?.scrollIntoView) {
      el.wrapper.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }

    if (onFocusChange) onFocusChange(sessionName);
    save();
  }

  function renameCard(oldName, newName) {
    const idx = cards.indexOf(oldName);
    if (idx === -1) return;

    cards[idx] = newName;
    if (focusedSession === oldName) focusedSession = newName;

    // Update the title input
    const el = cardEls.get(oldName);
    if (el) {
      el.titleInput.value = newName;
      el.wrapper.dataset.session = newName;
      cardEls.delete(oldName);
      cardEls.set(newName, el);
    }

    save();
  }

  // ── Fit ──────────────────────────────────────────────────────────────

  function fitAll() {
    if (!active) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const session of cards) {
          const entry = terminalPool.get(session);
          if (!entry) continue;
          entry.fit.fit();
          if (entry.term.refresh) entry.term.refresh(0, entry.term.rows - 1);
          if (sendResize) sendResize(session, entry.term.cols, entry.term.rows);
        }
      });
    });
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
