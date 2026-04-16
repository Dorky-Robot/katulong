/**
 * Keep uiStore's column order in sync with windowTabSet reorders.
 *
 * windowTabSet and uiStore are two parallel stores that record the same
 * set of session tabs. windowTabSet persists to sessionStorage and
 * coordinates cross-window events; uiStore is the authoritative source
 * for carousel/tile layout.
 *
 * The only mutation that belongs in this sync is a **pure permutation**
 * — the set of tab ids is unchanged, only their order differs. The one
 * call site that produces that today is the session-list drag-reorder
 * in session-list-component.js, which ends by calling
 * windowTabSet.reorderTabs(...).
 *
 * Additions and removals must NOT flow through here. Naively piping
 * every windowTabSet.notify() into uiStore.reorder() clobbers
 * afterFocus-placed insertions: uiStore.addTile("D", afterFocus=B)
 * correctly produces [A, B, D, C] in uiStore; then
 * windowTabSet.addTab("D") appends, producing [A, B, C, D]; then the
 * ungated subscriber reorders uiStore to [A, B, C, D] — the new tile
 * jumps to the end of the carousel. This regressed the Chrome-style
 * insertion behavior originally fixed in PR #499 and rediscovered
 * during the MC3 ui-store rewrite. The permutation-only gate makes the
 * subscriber idempotent for add/remove traffic.
 */

export function installTabOrderSync({ windowTabSet, uiStore } = {}) {
  if (!windowTabSet || !uiStore) return () => {};

  let prev = windowTabSet.getTabs().slice();

  return windowTabSet.subscribe(() => {
    const current = windowTabSet.getTabs();
    if (sameOrder(prev, current)) return;
    const previous = prev;
    prev = current.slice();

    // Pure permutation = same length, same set. Sets of distinct tab
    // names short-circuit on the first foreign id.
    if (current.length !== previous.length) return;
    const previousSet = new Set(previous);
    for (const id of current) {
      if (!previousSet.has(id)) return;
    }
    uiStore.reorder(current);
  });
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
