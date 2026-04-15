/**
 * Pinch gesture detector — unified touch + trackpad.
 *
 * Emits a simple (scale, phase) stream so callers can drive a morph/zoom
 * without caring about the input source. Two input sources are supported
 * from day one because katulong is developed on a Mac mini (trackpad) and
 * used on iPad / phone (touch):
 *
 *   - Touch / stylus: two active PointerEvents tracked by pointerId.
 *     Scale = currentDistance / startDistance.
 *   - Trackpad: macOS/Windows expose trackpad pinch as `wheel` events with
 *     `ctrlKey` set (even when the Control key is not held — the browser
 *     synthesizes it). Scale accumulates as `exp(-deltaY * k)` so a
 *     continuous stream of small deltas produces a smooth multiplicative
 *     scale. A short idle timeout closes the gesture.
 *
 * No external library. No DOM knowledge beyond attaching listeners to the
 * target element — layout response is the caller's job.
 *
 * Phases:
 *   - "start": first frame of a new gesture; scale === 1
 *   - "move":  continuous updates; scale is current / initial
 *   - "end":   gesture released; caller should commit or snap back.
 *              The final scale value is passed so the caller can decide
 *              whether it crossed a commit threshold.
 *
 * Deliberately NOT a general multi-touch handler. We do not rotate, we do
 * not pan, we do not long-press. Step 1 only needs "is the user pinching,
 * and by how much". Future gestures (two-finger swipe between clusters,
 * three-finger, etc.) will live in their own modules so this one stays
 * small and auditable.
 */

const WHEEL_SCALE_K = 0.01;       // sensitivity for trackpad pinch
const WHEEL_IDLE_MS = 120;        // gap that ends a wheel gesture
const MIN_ACTIVATION = 0.03;      // ignore sub-pixel jitter before "start"

export function createPinchGesture({ target, onPinch }) {
  if (!target || typeof onPinch !== "function") {
    throw new Error("createPinchGesture: target and onPinch required");
  }

  // ── Touch state (two-pointer tracking) ────────────────────────────
  const pointers = new Map(); // pointerId -> {x, y}
  let touchStartDistance = 0;
  let touchActive = false;
  let touchActivated = false; // has scale crossed MIN_ACTIVATION?

  function distance() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  function onPointerDown(e) {
    // Only track primary pointers from touch or pen. Ignore mouse —
    // trackpad pinch comes through the wheel path below, not pointer
    // events, and a real mouse cannot two-finger pinch.
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && !touchActive) {
      touchActive = true;
      touchActivated = false;
      touchStartDistance = distance();
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!touchActive || touchStartDistance === 0) return;

    const d = distance();
    if (d === 0) return;
    const scale = d / touchStartDistance;

    if (!touchActivated) {
      if (Math.abs(scale - 1) < MIN_ACTIVATION) return;
      touchActivated = true;
      onPinch({ scale: 1, phase: "start" });
      // Prevent native pinch-zoom / scroll from fighting us once we
      // commit to handling the gesture. Doing this before activation
      // would eat legitimate single-finger scrolls.
      e.preventDefault();
    }
    e.preventDefault();
    onPinch({ scale, phase: "move" });
  }

  function onPointerEndLike(e) {
    if (!pointers.has(e.pointerId)) return;
    // Capture the last known scale BEFORE removing the pointer — once we
    // drop below two pointers, distance() returns 0 and the end-phase scale
    // would degenerate, which would fool the caller's commit threshold.
    const lastScale = touchActive && touchActivated && touchStartDistance > 0
      ? distance() / touchStartDistance
      : 1;
    pointers.delete(e.pointerId);
    if (touchActive && pointers.size < 2) {
      // Gesture ends the moment we drop below two fingers, even if the
      // other finger is still down.
      if (touchActivated) {
        onPinch({ scale: lastScale, phase: "end" });
      }
      touchActive = false;
      touchActivated = false;
      touchStartDistance = 0;
    }
  }

  // ── Wheel state (trackpad pinch) ──────────────────────────────────
  let wheelActive = false;
  let wheelScale = 1;
  let wheelIdleTimer = null;

  function endWheel() {
    if (!wheelActive) return;
    const finalScale = wheelScale;
    wheelActive = false;
    wheelScale = 1;
    wheelIdleTimer = null;
    onPinch({ scale: finalScale, phase: "end" });
  }

  function onWheel(e) {
    // Only trackpad pinch — ctrlKey is the cross-browser signal.
    // Real Ctrl+wheel (page zoom) is what browsers emit here too, so
    // this captures both: if the user actually Ctrl+scrolls on a mouse
    // wheel we still treat it as a pinch, which is the desired verb.
    if (!e.ctrlKey) return;
    e.preventDefault();

    if (!wheelActive) {
      wheelActive = true;
      wheelScale = 1;
      onPinch({ scale: 1, phase: "start" });
    }
    // Multiplicative accumulation: each delta scales from the current
    // value, so the gesture feels exponential (like native pinch)
    // rather than linear. Negative deltaY = pinch out = zoom in.
    wheelScale *= Math.exp(-e.deltaY * WHEEL_SCALE_K);
    // Clamp so a runaway delta can't push scale to absurd values
    // mid-gesture; the commit threshold is typically ~1.15 anyway.
    wheelScale = Math.max(0.2, Math.min(5, wheelScale));
    onPinch({ scale: wheelScale, phase: "move" });

    if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
    wheelIdleTimer = setTimeout(endWheel, WHEEL_IDLE_MS);
  }

  // ── Attach / detach ───────────────────────────────────────────────
  function attach() {
    target.addEventListener("pointerdown", onPointerDown, { passive: true });
    target.addEventListener("pointermove", onPointerMove, { passive: false });
    target.addEventListener("pointerup", onPointerEndLike, { passive: true });
    target.addEventListener("pointercancel", onPointerEndLike, { passive: true });
    target.addEventListener("pointerleave", onPointerEndLike, { passive: true });
    // wheel MUST be non-passive so preventDefault() actually stops
    // browser page-zoom during trackpad pinch.
    target.addEventListener("wheel", onWheel, { passive: false });
  }

  function detach() {
    target.removeEventListener("pointerdown", onPointerDown);
    target.removeEventListener("pointermove", onPointerMove);
    target.removeEventListener("pointerup", onPointerEndLike);
    target.removeEventListener("pointercancel", onPointerEndLike);
    target.removeEventListener("pointerleave", onPointerEndLike);
    target.removeEventListener("wheel", onWheel);
    if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
    wheelIdleTimer = null;
    pointers.clear();
    touchActive = false;
    touchActivated = false;
    touchStartDistance = 0;
    wheelActive = false;
    wheelScale = 1;
  }

  return { attach, detach };
}
