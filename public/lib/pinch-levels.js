/**
 * Pinch-level reducer — pure state machine for the zoom verb.
 *
 * FP4 in the multi-cluster FP pre-req chain. Today the pinch gesture
 * flips a binary `carousel.setMode("carousel"|"expose")`. The multi-
 * cluster design extends this into a two-axis state:
 *
 *   { level: 1 | 2, mode: "carousel" | "expose" }
 *
 *   Level 1 = focused cluster. mode chooses carousel vs expose.
 *   Level 2 = cluster overview (vertical stack of strips). mode is the
 *             uniform sub-mode that every strip renders in — inherited
 *             from whichever Level-1 mode the user pinched out from.
 *
 * The transitions below model the full state machine. Today MC3 (Level
 * 2 UI) doesn't exist, so app.js clamps transitions to level 1 before
 * applying side effects; the reducer still exposes the full contract so
 * MC3 is a renderer addition, not a state-machine rewrite.
 *
 * Pinch thresholds are constants here — any caller that wants to tune
 * them (tests, Level 3 someday) injects them explicitly.
 */

export const PINCH_OUT_THRESHOLD = 1.15;
export const PINCH_IN_THRESHOLD = 0.87;

export const INITIAL_PINCH_STATE = { level: 1, mode: "carousel" };

/**
 * Pure reducer. Given current pinch state and the final scale of a
 * gesture, return the next pinch state.
 *
 * @param {{level:1|2, mode:"carousel"|"expose"}} state
 * @param {{scale:number, out?:number, in?:number}} action
 * @returns {{level:1|2, mode:"carousel"|"expose"}}
 */
export function reducePinch(
  state,
  { scale, out = PINCH_OUT_THRESHOLD, in: inThreshold = PINCH_IN_THRESHOLD } = {},
) {
  const pinchingOut = scale >= out;
  const pinchingIn = scale <= inThreshold;
  if (!pinchingOut && !pinchingIn) return state;

  const { level, mode } = state;

  if (pinchingOut) {
    // Level 1 carousel → Level 1 expose (within-level mode change)
    if (level === 1 && mode === "carousel") return { level: 1, mode: "expose" };
    // Level 1 expose → Level 2 (overview, uniform mode inherited)
    if (level === 1 && mode === "expose")   return { level: 2, mode: "expose" };
    // Level 2 is the ceiling today (Level 3 parked in design doc)
    return state;
  }

  // pinching in
  // Level 2 → Level 1, keep uniform mode so the strip you land on is
  // the one you were visually looking at.
  if (level === 2) return { level: 1, mode };
  // Level 1 expose → Level 1 carousel
  if (level === 1 && mode === "expose") return { level: 1, mode: "carousel" };
  // Level 1 carousel is the floor
  return state;
}

/**
 * Derive the minimal diff between two pinch states so the caller can
 * apply exactly the side effects that changed (avoid redundant DOM
 * writes). Returns null if states are equal.
 *
 * @returns {null | { levelChanged: boolean, modeChanged: boolean }}
 */
export function diffPinchState(prev, next) {
  const levelChanged = prev.level !== next.level;
  const modeChanged = prev.mode !== next.mode;
  if (!levelChanged && !modeChanged) return null;
  return { levelChanged, modeChanged };
}
