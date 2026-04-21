/**
 * Image Tile
 *
 * Displays an image loaded from /api/files/image. Supports:
 *   - Fit-to-container (default)
 *   - Zoom via scroll wheel or pinch
 *   - Pan via drag when zoomed
 *   - Double-click to toggle fit/actual-size
 *   - Zoom controls in the header
 *
 * Only file-backed (given a filePath). Persistable — re-fetches on restore.
 */

import { createWorktreeBadge } from "/lib/tiles/tile-badge.js";

// Keep in sync with MIME map in lib/file-browser.js GET /api/files/image
// SVG intentionally excluded — contains executable JavaScript (XSS risk)
const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
]);

export function isImagePath(filePath) {
  if (!filePath) return false;
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(filePath.slice(dot).toLowerCase());
}

export function createImageTileFactory(_deps) {
  return function createImageTile({ filePath, worktreeLabel }) {
    let mounted = false;
    let root = null;
    let imgEl = null;

    // zoom/pan state
    let scale = 1;
    let minScale = 0.1;
    let fitScale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartTX = 0;
    let dragStartTY = 0;

    function filename() {
      const segments = (filePath || "").split("/").filter(Boolean);
      return segments.length > 0 ? segments[segments.length - 1] : "image";
    }

    function updateTransform() {
      if (!imgEl) return;
      imgEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }

    function fitToContainer() {
      if (!imgEl || !root) return;
      const container = imgEl.parentElement;
      if (!container) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const nw = imgEl.naturalWidth || 1;
      const nh = imgEl.naturalHeight || 1;
      fitScale = Math.min(cw / nw, ch / nh, 1); // don't upscale
      scale = fitScale;
      translateX = 0;
      translateY = 0;
      updateTransform();
    }

    function clampTranslate() {
      // Allow panning but keep at least some of the image visible
      if (!imgEl) return;
      const container = imgEl.parentElement;
      if (!container) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const sw = (imgEl.naturalWidth || 1) * scale;
      const sh = (imgEl.naturalHeight || 1) * scale;
      const maxTX = Math.max(0, (sw - cw) / 2 + cw * 0.3);
      const maxTY = Math.max(0, (sh - ch) / 2 + ch * 0.3);
      translateX = Math.max(-maxTX, Math.min(maxTX, translateX));
      translateY = Math.max(-maxTY, Math.min(maxTY, translateY));
    }

    function zoomLabel() {
      return `${Math.round(scale * 100)}%`;
    }

    return {
      mount(el, ctx) {
        mounted = true;

        root = document.createElement("div");
        root.className = "img-tile-root";

        // --- Header ---
        const header = document.createElement("div");
        header.className = "img-tile-header";

        if (worktreeLabel) header.appendChild(createWorktreeBadge(worktreeLabel));

        const titleEl = document.createElement("span");
        titleEl.className = "img-tile-header-title";
        titleEl.textContent = filename();
        titleEl.title = filePath;
        header.appendChild(titleEl);

        const zoomOutBtn = document.createElement("button");
        zoomOutBtn.className = "img-tile-btn";
        zoomOutBtn.innerHTML = '<i class="ph ph-minus"></i>';
        zoomOutBtn.title = "Zoom out";

        const zoomLabelEl = document.createElement("span");
        zoomLabelEl.className = "img-tile-zoom-label";
        zoomLabelEl.textContent = "100%";

        const zoomInBtn = document.createElement("button");
        zoomInBtn.className = "img-tile-btn";
        zoomInBtn.innerHTML = '<i class="ph ph-plus"></i>';
        zoomInBtn.title = "Zoom in";

        const fitBtn = document.createElement("button");
        fitBtn.className = "img-tile-btn";
        fitBtn.innerHTML = '<i class="ph ph-arrows-in"></i>';
        fitBtn.title = "Fit to view";

        const actualBtn = document.createElement("button");
        actualBtn.className = "img-tile-btn";
        actualBtn.textContent = "1:1";
        actualBtn.title = "Actual size";

        const closeBtn = document.createElement("button");
        closeBtn.className = "fb-btn fb-close-btn";
        closeBtn.setAttribute("aria-label", "Close image");
        closeBtn.innerHTML = '<i class="ph ph-x"></i>';
        closeBtn.addEventListener("click", () => ctx?.requestClose?.());

        header.appendChild(zoomOutBtn);
        header.appendChild(zoomLabelEl);
        header.appendChild(zoomInBtn);
        header.appendChild(fitBtn);
        header.appendChild(actualBtn);
        header.appendChild(closeBtn);
        root.appendChild(header);

        // --- Image container ---
        const container = document.createElement("div");
        container.className = "img-tile-container";

        imgEl = document.createElement("img");
        imgEl.className = "img-tile-img";
        imgEl.draggable = false;

        const loadingEl = document.createElement("div");
        loadingEl.className = "img-tile-loading";
        loadingEl.textContent = "Loading…";
        container.appendChild(loadingEl);

        const src = `/api/files/image?path=${encodeURIComponent(filePath)}`;

        imgEl.addEventListener("load", () => {
          if (!mounted) return;
          loadingEl.remove();
          container.appendChild(imgEl);
          fitToContainer();
          zoomLabelEl.textContent = zoomLabel();
          ctx?.setTitle?.(filename());
        });

        imgEl.addEventListener("error", () => {
          if (!mounted) return;
          loadingEl.textContent = "";
          loadingEl.className = "img-tile-error";

          const artEl = document.createElement("div");
          artEl.className = "img-tile-error-art";
          artEl.textContent = "(x_x)";
          loadingEl.appendChild(artEl);

          const msgEl = document.createElement("div");
          msgEl.className = "img-tile-error-msg";
          msgEl.textContent = "Failed to load image";
          loadingEl.appendChild(msgEl);

          const pathEl = document.createElement("div");
          pathEl.className = "img-tile-error-path";
          pathEl.textContent = filePath;
          loadingEl.appendChild(pathEl);
        });

        imgEl.src = src;

        root.appendChild(container);
        el.appendChild(root);

        // --- Zoom buttons ---
        function applyZoom(newScale) {
          scale = Math.max(minScale, Math.min(10, newScale));
          clampTranslate();
          updateTransform();
          zoomLabelEl.textContent = zoomLabel();
        }

        zoomInBtn.addEventListener("click", () => applyZoom(scale * 1.25));
        zoomOutBtn.addEventListener("click", () => applyZoom(scale / 1.25));
        fitBtn.addEventListener("click", () => {
          fitToContainer();
          zoomLabelEl.textContent = zoomLabel();
        });
        actualBtn.addEventListener("click", () => {
          scale = 1;
          translateX = 0;
          translateY = 0;
          updateTransform();
          zoomLabelEl.textContent = zoomLabel();
        });

        // --- Wheel zoom ---
        container.addEventListener("wheel", (e) => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? 0.9 : 1.1;
          applyZoom(scale * delta);
        }, { passive: false });

        // --- Double-click toggle fit/actual ---
        container.addEventListener("dblclick", () => {
          if (Math.abs(scale - fitScale) < 0.01) {
            scale = 1;
            translateX = 0;
            translateY = 0;
            updateTransform();
          } else {
            fitToContainer();
          }
          zoomLabelEl.textContent = zoomLabel();
        });

        // --- Drag pan ---
        container.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          isDragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragStartTX = translateX;
          dragStartTY = translateY;
          container.setPointerCapture(e.pointerId);
          container.style.cursor = "grabbing";
        });

        container.addEventListener("pointermove", (e) => {
          if (!isDragging) return;
          translateX = dragStartTX + (e.clientX - dragStartX);
          translateY = dragStartTY + (e.clientY - dragStartY);
          clampTranslate();
          updateTransform();
        });

        const endDrag = () => {
          isDragging = false;
          container.style.cursor = "";
        };
        container.addEventListener("pointerup", endDrag);
        container.addEventListener("pointercancel", endDrag);
      },

      unmount() {
        if (!mounted) return;
        mounted = false;
        if (imgEl) imgEl.src = ""; // cancel in-flight fetch
        if (root && root.parentElement) root.parentElement.removeChild(root);
        root = null;
        imgEl = null;
      },

      focus() {},
      blur() {},
      resize() {
        // Re-fit if at fit scale
        if (imgEl && Math.abs(scale - fitScale) < 0.01) {
          fitToContainer();
        }
      },
    };
  };
}
