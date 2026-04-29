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
 * strips every `<svg>` descendant. The HTML profile is intentionally NOT
 * combined here: opening the HTML allowlist inside an SVG node would re-admit
 * scriptable elements (<a href="javascript:…">, etc.) that the SVG-only
 * profile correctly rejects.
 */
import DOMPurify from "/vendor/dompurify/purify.es.mjs";

// Maximum mermaid source length we hand to mermaid.render(). Beyond this,
// mermaid's synchronous parse+layout can stall the main thread for seconds
// on pathological flowcharts. Cap at 100kB; surfaces larger fences as an
// inline error instead of silently locking the tab.
const MAX_MERMAID_SOURCE_BYTES = 100_000;

let mermaidPromise = null;
let mermaidScript = null;

function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    // Always (re-)apply our security config, even when the global was set
    // by some earlier code path. Skipping initialize() means a pre-seeded
    // mermaid would render without securityLevel: "strict".
    const finalize = (m) => {
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
    if (globalThis.mermaid) {
      finalize(globalThis.mermaid);
      return;
    }
    // mermaidScript guards against double-injection if a prior rejection
    // cleared mermaidPromise while a script tag from the failed attempt
    // still lingers in the DOM. The error path removes the tag so a real
    // retry re-injects.
    if (!mermaidScript) {
      mermaidScript = document.createElement("script");
      mermaidScript.src = "/vendor/mermaid/mermaid.min.js";
      mermaidScript.async = true;
      document.head.appendChild(mermaidScript);
    }
    mermaidScript.addEventListener("load", () => {
      const m = globalThis.mermaid;
      if (!m) {
        reject(new Error("mermaid script loaded but global is missing"));
        return;
      }
      finalize(m);
    }, { once: true });
    mermaidScript.addEventListener("error", () => {
      if (mermaidScript) { mermaidScript.remove(); mermaidScript = null; }
      reject(new Error("failed to load /vendor/mermaid/mermaid.min.js"));
    }, { once: true });
  }).catch((err) => {
    // Reset so a subsequent call can retry (e.g., the tile is reopened
    // after a transient network failure).
    mermaidPromise = null;
    throw err;
  });
  return mermaidPromise;
}

let svgIdCounter = 0;

/**
 * Replace every ` ```mermaid ` fence inside `root` with its rendered SVG.
 * Idempotent in practice — once a fence is rendered, the original
 * `<pre><code class="language-mermaid">` is gone, so the selector won't
 * match it on subsequent calls.
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
    const source = code.textContent || "";
    if (source.length > MAX_MERMAID_SOURCE_BYTES) {
      replaceWithError(pre, `diagram source too large (${source.length} > ${MAX_MERMAID_SOURCE_BYTES} bytes)`, source);
      continue;
    }
    // Per-call unique id is a mermaid API requirement: render() appends to
    // <defs> using this id as a key, so collisions across calls would
    // cross-pollinate gradients/markers between diagrams.
    const id = `mermaid-svg-${++svgIdCounter}`;
    try {
      const { svg } = await mermaid.render(id, source);
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-mermaid";
      wrapper.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
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
  msg.textContent = `mermaid render failed: ${message}`;
  wrapper.appendChild(msg);

  const fallback = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source || "";
  fallback.appendChild(code);
  wrapper.appendChild(fallback);

  pre.replaceWith(wrapper);
}
