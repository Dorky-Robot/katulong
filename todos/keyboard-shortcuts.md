# Keyboard Shortcuts

Refine the shortcut system for better mobile and power-user experience.

## Open
- [ ] Audit current shortcuts — only Esc, Tab are pinned; user has Ctrl+C, Ctrl+C×2, Cmd+K in shortcuts.json. What's missing for common workflows?
- [ ] Consider shortcut profiles (vim, emacs, tmux) instead of one flat list
- [ ] The key island takes up vertical space on phones — could it be more compact or context-aware?
- [ ] sendSequence inter-key delay was reduced to 50ms (from 100ms) — verify this works reliably for multi-key shortcuts like tmux prefix sequences
