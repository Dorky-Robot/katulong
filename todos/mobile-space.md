# Mobile Space

Maximize horizontal terminal space on phones. Currently wasting pixels on padding and centering gaps.

## Open
- [ ] `fontSizeForWidth(term, contentWidth - 8)` reserves 8px for centering — too much on narrow phones. Make it viewport-aware (e.g., 2px on <600px, 8px on wider)
- [ ] `.terminal-pane { padding: 4px 0 }` adds vertical padding — remove or reduce on phones
- [ ] `.xterm-screen { margin: auto }` centering combined with the 8px reserve doubles the waste
- [ ] No mobile-specific `@media` query for terminal padding exists — need one
