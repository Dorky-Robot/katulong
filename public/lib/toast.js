/**
 * Toast Notification
 *
 * Extracted from image-upload.js for reuse across the app.
 */

export function showToast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = `toast ${isError ? "toast-error" : ""}`;
  el.textContent = msg;
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add("visible");
  });

  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
