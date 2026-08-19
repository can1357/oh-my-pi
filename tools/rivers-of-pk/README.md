# Rivers of PK

Isometric architecture TUI for this repository. Olive/beige wireframe city,
letter-coded boxes, moving data packets, and a live scan of the workspace.

Rust + ratatui + crossterm. Standalone crate — not a member of the 16.4.1
workspace. Point it at this checkout (or any other) and it scans on launch.

## Launch

From the repo root, in a real terminal (Windows Terminal / WezTerm — not a
piped CI shell):

```powershell
cargo run --manifest-path tools/rivers-of-pk/Cargo.toml --release
```

That defaults `--workspace` to the repo root (two parents above
`tools/rivers-of-pk`). To point at another checkout:

```powershell
cargo run --manifest-path tools/rivers-of-pk/Cargo.toml --release -- --workspace C:\dev\Infra\oh-my-pk
```

Scan without opening the TUI (CI / regenerate the graph):

```powershell
cargo run --manifest-path tools/rivers-of-pk/Cargo.toml -- --scan-only
cargo run --manifest-path tools/rivers-of-pk/Cargo.toml -- --dump tools/rivers-of-pk/graph.snapshot.json
```

`--dump` writes the live graph JSON. Re-run it after a structural change to
see new packages appear as `ext-*` boxes.

## Controls

Bottom legend is the original wording:

**INSIDE · COME BACK OUT · MOVE · HOVER TO READ · DRAG TO PAN · SCROLL TO ZOOM**

| Input | Action |
| --- | --- |
| arrows / hjkl / WASD | pan the city |
| mouse drag | pan the city |
| `+` `-` / wheel / PgUp PgDn | zoom |
| `n` `N` / `[` `]` | select next / previous component |
| click sidebar | select + center |
| Enter / click a box | go inside (inner prisms for children) |
| Esc / Backspace / right-click / click empty | come back out |
| hover a box | tooltip: `[X] name · first sentence` |
| hover a `·` `•` `▸` | tooltip with the packet snippet |
| `p` `P` / click a packet / Enter on hover | pin the inspect popup |
| Tab / `1` / `2` | WHAT IT DOES ↔ HOW IT'S BUILT |
| `r` | reset camera |
| `q` | quit |

## How the diagram stays live

| What | Where | When it updates |
| --- | --- | --- |
| Spatial map (boxes, stacks, edges, prose) | `src/city.rs` | edit when a new first-class seam appears |
| Counts, metrics, packet snippets | `src/scan.rs` | every launch |
| Unmapped `packages/*` `crates/*` `python/*` | `scan.rs::attach_unmapped` | every launch — new dirs become `ext-*` System boxes |
| Snapshot for diffs / later discussion | `--dump graph.snapshot.json` | on demand |

Promote an `ext-*` box into `city.rs` (letter code + edges + WHAT/HOW) once
it earns a place on the curated map.

## Layout (one concern per file)

```
src/main.rs     CLI + terminal loop
src/app.rs      keyboard / mouse / panels / tooltips
src/iso.rs      isometric projection, packets, hit-testing
src/city.rs     authored boxes, stacks, edges, prose  ← discuss a box here
src/scan.rs     workspace measurement + unmapped boxes
src/model.rs    Graph / Node / Edge / Section
src/theme.rs    olive / beige truecolor palette
```

Right-panel prose is authored from the architecture walk of this repo
(`AgentSession`, `runLoopBody`, `streamDispatch`, `createTools`, …) and
`scan.rs` substitutes live `{tools}` / `{providers}` / `{models}` counts.

Packet dots carry realistic snippets (`Agent.prompt(...)`,
`executeToolCalls`, `hashline.apply`, SSE `content_block_delta`, …).
