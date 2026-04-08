# Terminal cluster state machine

A **terminal cluster** is a single card in the carousel that hosts a grid
of mini terminals, each backed by its own tmux session. Clusters exist
because a PTY has exactly one size — two devices rendering the same pane
at 40 and 200 columns is not physically possible. Splitting into independent
PTYs sidesteps the problem: each mini terminal gets its own session, its
own pane, its own resize events.

This spec is the source of truth for cluster lifecycle. Before adding any
state-touching code to `cluster-tile.js`, check that the new code maps to
one of the states below. If it doesn't, the state machine is wrong —
update this doc first.

## States

| State        | Meaning                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `CREATED`    | Cluster object exists. No DOM, no sub-tiles, no sessions resolved yet.                          |
| `POPULATING` | DOM mounted, sub-tiles being created one slot at a time. Some slots may have no session yet.   |
| `HEALTHY`    | All slots have live tmux sessions attached and rendering.                                       |
| `DEGRADED`   | One or more slots report their session is gone (killed, crashed, server restart dropped it).   |
| `RENAMING`   | User is mid-rename of a slot's session (mutation in flight, don't touch other slots' state).   |
| `DESTROYED`  | Cluster has been unmounted. DOM gone, sub-tiles destroyed, no further events accepted.         |

## Transitions

```
            ┌──────────────┐
 new()  ──▶ │   CREATED    │
            └──────┬───────┘
                   │ mount(container, ctx)
                   ▼
            ┌──────────────┐
            │  POPULATING  │ ◀──────┐
            └──┬────────┬──┘        │ addSlot / removeSlot
               │        │           │ (new slot joins,
    all slots  │        │ slot      │  old slot leaves)
    resolved   │        │ gone      │
               ▼        ▼           │
        ┌──────────┐ ┌──────────┐   │
        │ HEALTHY  │ │ DEGRADED │───┘
        └──┬────┬──┘ └────┬─────┘
           │    │ slot    │ slot
           │    │ gone    │ recovered
           │    └────────▶│
           │              │
 rename()  │              │ rename()
           ▼              ▼
        ┌──────────────────┐
        │    RENAMING      │ (transient; auto-returns to
        └──────────┬───────┘  HEALTHY or DEGRADED on commit)
                   │
                   │ unmount()  (from any state)
                   ▼
            ┌──────────────┐
            │  DESTROYED   │  (terminal)
            └──────────────┘
```

Any state except `DESTROYED` can transition to `DESTROYED` via `unmount()`.
`DESTROYED` is terminal — no re-mount.

## Invariants

1. **One-way death.** Once `DESTROYED`, no method may mutate state, fire
   events, or touch the DOM. Every async callback must check the
   `destroyed` flag on resume. This is the same pattern as the e26d706
   auto-flip guard — a pending fetch must not flip a tile that the user
   already closed.

2. **Serialize captures slot order, not state.** The serialize() output
   is always the slot list in grid order with each slot's session name.
   Transient states (POPULATING, RENAMING, DEGRADED) are not persisted —
   they re-derive on next mount from the session registry.

3. **Slot independence.** A slot entering DEGRADED must not affect sibling
   slots. A DEGRADED cluster is not a dead cluster: the live slots
   continue rendering, and the dead slot shows a placeholder until the
   user removes it or recreates the session. This is the whole point of
   splitting mini terminals into separate PTYs — isolated failure.

4. **Rename atomicity.** While in RENAMING, the session name map must
   never be observable in a half-updated state. Subscribers see either
   the old name or the new name, never both.

## Forbidden states

These must be unreachable. If the code allows them, it's a bug.

1. **Mounted + DESTROYED.** A destroyed cluster must not have any DOM
   nodes attached. The unmount path tears everything down before setting
   the flag.

2. **HEALTHY with dead sessions.** HEALTHY is a claim about every slot.
   If even one slot's session is gone, the state is DEGRADED. A dead
   session that still reports HEALTHY is a staleness bug — the session
   watcher has not fired yet, or its event was swallowed.

3. **POPULATING with no pending work.** If all slots are resolved,
   transition immediately to HEALTHY or DEGRADED. Sitting in POPULATING
   indefinitely means the transition trigger is missing.

4. **RENAMING across clusters.** A rename in flight belongs to exactly
   one cluster. Two clusters simultaneously in RENAMING for the same
   slot is a race condition — the session registry must serialize.

## Mapping to existing code

`public/lib/tiles/cluster-tile.js` implements CREATED and POPULATING
implicitly via its mount/unmount methods. It has no explicit state
field, no degraded-slot handling, and no rename flow.

The path to this spec:

1. **Future PR** — add an explicit `state` field and assertions. Plumb
   session-status-watcher events into per-slot degradation detection.
2. **Future PR** — add rename UX. Until then, slots are created with a
   fixed session name at construction time and never renamed.

This doc is the contract. The code should catch up to it, not the other
way around.
