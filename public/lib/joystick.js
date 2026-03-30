/**
 * Joystick State Machine
 *
 * Handles touch gestures for terminal navigation:
 * - Hold left/right: Repeat arrow keys
 * - Flick up/down: Single arrow key
 * - Long-press center: Send Enter
 */

const ARROWS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

const JOYSTICK_CONFIG = {
  CENTER_THRESHOLD: 0.4,
  LONG_PRESS_DURATION: 600,
  RING_CIRCUMFERENCE: 2 * Math.PI * 36,
  MOVEMENT_THRESHOLD: 10,
  REPEAT_INTERVAL: 50
};

/**
 * Determine zone from touch position
 */
const getZone = (touch, rect) => {
  const x = touch.clientX - rect.left - rect.width / 2;
  const y = touch.clientY - rect.top - rect.height / 2;
  const distance = Math.sqrt(x * x + y * y);
  const radius = Math.min(rect.width, rect.height) / 2;

  if (distance < radius * JOYSTICK_CONFIG.CENTER_THRESHOLD) {
    return 'center';
  }

  return Math.abs(x) > Math.abs(y)
    ? (x > 0 ? 'right' : 'left')
    : (y > 0 ? 'down' : 'up');
};

/**
 * Joystick state reducer
 */
const joystickReducer = (state, action) => {
  switch (action.type) {
    case 'TOUCH_START':
      return {
        mode: (action.zone === 'left' || action.zone === 'right') ? 'hold'
          : 'flick-wait',
        zone: action.zone,
        startX: action.x,
        startY: action.y,
        hasMoved: false,
        enterSent: false
      };

    case 'TOUCH_MOVE':
      const moved = Math.sqrt(action.dx * action.dx + action.dy * action.dy) > JOYSTICK_CONFIG.MOVEMENT_THRESHOLD;
      return {
        ...state,
        hasMoved: state.hasMoved || moved,
        zone: action.newZone || state.zone
      };

    case 'TOUCH_END':
      return {
        mode: 'idle',
        zone: null,
        startX: 0,
        startY: 0,
        hasMoved: false,
        enterSent: false
      };

    case 'LONG_PRESS_COMPLETE':
      return { ...state, enterSent: true };

    case 'TOUCH_CANCEL':
      return {
        mode: 'idle',
        zone: null,
        startX: 0,
        startY: 0,
        hasMoved: false,
        enterSent: false
      };

    default:
      return state;
  }
};

/**
 * Create joystick manager
 */
