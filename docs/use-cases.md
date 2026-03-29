# Use Cases

## Project Command Center

Manage multiple projects from swipeable tiles. Each project gets a Plano tile (context sheet with tasks and notes), a terminal tile (for agents and commands), and optionally a dashboard tile for status. Switch between projects by swiping, with everything persisting across sessions.

## Agentic Workflows

Run Claude Code or other AI agents in a terminal tile while tracking progress in a context sheet. The pub/sub system lets tiles orchestrate — an agent completes a task, the terminal emits an event, a notes tile updates automatically.

## Remote Development

Full terminal access from any browser. SSH into your dev machine from an iPad at a coffee shop. Multiple terminal tiles for different tasks — one running tests, one editing, one monitoring logs.

## Vibe Coding

Use katulong as the workspace where "normal people" do vibe coding the right way. The terminal tile provides the power (agents, CLI tools), while other tiles (notes, file browser, dashboards) provide the context and visibility that make AI-assisted development productive.

## Team Collaboration

Share a katulong instance via tunnel. Multiple people connect to the same workspace, each with their own tile layout. Setup tokens let you add trusted devices without sharing passwords.

## Home Lab Management

Manage your home server, Raspberry Pi, or media center from any device on your network. P2P enhancement gives near-zero latency on LAN.

---

## Why a Tile Platform?

Katulong started as a web terminal and evolved into a tile platform because a terminal alone isn't enough. Real work involves context — notes, task lists, dashboards, file management — alongside the terminal. Instead of switching between apps, katulong puts everything in composable tiles that can reference and react to each other.

The tile system is inspired by spreadsheets: each tile is like a cell that can hold any content, and tiles can orchestrate through pub/sub events — like Excel formulas, but the "formulas" are agents, APIs, and human input.

### Why Not Just Use a Browser?

- **No client needed.** Your phone, a borrowed laptop, any Chromebook — they all have a browser.
- **Passkey authentication.** No SSH keys to generate, copy, rotate, or debug. Register once with your fingerprint.
- **Works over HTTPS.** No firewall rules, port forwarding, or VPN. Katulong works through any tunnel.
- **Persistent sessions.** Close your browser, open it tomorrow, your tiles are there.
- **Mobile-friendly.** Swipe navigation, shortcut toolbar, speech-to-text — all designed for touch.
- **Composable.** Tiles aren't just tabs in a browser — they share storage, events, and can orchestrate work together.
