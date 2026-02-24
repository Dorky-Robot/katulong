/**
 * Image Upload Helpers
 *
 * Handles image file uploads and toast notifications.
 */

/**
 * Show toast notification
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

/**
 * Check if file is an image
 */
export function isImageFile(file) {
  return file.type.startsWith("image/");
}

/**
 * Upload image to terminal (sends path to terminal after upload)
 */
export async function uploadImageToTerminal(file, options = {}) {
  const { onSend, toast = showToast } = options;

  try {
    const headers = {
      "Content-Type": "application/octet-stream",
      "X-Filename": file.name,
    };
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    if (csrfMeta) headers["x-csrf-token"] = csrfMeta.content;

    const res = await fetch("/upload", {
      method: "POST",
      headers,
      body: file,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Upload failed" }));
      if (toast) toast(err.error || "Upload failed", true);
      return;
    }

    const { path, absolutePath } = await res.json();
    if (onSend) onSend((absolutePath || path) + " ");
  } catch (err) {
    if (toast) toast("Upload failed", true);
  }
}
