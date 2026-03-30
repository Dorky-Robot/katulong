# Terminal Jank

Visual glitches, unwanted resizes, scroll/rendering issues.

## Open
(none currently)

## Done
- [x] Tap-to-focus triggers resize — three root causes: ResizeObserver used exact float equality (subpixel shifts on tap), unconditional term.refresh() after scaleToFit, and fitActiveTerminal sent duplicate resize WS message. Fixed with 1px threshold, `changed` flag, and removed double-send.
- [x] fontSize scoping bug in scaleToFit — `const fontSize` block-scoped inside if-block (v0.44.18, PR #424)
- [x] Trackpad scroll on iPad — 3D CSS was blocking wheel events
- [x] Symmetric terminal padding, hidden scrollbar, exact font sizing (#423)
- [x] Write-backpressure to prevent garbled output
