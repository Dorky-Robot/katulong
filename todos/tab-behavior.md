# Tab Behavior

Tab bar bugs and Chrome-like behavior.

## Open
- [ ] **No visual distinction for agent-spawned sessions** — worker sessions opened by the API open in the background with no indication they were kicked off externally. Need a subtle icon, badge, or color on the tab.

## Done
- [x] Rename moves tab to end — added `renameTabEl()` in shortcut-bar.js for in-place label swap
- [x] New session goes to end — `createNewSession()` and `onCreateTile()` now pass `activeIdx + 1` to `addTab()`
