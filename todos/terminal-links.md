# Terminal Links & Copy

## Open
- [ ] **Wrapped text copy includes padding spaces** — when selecting text that wraps across terminal lines, `term.getSelection()` includes trailing spaces that pad each line to the full column width. Pasting gives `a112     d9d1651e43f...` instead of `a112d9d1651e43f...`. Fix: in the auto-copy handler (and anywhere getSelection is used), strip trailing whitespace from each line and rejoin: `term.getSelection().split('\n').map(l => l.trimEnd()).join('\n')`. This fixes both copy-paste and the link click issue.
- [ ] **Wrapped links get truncated on click** — the WebLinksAddon only matches URLs within a single line. A URL that wraps is detected as two partial strings. May need a custom link provider (`term.registerLinkProvider()`) that reads across buffer lines to reconstruct wrapped URLs.
