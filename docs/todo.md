# Katulong Tile Platform — Roadmap

## Done

- [x] Tile SDK (`sdk.storage`, `sdk.platform`, `sdk.api`, `sdk.toast`, `sdk.ws`, `sdk.pubsub`, `sdk.sessions`)
- [x] Extension system (server discovery, client loader, file serving)
- [x] Plano tile (one note per tile, tala-editor, localStorage persistence)
- [x] Chrome zones (toolbar, sidebar, shelf)
- [x] Carousel-everywhere (desktop = iPad, single code path)
- [x] Single state owner (carousel → windowTabSet, unified boot)
- [x] session-state.js extracted
- [x] Scaffolding tiles removed (only terminal is built-in)
- [x] Docs updated to reflect tile platform identity

## Next: Plano Tile Polish

- [ ] Connect Plano to Tala backend (optional per-tile config: talaUrl + talaToken)
- [ ] Tala history map in sidebar (extract `<tala-history>` web component from note.js)
- [ ] Note title editable inline (not via prompt())
- [ ] Markdown preview improvements (code blocks, images, links)
- [ ] Multiple Plano tiles restore correctly with independent content

## Next: Tile Marketplace

- [ ] `katulong install <repo>` CLI command (clones into `~/.katulong/tiles/`)
- [ ] `katulong uninstall <name>` CLI command
- [ ] `katulong tiles` CLI command (list installed extensions)
- [ ] Marketplace registry (list of community tiles, versions, descriptions)
- [ ] Auto-update mechanism for installed tiles

## Next: Tile Orchestration

- [ ] Pub/sub between tiles (tile A emits event → tile B reacts)
- [ ] `sdk.pubsub` cross-tile events with typed topics
- [ ] CLI integration (`katulong pub/sub` already exists — wire to tile SDK)
- [ ] Agent-driven orchestration (terminal tile completes task → Plano tile checks off item)

## Next: CEO Dashboard

- [ ] Multi-project view (one Plano tile per DorkyRobot project)
- [ ] Status aggregation tile (pulls from all project context sheets)
- [ ] Compose: Plano + Terminal + Status across kubo, sipag, yelo, diwa, katulong, tala
- [ ] Cross-project task tracking via tala-backed checklists
