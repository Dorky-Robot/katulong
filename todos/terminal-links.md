# Terminal Links

## Open
- [ ] **Wrapped links get truncated** — when a URL in the terminal wraps across lines, clicking it only captures the portion on one line (adds a space or truncates at the wrap point). The WebLinksAddon in xterm.js handles link detection, but it doesn't rejoin URLs that span multiple lines. Need to investigate: is this an xterm.js WebLinksAddon limitation, or is it a regex/detection issue we can fix? The addon is loaded in `public/lib/terminal-pool.js` via `new WebLinksAddon()`.
