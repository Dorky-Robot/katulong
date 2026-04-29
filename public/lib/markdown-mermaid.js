/**
 * Mermaid post-render for markdown.
 *
 * marked emits ` ```mermaid ` fences as `<pre><code class="language-mermaid">`.
 * This helper finds those nodes in a freshly-rendered markdown root, lazy-loads
 * the mermaid bundle on first use, and replaces each fence with the rendered
 * SVG. The bundle is the UMD build (~3MB) — vendored as a single file because
 * mermaid's ESM build splits into ~80 chunks per diagram type. We script-tag
 * inject it so callers can keep a clean ESM `await renderMermaidIn(el)` call.
 *
 * Sanitization: marked's output already passed through DOMPurify with default
 * (HTML) profile. The mermaid SVG goes through a second DOMPurify pass with
 * the SVG profile enabled before injection — without that profile DOMPurify
 * strips every `<svg>` descendant.
 */
import DOMPurify from "/vendor/dompurify/purify.es.mjs";

let mermaidPromise = null;

function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    if (globalThis.mermaid) {
      resolve(globalThis.mermaid);
      return;
    }
    const script = document.createElement("script");
    script.src = "/vendor/mermaid/mermaid.min.js";
    script.async = true;
    script.onload = () => {
      const m = globalThis.mermaid;
      if (!m) {
        reject(new Error("mermaid script loaded but global is missing"));
        return;
      }
      m.initialize({
        startOnLoad: false,
        theme: "dark",
        // strict — mermaid runs DOMPurify on diagram labels itself, blocks
        // arbitrary HTML in source. Same hardening posture as the rest of
        // the markdown pipeline.
        securityLevel: "strict",
        fontFamily: "var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif)",
      });
      resolve(m);
    };
    script.onerror = () => reject(new Error("failed to load /vendor/mermaid/mermaid.min.js"));
    document.head.appendChild(script);
  }).catch((err) => {
    // Reset so a subsequent call can retry (e.g., the tile is reopened
    // after a transient network failure).
    mermaidPromise = null;
    throw err;
  });
  return mermaidPromise;
}

let renderCounter = 0;

/**
 * Replace every ` ```mermaid ` fence inside `root` with its rendered SVG.
 * Idempotent — already-rendered blocks (marked with data-mermaid-rendered)
 * are skipped, so calling this twice on the same root is a no-op.
 *
 * @param {HTMLElement} root
 * @returns {Promise<void>}
 */
export async function renderMermaidIn(root) {
  if (!root) return;
  const blocks = root.querySelectorAll('pre > code.language-mermaid');
  if (blocks.length === 0) return;

  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (err) {
    for (const code of blocks) replaceWithError(code.parentElement, err.message, code.textContent);
    return;
  }

  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || !pre.parentElement) continue;
    if (pre.dataset.mermaidRendered === "true") continue;
    const source = code.textContent || "";
    const id = `mermaid-svg-${Date.now()}-${++renderCounter}`;
    try {
      const { svg } = await mermaid.render(id, source);
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-mermaid";
      wrapper.dataset.mermaidRendered = "true";
      wrapper.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
      });
      pre.replaceWith(wrapper);
    } catch (err) {
      replaceWithError(pre, err.message, source);
    }
  }
}

function replaceWithError(pre, message, source) {
  if (!pre || !pre.parentElement) return;
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-mermaid markdown-mermaid-error";

  const msg = document.createElement("div");
  msg.className = "markdown-mermaid-error-msg";
  msg.textContent = `Mermaid render failed: ${message}`;
  wrapper.appendChild(msg);

  const fallback = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source || "";
  fallback.appendChild(code);
  wrapper.appendChild(fallback);

  pre.replaceWith(wrapper);
}
