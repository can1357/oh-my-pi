# TUI core renderer — explicit history and viewport contract

This document describes the core renderer contract. The relevant implementation
lives in:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — frame planning,
  history emission, viewport diffing, overlays, and cursor placement.
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — terminal I/O,
  capability probes, and private-CSI reassembly.
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) — ANSI-aware width,
  slicing, truncation, and wrapping.
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) and
  [`packages/tui/src/components/image.ts`](../packages/tui/src/components/image.ts)
  — inline images and their memory budget.

Application code owns transcript lifecycle. The renderer does not inspect the
component tree to guess which rows are final.

## 1. Frame ownership

A product installs a `TerminalFrameProvider` with `TUI.setFrameProvider()`. On
each render the provider receives the current `ViewportSize` and returns a
`TerminalFramePlan`:

```ts
interface HistoryBatch {
  id: number;
  rows: string[];
  kind?: "append" | "replay";
}

interface TerminalFramePlan {
  history?: HistoryBatch;
  viewport: string[];
}
```

`viewport` is the complete mutable screen image for this frame. An `append`
history batch contains finalized rows or a stable append-only head row. A
`replay` batch contains the complete logical ledger, including any naturally
emitted prefix of the active append-only head. Finality
is therefore an application decision, never an inference from a row crossing
the top of the terminal.

A history batch has a monotonic id. The TUI writes each accepted batch exactly
once, then acknowledges that id to the provider. The provider retains a pending
batch until acknowledgement and does not reuse or reorder ids. This handshake
makes retries and coalesced renders safe without requiring the renderer to
compare a new transcript with terminal scrollback.

The coding agent's `TranscriptContainer` owns the active, pending, and committed
block lifecycle. Blocks are mutable by default. Assistant/thinking producers
explicitly opt into append-only presentation and publish only a monotonically
extending prefix of complete stable semantic rows. Each row re-renders at the
current width; open Markdown and the current partial suffix remain mutable. Under pressure,
only the current logical head can emit one such row without finalizing. Final
retirement writes only its un-emitted suffix.

## 2. Rendering a frame

For every frame the TUI:

1. Requests a plan from the product's frame provider.
2. Appends an unacknowledged history batch, if any, exactly once and
   acknowledges its id.
3. Anchors the mutable viewport immediately below retained terminal history.
4. Normalizes and width-fits viewport rows, composites overlays, and emits only
   the changed viewport rows.
5. Parks the hardware cursor at the real content position inside the
   synchronized-output frame.

History and viewport have deliberately different update rules. History is an
ordered append stream; viewport rows are replaceable and diffed against the
previous viewport. A replay is one atomic exception: the renderer moves the
ledger suffix that fits into leading blank viewport rows, retains the prefix as
history remainder, prepares `remainder || finalViewport`, and performs one
synchronous `terminal.write`. No block-at-a-time replay frames are observable.
Ordinary renders never audit or rewrite terminal history.

Visible overlays are screen-coordinate content. They composite over the
viewport and never become history. Showing, updating, or closing an overlay
only repaints the viewport.

## 3. Reset and resize behavior

Destructive display resets are gesture-driven. `resetDisplay()` and explicit
session replacement may clear terminal history and repaint the current product
state because the user action establishes a new display boundary. Ordinary
renders never clear history.

A resize invalidates viewport geometry and repaints the viewport at the new
width and height. After a settled resize, `ResizeScrollbackMode` selects
how retained history is handled (including cleanup of live rows a height
shrink may have pushed before the resize callback ran):

- `rebuild` clears native history and replays one current-width transcript;
- `append` retains native history and appends a current-width transcript copy;
- `preserve` repaints only the viewport and leaves old-width history unchanged.

The raw TUI defaults to `preserve` and accepts
`PI_TUI_RESIZE_SCROLLBACK`; the coding agent defaults to `rebuild`. Append and
rebuild resize policies each prepare one complete bottom-first replay
transaction; preserve prepares none. Replay consumes one fresh monotonic history
id without rewinding logical retirement state, and acknowledgement happens only
after the synchronous write returns.

The renderer never probes the user's scroll position. This keeps updates safe
while the user is reading older terminal history and avoids terminal- or
platform-specific finality policy.

## 4. ANSI and width invariants

`visibleWidth`, `truncateToWidth`, `sliceByColumn`, and `wrapTextWithAnsi` share
one ANSI-aware UAX#11 width model. Measuring, slicing, truncation, and wrapping
must route through these helpers so escape sequences remain zero-width and
column boundaries agree.

- Printable ASCII uses the fast one-cell-per-code-unit path.
- Non-ASCII text uses the shared narrow-ambiguous width model.
- Tabs use `DEFAULT_TAB_WIDTH`.
- OSC 66 sized spans contribute their declared cell width.
- Over-wide rows are truncated to the viewport width; the render hot path must
  not throw for a cosmetic width mismatch.

ANSI state is normalized at row boundaries so independently updated rows remain
valid. Cursor writes stay inside synchronized output, before ESU, to avoid a
second visible frame.

## 5. Terminal capabilities and input probes

Terminal detection selects optimizations such as synchronized output, DECCARA,
and image protocols; it does not change history semantics.

`ProcessTerminal` pairs capability queries with typed DA1 sentinel owners.
Private CSI replies may be split across stdin flushes, so reassembly must retain
partial replies until their terminator and must not leak probe bytes as user
input. New probes need a typed sentinel owner and byte-by-byte split-reply
coverage.

## 6. Inline images and memory

Kitty images are transmit-once, place-many. `ImageBudget` retains only the most
recent images; demotion deletes image pixels by id and repaints the affected
viewport rows with the height-preserving text fallback. It does not replay
history. An image already retained in terminal history may lose its pixels when
demoted because historical rows are immutable.

Never retransmit full base64 image data on every frame. Kitty Unicode
placeholders remain capability-gated and can be overridden with the existing
image environment settings.

## 7. Core invariants

1. Products decide finality and submit finalized rows only through ordered
   `HistoryBatch` values.
2. The TUI writes a history batch exactly once and acknowledges its monotonic
   id; it never derives history from viewport row position.
3. Ordinary frames diff and repaint the viewport only. They never rewrite,
   audit, clear, or replay retained history.
4. Settled resizes follow the configured replay mode without deriving
   history from cross-width physical row arithmetic.
5. Only explicit display resets and `rebuild` resize mode destructively clear
   native history.
6. Overlays and image-budget changes remain viewport-local.
7. Width handling uses the shared ANSI-aware helpers and clamps rather than
   throwing in the render hot path.
8. The renderer never probes terminal scroll position or forks history policy
   by terminal, multiplexer, or platform.
