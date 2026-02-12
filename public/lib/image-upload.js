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
