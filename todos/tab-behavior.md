# Tab Behavior

Tab bar bugs and Chrome-like behavior.

## Open
- [ ] **Rename moves tab to end** — `shortcut-bar.js` render() rebuilds the entire tab bar from scratch (`container.innerHTML = ""`), which can reorder tabs if the session store hasn't updated yet. Fix: add a lightweight `renameTabEl()` that updates the label in-place without full re-render, similar to `setActiveTab()`.
- [ ] **New session goes to end** — `createNewSession()` in app.js calls `windowTabSet.addTab(name)` with no position. Fix: find the active tab index and pass it as position so the new tab inserts to the left of the active tab (like Chrome). `addTab` already supports a `position` parameter.
