/**
 * Image Upload Helpers
 *
 * Handles image file uploads with progress tracking and toast notifications.
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

// --- Upload progress tracker (Ive-inspired minimal UI) ---

let _tracker = null;

function getTracker() {
  if (_tracker) return _tracker;

  const container = document.createElement("div");
  container.className = "upload-tracker";
  container.innerHTML = "";
  document.body.appendChild(container);

  // Animate in
  requestAnimationFrame(() => container.classList.add("visible"));

  _tracker = {
    el: container,
    items: new Map(),
    add(id, name) {
      const item = document.createElement("div");
      item.className = "upload-tracker-item";
      item.innerHTML = `
        <div class="upload-tracker-row">
          <span class="upload-tracker-name">${escapeText(truncateName(name, 24))}</span>
          <span class="upload-tracker-status" data-status="uploading">
            <span class="upload-tracker-spinner"></span>
          </span>
        </div>
        <div class="upload-tracker-bar"><div class="upload-tracker-fill"></div></div>
      `;
      container.appendChild(item);
      // Animate in
      requestAnimationFrame(() => item.classList.add("visible"));
      this.items.set(id, { el: item, startTime: performance.now(), pct: 0 });
    },
    progress(id, pct) {
      const entry = this.items.get(id);
      if (!entry) return;
      // Only move forward — prevents visual jitter from out-of-order events
      const clamped = Math.min(100, pct);
      if (clamped <= entry.pct) return;
      entry.pct = clamped;
      const fill = entry.el.querySelector(".upload-tracker-fill");
      if (fill) fill.style.width = `${clamped}%`;
    },
    /** Bytes sent, waiting for server to process (clipboard + bridge) */
    processing(id) {
      const entry = this.items.get(id);
      if (!entry) return;
      entry.el.classList.add("processing");
      const fill = entry.el.querySelector(".upload-tracker-fill");
      if (fill) fill.style.width = "80%";
    },
    /** Server responded, waiting for paste */
    uploaded(id) {
      const entry = this.items.get(id);
      if (!entry) return;
      const fill = entry.el.querySelector(".upload-tracker-fill");
      const status = entry.el.querySelector(".upload-tracker-status");
      entry.el.classList.remove("processing");
      entry.el.classList.add("pasting");
      if (status) { status.dataset.status = "pasting"; status.innerHTML = '<span class="upload-tracker-spinner"></span>'; }
    },
    complete(id, success = true) {
      const entry = this.items.get(id);
      if (!entry) return;
      const status = entry.el.querySelector(".upload-tracker-status");
      const fill = entry.el.querySelector(".upload-tracker-fill");
      if (fill) fill.style.width = "100%";
      if (status) {
        status.dataset.status = success ? "done" : "error";
        status.innerHTML = success
          ? '<i class="ph ph-check"></i>'
          : '<i class="ph ph-x"></i>';
      }
      entry.el.classList.remove("pasting");
      entry.el.classList.add(success ? "done" : "error");

      // Fade out this item after a moment, then clean up tracker if empty
      setTimeout(() => {
        entry.el.classList.remove("visible");
        entry.el.classList.add("exiting");
        setTimeout(() => {
          entry.el.remove();
          this.items.delete(id);
          if (this.items.size === 0) destroyTracker();
        }, 400);
      }, success ? 1200 : 2500);
    },
  };

  return _tracker;
}

function destroyTracker() {
  if (!_tracker) return;
  _tracker.el.classList.remove("visible");
  setTimeout(() => {
    _tracker.el.remove();
    _tracker = null;
  }, 400);
}

function escapeText(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function truncateName(name, max) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf(".");
  if (ext > 0 && name.length - ext <= 6) {
    const suffix = name.slice(ext);
    return name.slice(0, max - suffix.length - 1) + "…" + suffix;
  }
  return name.slice(0, max - 1) + "…";
}

// --- Paste completion listeners (notified via WebSocket) ---
const _pasteListeners = new Map(); // path -> resolve callback

export function onPasteComplete(path) {
  const resolve = _pasteListeners.get(path);
  if (resolve) {
    _pasteListeners.delete(path);
    resolve();
  }
}

function waitForPaste(path, timeoutMs = 10000) {
  return new Promise((resolve) => {
    _pasteListeners.set(path, resolve);
    setTimeout(() => {
      _pasteListeners.delete(path);
      resolve(); // resolve even on timeout
    }, timeoutMs);
  });
}

