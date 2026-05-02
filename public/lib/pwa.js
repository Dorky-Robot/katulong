/**
 * PWA standalone detection.
 *
 * True when the page is running as an installed PWA (Chrome/Edge "Install app",
 * Safari "Add to Home Screen", or any browser launched with display-mode:
 * standalone). False inside a regular browser tab.
 *
 * Used by keyboard wiring to swap select shortcuts onto Cmd+ in standalone mode
 * (Cmd+T, Cmd+K, Cmd+1..9, Cmd+Shift+[/]) so the app feels native — the browser
 * doesn't intercept those combos when there are no tabs to switch between.
 *
 * Cmd+W, Cmd+R, Cmd+F, and Cmd+arrow remain owned by the OS/browser even in
 * standalone, so the corresponding actions stay on Option+.
 */
export function isPwaStandalone() {
  if (typeof window === "undefined") return false;
  // matchMedia covers Chrome/Edge/Firefox installed PWAs; navigator.standalone
  // is the iOS Safari "Add to Home Screen" case.
  return Boolean(
    window.matchMedia?.("(display-mode: standalone)").matches
    || window.navigator?.standalone
  );
}