export function createJoystickManager(options = {}) {
  const { onSend } = options;
  const joystick = document.getElementById("joystick");

  let joyState = {
    mode: 'idle',
    zone: null,
    startX: 0,
    startY: 0,
    hasMoved: false,
    enterSent: false
  };

  let repeatTimer = null;
  let longPressTimer = null;

  // Joystick effects
  const effects = {
    sendSequence: (sequence) => {
      if (onSend) onSend(sequence);
      effects.showFeedback();
    },

    showFeedback: () => {
      if (!joystick) return;
      const rect = joystick.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const el = document.createElement("div");
      el.className = "swipe-feedback";
      el.style.left = x + "px";
      el.style.top = y + "px";
      document.body.appendChild(el);
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }
  };

  const dispatch = (action) => {
    const prevState = joyState;
    joyState = joystickReducer(joyState, action);

    // Handle side effects based on state transitions
    if (prevState.mode !== joyState.mode) {
      if (joyState.mode === 'hold' && (joyState.zone === 'left' || joyState.zone === 'right')) {
        const seq = ARROWS[joyState.zone];
        effects.sendSequence(seq);
        repeatTimer = setInterval(() => {
          if (onSend) onSend(seq);
        }, JOYSTICK_CONFIG.REPEAT_INTERVAL);
      } else if (joyState.mode === 'idle' || joyState.mode === 'flick-wait') {
        if (repeatTimer) {
          clearInterval(repeatTimer);
          repeatTimer = null;
        }
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }
    }

    // Handle zone changes in hold mode
    if (joyState.mode === 'hold' && prevState.zone !== joyState.zone && (joyState.zone === 'left' || joyState.zone === 'right')) {
      if (repeatTimer) {
        clearInterval(repeatTimer);
      }
      const seq = ARROWS[joyState.zone];
      effects.sendSequence(seq);
      repeatTimer = setInterval(() => {
        if (onSend) onSend(seq);
      }, JOYSTICK_CONFIG.REPEAT_INTERVAL);
    }

  };

  // --- Expand / Collapse ---
  let expanded = false;
  let actionsEl = null;

  function expand() {
    if (expanded || !joystick) return;
    expanded = true;
    joystick.classList.add("expanded");
    // Create action buttons to the left
    actionsEl = document.createElement("div");
    actionsEl.className = "joystick-actions";

    function actionBtn(icon, label, handler) {
      const btn = document.createElement("button");
      btn.className = "joystick-action-btn";
      btn.innerHTML = `<i class="ph ph-${icon}"></i>`;
      btn.setAttribute("aria-label", label);
      // Stop propagation on BOTH touchstart and touchend so the joystick
      // gesture handler doesn't intercept taps on action buttons.
      btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
      btn.addEventListener("touchend", (e) => { e.stopPropagation(); handler(); });
      btn.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
      return btn;
    }

    const enterBtn = actionBtn("arrow-elbow-down-left", "Enter", () => {
      if (onSend) onSend("\r");
      effects.showFeedback();
    });

    actionsEl.appendChild(enterBtn);
    joystick.appendChild(actionsEl);
  }

  function collapse() {
    if (!expanded || !joystick) return;
    expanded = false;
    joystick.classList.remove("expanded");
    if (actionsEl) { actionsEl.remove(); actionsEl = null; }
  }

  // Callbacks set by the caller
  let _onTextClick = null;
  let _onAttachClick = null;

  // Collapse on any tap outside
  document.addEventListener("touchstart", (e) => {
    if (expanded && !joystick.contains(e.target)) collapse();
  }, { passive: true });

  return {
    init() {
      if (!joystick) return;

      joystick.addEventListener("touchstart", (e) => {
        e.preventDefault();
        if (!expanded) {
          // Collapsed: tap to expand
          expand();
          return;
        }
        // Expanded: joystick gestures
        const t = e.touches[0];
        const rect = joystick.getBoundingClientRect();
        const zone = getZone(t, rect);
        dispatch({ type: 'TOUCH_START', zone, x: t.clientX, y: t.clientY });
      }, { passive: false });

      joystick.addEventListener("touchmove", (e) => {
        if (!expanded) return;
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - joyState.startX;
        const dy = t.clientY - joyState.startY;
        const rect = joystick.getBoundingClientRect();
        const newZone = (joyState.mode === 'hold') ? getZone(t, rect) : null;
        dispatch({ type: 'TOUCH_MOVE', dx, dy, newZone });
      }, { passive: false });

      joystick.addEventListener("touchend", (e) => {
        if (!expanded) return;
        e.preventDefault();

        if (!joyState.enterSent && joyState.mode === 'flick-wait') {
          const t = e.changedTouches[0];
          const dx = t.clientX - joyState.startX;
          const dy = t.clientY - joyState.startY;
          const moved = Math.max(Math.abs(dx), Math.abs(dy));

          if (moved >= JOYSTICK_CONFIG.MOVEMENT_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
            const seq = dy > 0 ? ARROWS.down : ARROWS.up;
            effects.sendSequence(seq);
          }
        }

        dispatch({ type: 'TOUCH_END' });
      }, { passive: false });

      joystick.addEventListener("touchcancel", (e) => {
        if (!expanded) return;
        e.preventDefault();
        dispatch({ type: 'TOUCH_CANCEL' });
      }, { passive: false });
    },

    /** Set callbacks for action buttons */
    setActions({ onTextClick, onAttachClick }) {
      _onTextClick = onTextClick;
      _onAttachClick = onAttachClick;
    },

    collapse,
    expand,
    get isExpanded() { return expanded; },
    getState: () => joyState
  };
}