function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.content : null;
}

/**
 * Send data to a specific session via WebSocket input message.
 * Uses explicit session field so the server routes to the correct
 * session even if the user switched tabs since the paste started.
 * Falls back to onSend (which uses the input sender's current session).
 */
function _sendToSession(data, sessionName, getWebSocket, onSend) {
  if (sessionName && getWebSocket) {
    const ws = getWebSocket();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "input", data, session: sessionName }));
      return;
    }
  }
  if (onSend) onSend(data);
}

/**
 * Upload images to terminal.
 * All files upload in parallel for speed. Once all complete, a single
 * POST /paste request tells the server to set clipboard + write Ctrl+V
 * to the PTY for each image sequentially — no per-file round-trips.
 */
export async function uploadImagesToTerminal(files, options = {}) {
  const { onSend, toast = showToast, sessionName, getWebSocket } = options;
  const tracker = getTracker();
  const entries = [];

  for (const file of files) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    tracker.add(id, file.name);
    entries.push({ file, id, promise: _doUpload(file, id, tracker, toast, sessionName) });
  }

  // Wait for all uploads to complete
  const results = await Promise.allSettled(entries.map(e => e.promise));

  const successEntries = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      successEntries.push({ id: entries[i].id, data: results[i].value });
      tracker.uploaded(entries[i].id); // show "pasting..." state
    } else {
      tracker.complete(entries[i].id, false);
      if (toast) toast(results[i].reason?.message || "Upload failed", true);
    }
  }

  if (successEntries.length === 0) return;

  if (successEntries.length === 1) {
    // Single file: clipboard already set during upload (including container
    // bridge). Send Ctrl+V with explicit session to avoid tab-switch race.
    const { id, data } = successEntries[0];
    if (data.clipboard === true) {
      _sendToSession("\x16", sessionName, getWebSocket, onSend);
    } else if (data.fsPath) {
      _sendToSession(data.fsPath + " ", sessionName, getWebSocket, onSend);
    }
    tracker.complete(id, true);
    return;
  }

  // Multi file: one HTTP request starts the batch. Server processes
  // sequentially and sends paste-complete via WebSocket for each file.
  // Register listeners BEFORE sending the request.
  const pathToId = new Map();
  for (const { id, data } of successEntries) {
    if (data.path) pathToId.set(data.path, id);
  }

  // Set up per-file listeners that turn items green as WS notifications arrive
  const waitPromises = [];
  for (const { id, data } of successEntries) {
    if (!data.path) continue;
    waitPromises.push(
      waitForPaste(data.path).then(() => tracker.complete(id, true))
    );
  }

  // Fire the batch request (server responds immediately, pastes async)
  try {
    const headers = { "Content-Type": "application/json" };
    const csrf = getCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
    await fetch("/paste", {
      method: "POST",
      headers,
      body: JSON.stringify({
        paths: successEntries.map(e => e.data.path),
        session: sessionName,
      }),
    });
  } catch {
    // Fallback: send file paths as text
    for (const { id, data } of successEntries) {
      tracker.complete(id, false);
      if (data.fsPath && onSend) onSend(data.fsPath + " ");
    }
    return;
  }

  // Wait for all paste-complete WS messages (with timeout fallback)
  await Promise.all(waitPromises);
}

/**
 * Upload single image to terminal (convenience wrapper).
 */
export function uploadImageToTerminal(file, options = {}) {
  uploadImagesToTerminal([file], options);
}

async function _doUpload(file, id, tracker, toast, sessionName) {
  const headers = {
    "Content-Type": "application/octet-stream",
    "X-Filename": file.name,
  };
  if (sessionName) headers["X-Session"] = sessionName;
  const csrf = getCsrfToken();
  if (csrf) headers["x-csrf-token"] = csrf;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    xhr.upload.onprogress = (e) => {
      // Cap at 80% — remaining 20% represents server processing
      // (clipboard set, container bridge). upload.onprogress only
      // tracks bytes sent, which is instant for small images.
      if (e.lengthComputable) tracker.progress(id, (e.loaded / e.total) * 80);
    };

    // All bytes sent → switch to "processing" state (waiting for server)
    xhr.upload.onload = () => {
      tracker.processing(id);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error("Invalid response")); }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || "Upload failed"));
        } catch { reject(new Error("Upload failed")); }
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

