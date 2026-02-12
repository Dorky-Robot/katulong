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
        mode: action.zone === 'center' ? 'long-press'
          : (action.zone === 'left' || action.zone === 'right') ? 'hold'
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
  const enterRing = document.getElementById("enter-progress-ring");
  const enterCircle = enterRing?.querySelector("circle");

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
    showRing: () => {
      if (!enterRing || !enterCircle) return;
      enterRing.classList.add("active");
      enterCircle.style.strokeDasharray = JOYSTICK_CONFIG.RING_CIRCUMFERENCE;
      enterCircle.style.strokeDashoffset = JOYSTICK_CONFIG.RING_CIRCUMFERENCE;
      enterCircle.style.transition = `stroke-dashoffset ${JOYSTICK_CONFIG.LONG_PRESS_DURATION}ms linear`;
      requestAnimationFrame(() => {
        enterCircle.style.strokeDashoffset = 0;
      });
    },

    hideRing: () => {
      if (!enterRing || !enterCircle) return;
      enterRing.classList.remove("active");
      enterCircle.style.transition = "none";
      enterCircle.style.strokeDashoffset = JOYSTICK_CONFIG.RING_CIRCUMFERENCE;
    },

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
      if (joyState.mode === 'long-press') {
        effects.showRing();
        longPressTimer = setTimeout(() => {
          if (!joyState.hasMoved) {
            effects.sendSequence("\r");
            dispatch({ type: 'LONG_PRESS_COMPLETE' });
            effects.hideRing();
          }
        }, JOYSTICK_CONFIG.LONG_PRESS_DURATION);
      } else if (joyState.mode === 'hold' && (joyState.zone === 'left' || joyState.zone === 'right')) {
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
        effects.hideRing();
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

    // Handle movement canceling long-press
    if (joyState.mode === 'long-press' && joyState.hasMoved && !prevState.hasMoved) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      effects.hideRing();
    }
  };

  return {
    init() {
      if (!joystick) return;

      joystick.addEventListener("touchstart", (e) => {
        e.preventDefault();
        const t = e.touches[0];
        const rect = joystick.getBoundingClientRect();
        const zone = getZone(t, rect);
        dispatch({ type: 'TOUCH_START', zone, x: t.clientX, y: t.clientY });
      });

      joystick.addEventListener("touchmove", (e) => {
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - joyState.startX;
        const dy = t.clientY - joyState.startY;
        const rect = joystick.getBoundingClientRect();
        const newZone = (joyState.mode === 'hold') ? getZone(t, rect) : null;
        dispatch({ type: 'TOUCH_MOVE', dx, dy, newZone });
      });

      joystick.addEventListener("touchend", (e) => {
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
      });

      joystick.addEventListener("touchcancel", (e) => {
        e.preventDefault();
        dispatch({ type: 'TOUCH_CANCEL' });
      });
    },

    getState: () => joyState
  };
}
