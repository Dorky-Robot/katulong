/**
 * Notification dispatcher — decides HOW to show a native notification
 * based on browser capabilities (ServiceWorker vs Notification constructor).
 *
 * Android Chrome does NOT support `new Notification()` — it throws TypeError.
 * The only way to show a notification on Android is via
 * `ServiceWorkerRegistration.showNotification()`.
 *
 * The previous code gated on `navigator.serviceWorker.controller` being set,
 * but `.controller` is null until `clients.claim()` propagates — which may
 * not have happened on the first page load after SW registration. Using
 * `navigator.serviceWorker.ready` instead resolves once the SW is active,
 * regardless of claim state.
 */

/**
 * @param {string} title
 * @param {string} message
 * @param {object} [env] - injectable browser globals for testing
 * @returns {"sw"|"constructor"|"unavailable"} which branch was taken
 */
export function dispatchNotification(title, message, env = {}) {
  const win = env.window ?? globalThis.window;
  const nav = env.navigator ?? globalThis.navigator;

  const canNotify = "Notification" in win && win.Notification.permission === "granted";

  if (canNotify && "serviceWorker" in nav) {
    nav.serviceWorker.ready.then(reg => {
      reg.showNotification(title, { body: message, icon: "/icon-192.png" });
    }).catch(() => {});
    return "sw";
  }

  if (canNotify) {
    try { new win.Notification(title, { body: message, icon: "/icon-192.png" }); } catch { /* */ }
    return "constructor";
  }

  return "unavailable";
}
