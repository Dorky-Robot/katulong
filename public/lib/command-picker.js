/**
 * Command picker — fzf-style fuzzy finder overlay for jumping to
 * any tile/session.
 *
 * Mounts a centered floating input + filtered list, owns a capture-
 * phase keydown listener while alive so arrow/Enter/Esc get handled
 * before the input or anything else. The input itself still receives
 * typing (we don't preventDefault on printable keys), so filter
 * updates come through its `input` event.
 *
 * Scoring is a small subsequence matcher (fzf-lite): query chars
 * must appear in order, consecutive matches score higher, matches
 * at the start of a word score higher. Ties break by shorter label.
 */

const EL_CLASS = "command-picker";

function score(label, query) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const s = label.toLowerCase();
  let qi = 0;
  let streak = 0;
  let total = 0;
  let lastIdx = -1;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      streak = lastIdx === i - 1 ? streak + 1 : 1;
      total += 10 + streak * 5;
      if (i === 0 || /[^a-z0-9]/.test(s[i - 1])) total += 8;
      lastIdx = i;
      qi++;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -Infinity;
  return total - s.length * 0.1;
}

export function openCommandPicker({ items, onPick, placeholder = "Go to…" }) {
  // Single-instance guard: a second open-while-open would mount a ghost
  // overlay and leak its capture-phase keydown listener on window (Escape
  // only closes the topmost picker). Return the existing handle instead.
  const existing = document.querySelector(`.${EL_CLASS}`);
  if (existing && existing.__handle) return existing.__handle;

  const overlay = document.createElement("div");
  overlay.className = EL_CLASS;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Fuzzy picker");

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.className = "command-picker-input";
  input.setAttribute("aria-autocomplete", "list");
  overlay.appendChild(input);

  const list = document.createElement("ul");
  list.className = "command-picker-list";
  overlay.appendChild(list);

  let filtered = items.slice();
  let selected = 0;

  function render() {
    list.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "command-picker-empty";
      empty.textContent = "No matches";
      list.appendChild(empty);
      return;
    }
    filtered.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = "command-picker-item" + (i === selected ? " selected" : "");

      const label = document.createElement("span");
      label.className = "command-picker-label";
      label.textContent = item.label;
      li.appendChild(label);

      if (item.kind) {
        const kind = document.createElement("span");
        kind.className = "command-picker-kind";
        kind.textContent = item.kind;
        li.appendChild(kind);
      }

      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(i);
      });
      list.appendChild(li);
    });
  }

  function filter() {
    const q = input.value.trim();
    if (!q) {
      filtered = items.slice();
    } else {
      filtered = items
        .map((it) => ({ it, s: score(it.label, q) }))
        .filter((r) => r.s !== -Infinity)
        .sort((a, b) => b.s - a.s || a.it.label.length - b.it.label.length)
        .map((r) => r.it);
    }
    selected = 0;
    render();
  }

  function pick(i) {
    const item = filtered[i];
    close();
    if (!item || !onPick) return;
    // onPick may be async — resolve through a Promise so a synchronous
    // throw before the first await doesn't become an unhandled rejection.
    Promise.resolve().then(() => onPick(item)).catch((err) => {
      console.error("command-picker onPick threw", err);
    });
  }

  function close() {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      pick(selected);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault(); e.stopPropagation();
      if (filtered.length === 0) return;
      selected = Math.min(filtered.length - 1, selected + 1);
      render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      if (filtered.length === 0) return;
      selected = Math.max(0, selected - 1);
      render();
      return;
    }
    // Let everything else (typing) reach the input.
  }

  input.addEventListener("input", filter);
  window.addEventListener("keydown", onKey, true);

  document.body.appendChild(overlay);
  render();
  requestAnimationFrame(() => input.focus());

  const handle = { close };
  overlay.__handle = handle;  // used by the single-instance guard
  return handle;
}
