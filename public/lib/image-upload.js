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
 * Upload image file
 */
export async function uploadImage(file, options = {}) {
  const { onProgress, showToast: toast = showToast } = options;

  if (!isImageFile(file)) {
    if (toast) toast("Not an image file", true);
    return;
  }

  const formData = new FormData();
  formData.append("image", file);

  try {
    const res = await fetch("/upload/image", {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status}`);
    }

    const { path } = await res.json();
    if (toast) toast(`Uploaded: ${file.name}`);

    if (onProgress) {
      onProgress({ success: true, path, file });
    }

    return path;
  } catch (err) {
    console.error("[ImageUpload] Failed:", err);
    if (toast) toast(`Upload failed: ${file.name}`, true);

    if (onProgress) {
      onProgress({ success: false, error: err, file });
    }

    throw err;
  }
}

/**
 * Upload image to terminal (sends path to terminal after upload)
 */
export async function uploadImageToTerminal(file, options = {}) {
  const { onSend, toast = showToast } = options;

  try {
    const res = await fetch("/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": file.name
      },
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
