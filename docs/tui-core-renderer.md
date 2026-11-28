# TUI core renderer — explicit history and viewport contract

This document describes the terminal renderer contract of `@oh-my-pi/pi-tui`
(`packages/tui`). The relevant implementation lives in:

- [`packages/tui/src/term/backend.ts`](../packages/tui/src/term/backend.ts) — the
  terminal backend: frame composition, the commit frontier, history batches,
  natural streaming, viewport allocation, replay and the shutdown flush.
- [`packages/tui/src/driver/output/writer.ts`](../packages/tui/src/driver/output/writer.ts)
  — the frame writer: history appends, viewport diffing, synchronized output,
  resize borrow and anchor recovery, fail-stop.
- [`packages/tui/src/driver/contract.ts`](../packages/tui/src/driver/contract.ts) —
  `FramePlan` and `TerminalDriver`, the seam between the two.
- [`packages/tui/src/text/markdown/render.ts`](../packages/tui/src/text/markdown/render.ts)
  — streaming Markdown and its stable head.
- [`packages/tui/src/host.ts`](../packages/tui/src/host.ts) — host lifecycle
  (start, suspend, graceful stop).

Application code owns transcript lifecycle. The renderer does not inspect node
content to guess which rows are final. The model is the Elastic Speculative
Slots protocol ([paper](https://stencil.so/blog/harness-playbook/elastic-slots.pdf));
`packages/tui/test/term/elastic-slots.test.tsx` and
`packages/tui/test/driver-output/elastic-slots.test.ts` check the backend and the
writer against it.

## 1. Frame ownership

A program describes a `Surface` (`packages/tui/src/surface.ts`): `main` (the
transcript, in order), `dock` (live chrome under it) and `layer` (overlays).
The program decides finality with `settle(node)`; nothing else marks a block
final. On each frame the backend paints the regions and hands the driver a
`FramePlan`:

```ts
interface FramePlan {
	readonly history?: { readonly id: number; readonly rows: readonly string[]; readonly kind?: "append" | "replay" };
	readonly viewport: readonly string[];
	readonly cursor: { readonly row: number; readonly col: number } | null;
	readonly fullscreen?: readonly string[];
}
```

`viewport` is the complete mutable screen image for this frame. An `append`
history batch holds the rows of settled blocks retiring whole, or rows of a
streaming block's stable head. A `replay` batch holds the complete ledger at
the current width: every committed block, then whatever retires in the same
frame (a streaming head's stable rows under pressure among it).

A history batch has a monotonic id. `present()` returns the id once the writer
wrote it (the acknowledgement); the backend keeps offering the same batch until
then and never reuses or reorders ids. A batch still unwritten is never written
later under its id once it was dropped, so the backend may drop and prepare it
again: it does when the width changed since it was painted, when the blocks it
writes no longer follow the commit frontier, when the display is lost again
(`onReplay`), and at the shutdown flush.

Block states, per `main` node:

- **active** — unsettled: repainted every frame, viewport only, except for a
  streaming node's stable head;
- **settled** — final but still live: it repaints at the current width (so
  resizes reflow it) until row pressure retires it. Pressure moves only the
  rows that no longer fit: a settled block at the top of the live tail may be
  partly in history, its other rows still live and repainted (a tool card
  collapsing below its rows in history);
- **committed** — acknowledged in history whole. Committed blocks are always
  a prefix of `main` (the commit frontier), in commit order. A block inserted
  above committed blocks (or above the block partly in history), a removal of
  that block, or committed blocks changing places replays history, so every
  block is written once, in order.

Streaming heads: a painter may report `Block.stable`, leading rows that later
input can no longer change (`md` with `stream`, the coding agent's assistant
look). The guarantee is monotone: a row once reported stable never changes for
any extension of the source. Markdown keeps it by ending the head before a
block the text being written may still join (a list continued by a same-marker
item after blank lines, indented code continued by an indented line), before a
display math opener left open (`$$`, `\[`, `\begin{` at a line start), and by
resolving each block's reference links only against the definitions before it
(the open tail included, so rows do not depend on how much of the document is
settled). Under row pressure only the first live block may move rows into
history (a settled block's rows, a streaming block's stable head), and only as
many as the pressure asks; the separator written with its first rows counts,
and may be all that leaves.

The backend remembers the rows of that block it wrote and checks every frame
that the block still starts with them; a block that changed them anyway (a
stable head that was not, `stream` turned off with a different final
rendering) replays history. At another width the rows cannot match and
nothing is replayed for it: the prefix in history (as written, at its width)
is mapped to the rows of the new width by its letters and digits, so wrapping
and padding do not matter (the leading rows whose content is all in history
stay out of the viewport; back at the width it was written at, nothing is
mapped). A block cut inside a paragraph repeats that row's words once; a cut
between blocks maps exactly. When the driver keeps history at its old width on
a resize (`TerminalDriver.replaysOnResize()` false: `preserve` or in-place
resize), pressure moves whole blocks and whole stable heads only, so every cut
is between blocks; one that still does not map (the block changed) replays.

## 2. Rendering a frame

For every frame the backend:

1. Paints the dock; the rest of the screen height is the room for `main`.
2. Retires the shortest settled prefix after the commit frontier that lets the
   live tail fit, or moves stable rows of the first live block. Retirement
   stops at the first active block.
3. Allocates the room among the live blocks (section 2.1).
4. Composites layers over the viewport and hands the plan to the driver.

When the driver acknowledges a batch the backend commits its blocks and asks
for another frame: whatever became eligible while the batch waited retires
then.

The writer (`FrameWriter`):

1. Appends an unacknowledged history batch exactly once, right where the
   viewport begins, then acknowledges its id. A history batch under an empty
   viewport ends with one blank row the cursor parks on, so the next frame or
   the shell never writes over the last history row.
2. Anchors the mutable viewport immediately below history.
3. Normalizes and width-fits rows, writes only changed rows with autowrap off.
4. Parks the hardware cursor inside the synchronized-output frame.

History and viewport have different update rules. History is an ordered
append stream; viewport rows are replaceable. A replay is one write: the clear
(for `rebuild`/display resets) fused with the replayed ledger and the viewport.
No block-at-a-time replay frames are observable.

Without synchronized output (Terminal.app ignores DEC 2026) the terminal may
present any prefix of a frame's write, so those frames never repaint through
rows that only moved. Rows about to leave the screen first show their history
line, line feeds on the bottom row push them into scrollback, surviving rows
shift into place with DL/IL (never deleting on the top row, which Terminal.app
archives into scrollback), and only rows that still differ are rewritten. Every
intermediate screen is the previous frame scrolled or shifted, never a row
beside its stale copy or an erased band awaiting repaint. Frames with images or
OSC 66 text keep the plain row-rewrite path.

Visible overlays are screen-coordinate content. They composite over the
viewport and never become history.

The writer is fail-stop: a sink write that throws stops it for good (no later
write, no acknowledgement of the batch that failed) and rethrows. The process
driver also stops on a failing or stalled stdout.

### 2.1 Viewport allocation

While the live tail fits it shows whole. A taller tail is allocated, newest
first: every active block keeps at least one row, the newest blocks take the
surplus, settled blocks only what is left. A block given fewer rows than it
has is painted at that height (`paint(node, width, height)`: tool looks draw
their compact presentation) and clipped to its tail when its painter ignores
the height. When active blocks outnumber the rows, the newest `rows - 1` keep
one row each under a summary row (`⋯ N more running`, counting the older
active blocks that draw something; the newest of them, at least 16, are
painted to tell, older ones count as drawing). Allocation never retires,
settles or cancels anything.

Dock rows a painter reports as `Block.covering` (the composer's completion
popup) draw over the transcript instead of taking room from it: the room for
`main` stays as it was, and the live rows under them are hidden, not retired.

Once the viewport has reached the bottom of the screen it keeps its height
there: when live content shrinks, blank rows between the live main rows and the
dock keep the dock at the bottom. Those rows are not live rows: retirement and
allocation never count them. The dock stays on the bottom row when the backend
replays history because previously emitted rows changed or retired blocks were
replaced. A caller rebuilding the same transcript can request the same behavior
with `replayHistory({ preserveDock: true })`, as the coding agent does during
compaction. A plain `replayHistory()`, a display reset, or a resize starts a fresh
viewport. A fullscreen layer leaves the normal screen and its pinned viewport in place.

### 2.2 Fullscreen screen mode

`TermBackendOptions.screen` (`HostOptions.screen`; the coding agent's
`tui.screen`) chooses where the session draws: `inline` (everything above) or
`fullscreen`. A fullscreen frame is a `FramePlan.fullscreen` frame: the
writer keeps the alternate screen for the whole session and the normal screen
is left as it was.

- The dock is painted as inline and pinned to the bottom row, also under a
  short transcript; `main` fills the rows above it in a window. Blocks paint at
  natural height (what inline history would hold): no allocation, no summary
  row, no retirement, no history batch. Layers composite over the frame;
  a fullscreen layer replaces it as it does inline.
- The window follows the tail, or is anchored to a `main` node and a row of its
  entry (its separator rows first). Output below an anchored window never moves
  it. The scrollbar shows the position without taking a transcript row.
  With the scrollbar off, its last row reads `↓ N lines below` if room allows.
  Leading blank dock padding yields to transcript rows. An anchor whose rows from
  there on fit (scrolled to the end, a taller screen, the blocks below
  removed) follows the tail again; an anchor row past a block that shrank is
  clamped; an anchor node that left `main` follows the tail.
- `TermBackend.scroll(by)` (`Host.scroll`) moves it by a page (the window less
  one row), a row count, to `start`, or to `end` (following). It returns false
  when no window is on screen (inline, a fullscreen layer up, Tern) so the
  caller's key goes elsewhere. Line, half-page and semantic user-prompt actions
  use the same window. Wheel reports use automatic or fixed steps; modal
  sheets keep their own input. The right-edge scrollbar tracks the viewport.
- Fullscreen requests SGR button-motion and focus reports. Drag selects
  transcript cells, double-click selects words, triple-click selects rows,
  and holding at an edge extends the selection beyond the screen. Copy runs
  through the app's clipboard sink (OSC 52 and local platform helpers).
- `Host.openSearch()` opens incremental transcript find without putting query
  text in the editor. Matches are highlighted; Enter and Shift+Enter cycle
  them, Escape restores the reading position and draft. Inline and native
  hosts decline transcript actions.
- Nothing reaches history until the shutdown flush, which composes the usual
  inline frame: the writer leaves the alternate screen and writes every block
  after the commit frontier below where the session started. With
  `tui.exitTranscript: false`, fullscreen exits without this flush. Emergency
  restoration never invokes application painters: the crash reporter prints a
  resume command after cleanup when the session reached durable storage.
- The commit frontier survives switching modes at runtime: blocks committed
  inline stay committed, a fullscreen stretch commits nothing, and the next
  inline frame retires from the frontier on, so every block reaches history
  once.
- With only fullscreen frames so far (nothing of ours on the normal screen), a
  settled resize repaints instead of replaying and a display reset repaints the
  alternate screen whole instead of clearing: such a session never clears
  native history. `Host.suspend()` does not reset the display on resume unless
  history was written; the next frame enters the alternate screen again.

## 3. Reset and resize behavior

`Host.replayHistory()` (`driver.resetDisplay()`) clears terminal history and the
screen and replays the ledger: the frame after it carries a `replay` batch under
a fresh id. Ordinary renders never clear history; the backend asks for a replay
itself only when history no longer matches the ledger (blocks inserted above
history, reordered or removed, a block whose history rows changed at the same
width), and when it starts again after a stop (`Host.suspend`: what the
terminal holds is unknown).

A resize invalidates viewport geometry and repaints the viewport at the new
width and height. After a settled resize the writer applies the scrollback
policy (`tui.resizeScrollback`, `PI_TUI_RESIZE_SCROLLBACK`):

- `rebuild` clears native history and replays one current-width transcript;
- `append` keeps native history and appends a current-width transcript on
  width changes (height-only resizes do not append a duplicate);
- `preserve` repaints only the viewport and leaves old-width history as it is,
  never clearing it (see the word mapping in section 1).

A height shrink can push the top rows of the screen into scrollback before the
program hears of it. The writer works out which viewport rows the terminal
pushed (blank rows below the cursor go first, then the top rows), checks that
model against the cursor report of the anchor recovery, and only then does not
write them again when the next history batch starts with them (a report
elsewhere, or a second step in the same burst, writes them: duplicates, never
a loss).

The raw default is `preserve`; the coding agent sets `rebuild`. A replay keeps
the commit frontier and acknowledges only after the write returned.

In-place resize (Warp by default outside multiplexers/ConPTY, or forced with
`PI_TUI_RESIZE_IN_PLACE=1`) skips resize replay and repaints once the drag
settles. `PI_TUI_RESIZE_IN_PLACE=0` forces the borrowed-buffer path.
See [runtime resize details](./tui-runtime-internals.md#resize).

The renderer never probes the user's scroll position.

### 3.1 Shutdown

`Host.stop()` flushes before it hands the terminal back
(`TermBackend.flush()`): one last frame writes every live `main` block as it is
now (settled or not) into history, after the ledger a pending replay still
owes, and keeps the dock as the viewport. When the writer cannot write inline
yet (a resize borrow, a quiet resize, an anchor probe), or the driver skips the
frame because output is backlogged, the writer holds that frame and writes it
from the viewport top when the driver stops. `Host.suspend()` does
not flush: the display is replayed when the program resumes.

## 4. ANSI and width invariants

`visibleWidth`, `truncateToWidth`, `sliceByColumn`, and `wrapTextWithAnsi` share
one ANSI-aware UAX#11 width model. Measuring, slicing, truncation, and wrapping
must route through these helpers so escape sequences remain zero-width and
column boundaries agree.

- Printable ASCII uses the fast one-cell-per-code-unit path.
- Non-ASCII text uses the shared narrow-ambiguous width model, with a shared
  terminal/platform-aware Hangul Compatibility Jamo correction.
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

Inside tmux, the pane environment identifies tmux rather than the attached
emulator. At startup, terminal detection asks the local tmux server for
`#{client_termtype}` and `#{client_termname}` and maps recognized names through
the normal capability table: the terminal-type reply first, then a client `TERM`
that names its emulator (`xterm-kitty`, `xterm-ghostty`, `wezterm`). The pane's
own `TERM` (`tmux-*`) never selects an image protocol; an unrecognized client
leaves images to the runtime SIXEL probe. Modified keys still require tmux
`extended-keys`, while OSC notifications and Kitty graphics require
`allow-passthrough`.

`ProcessTerminal` pairs capability queries with typed DA1 sentinel owners.
Private CSI replies may be split across stdin flushes, so reassembly must retain
partial replies until their terminator and must not leak probe bytes as user
input. New probes need a typed sentinel owner and byte-by-byte split-reply
coverage.

SIXEL discovery accepts either a positive XTSMGRAPHICS geometry reply or DA1
attribute 4. `ProcessTerminal.onSixelSupport` publishes and caches the DA1
advertisement while consuming the reply bytes and preserving sentinel ownership.
A missing DA1 attribute does not reject support reported by XTSMGRAPHICS.
Selecting SIXEL from DA1 does not end a pending XTSMGRAPHICS query: its input
consumer remains until the graphics reply arrives or the probe times out.
Explicit `PI_FORCE_IMAGE_PROTOCOL` choices, including `none`/`off`, take priority;
native TSP surfaces keep their own image transport.

### Native rendering (Tern Surface Protocol)

`ProcessTerminal` also sends the TSP `hello` query (APC `tsp`) behind a `tsp`
DA1 sentinel owner. `PI_TUI_NATIVE=0` disables it; multiplexers, devenv's
reloading shell (`DEVENV_RELOAD_FILE`: its terminal layer forwards DA1 but drops
APC) and Bun tests skip it by default, while `PI_TUI_NATIVE=1` forces the probe
(tmux still needs `@tern-tsp`). With `TERM_PROGRAM=tern` only a multiplexer's
session marker counts, not a `screen*`/`tmux*` `TERM` alone, and the debug log
records once why the pane stayed on rows. A supported-version
reply switches `TUI` to `native/backend.ts`: components
are described (`describe()`, or `rows` fallback from `render()`), reconciled
into document ops (`native/reconcile.ts`) and sent as frames, paced by the
terminal's acknowledgements instead of the render cadence. A frame that echoes
user input (a key, a paste, or any UI event Tern reports for a node: a click, a
toggle, an `edit`, …) may run two frames past the credits, counting only frames
unacknowledged for less than 250 ms, so a controlled editor keeps echoing
typing, and a clicked button's effect shows (a form it closes leaves the
screen), while Tern is slow to acknowledge a streaming transcript. The
allowance is a rate, not a total: while Tern stays silent, input sends at most
`credits + 2` frames per 250 ms until
the 5 s stall reset, and each echo carries every change held behind the
credits. Other frames wait for an ack or that reset. None of this
document's history, viewport, resize-replay or CPR machinery runs on that path;
SIGWINCH only refreshes the width used by `rows` fallback nodes. While a surface
is live the nerd symbol preset is forced process-locally, and icon glyphs are
sent as `icon` spans. The first row paint waits
up to 300 ms for the probe. Direct Tern sessions optimistically open a surface
immediately and fall back to rows if the terminal does not confirm it. Such a
session needs raw input from the start, so a `deferInput` start does not leave
the tty cooked. The kernel echo that shows typing on other terminals while the
module graph loads comes from Tern instead: the composer's `editor` node
carries `typeahead: true` (`Editor.nativeTypeahead`, set by `Composer.start`),
and Tern keeps the text typed into it, draws it at the caret, and writes it to
the pty as typed once the prop clears, or ahead of the first key it does not
keep. Typing that reaches omp during startup (from such a flush, or a Tern
without typeahead) splits in the TUI: plain typing (printable text, Backspace)
edits the component focused at start live; the first other key (a shortcut,
Enter, an arrow, a paste) and every key after it are held, in typing order. A
dialog that takes focus meanwhile (a startup hook's select or confirm) gets its
input live, and the hold survives the TUI stop/start of an external editor
opened from such a dialog. A swapped-in custom editor inherits the hold and
the typeahead through `Composer.setEditor()` (`TUI.replaceHeldFocus()`), so
its keys queue behind the held ones, and it keeps the startup submit gate. The
cell-size reply is still consumed on arrival, and the sixel probe is skipped
on a TSP terminal, so no probe listener sees held keys. `InteractiveMode.init()`
calls `Composer.releaseHeldInput()` after startup hooks, mode reconcile, draft
restore and every session subscription, just before lifting the submit gate:
`typeahead` clears so Tern sends what it kept, a restored draft goes before
the text typed during startup, a startup shortcut acts on the final, observed
session, and a held Enter is still ignored. Ctrl+C/Ctrl+D release the TUI's
queue early. The
debug socket's `doc` op returns the reference document
(every sent frame applied by `native/apply.ts`), and `tsp` returns recent frames.

#### Explicit composer submission

omp's `q: "hello"` advertises `features: ["edit", "undo", "send"]`.
The `editor`/`input` prop `sendable` is separate from text editability:
`sendable: true` means the owner is ready to accept an atomic prompt submission.
An absent or false value is not ready, even if the field is writable or focused.
Base `Editor` and `Input` fields publish false because they do not handle `send`.
The prompt `CustomEditor` publishes true only when its `onSubmit` handler exists
and `disableSubmit` is false.

During interactive bootstrap the composer stays writable with `sendable: false`.
Once all handlers and subscriptions are ready, init lifts the submit gate and
requests a render to publish `sendable: true`, without requiring user input.
A terminal must retain a pending prompt until that readiness update arrives; it
must not dispatch early, sleep, poll, or defer a simulated Enter.

A terminal that sees `"send"` and a ready composer may submit a supplied prompt
with an `e` message:

```json
{ "ev": "send", "sf": "s:1", "id": "k.line/input", "text": "First line\nSecond line" }
```

`sf` must name a live surface and `id` its editable composer node (the
`editor` descendant of the `omp.editor` role, normally `<component>.line/input`),
not the composer wrapper or its Send button. All three payload fields are
required strings; surface and node ids must be nonempty. Malformed payloads,
unknown or closed surfaces, and stale/noneditable node targets are ignored.
The terminal must also require `sendable === true` on the addressed node before
dispatching the advertised `send` event. The backend resolves the node's owner and delivers
`{ type: "send", key: "line/input", text }`, independent of keyboard focus.

`CustomEditor` submits this text once through its ordinary `submit()` /
`onSubmit` path. Multiline text remains one prompt; the usual loaded-text
normalization, outer-whitespace trimming, command processing, main-versus-viewed
agent routing and submitted history rules still apply. This is not a paste:
large prompts do not open the large-paste selection menu, and the terminal
must not follow the event with a simulated Enter. Empty or whitespace-only
text is a no-op, never a submission of the existing draft or a stream interrupt.
Disabled or not-yet-wired composers also leave the draft untouched.

Before a nonblank send replaces a draft, the old text, paste expansions and
attachments are retained in local recall history (not persisted as a submitted
prompt). The explicit payload is submitted by itself, without those old
attachments or paste expansions. Sends wait in the input FIFO until any
in-flight clipboard/attachment work settles, including failures, so the
displaced draft is saved only after its pending attachments finish arriving.
Native Send-button actions keep their existing behavior: they submit the
current draft rather than an explicit payload.

## 6. Inline images and memory

Kitty images are transmit-once, place-many. `ImageBudget` retains only the most
recent images; demotion deletes image pixels by id and repaints the affected
viewport rows with the height-preserving text fallback. It does not replay
history. An image already retained in terminal history may lose its pixels when
demoted because historical rows are immutable.

In a fullscreen transcript the viewport clips Kitty placements and SIXEL bands.
OSC 1337 has no source rectangle: a clipped iTerm2 image keeps its space and
reappears when fully visible. A sheet must not be punched through by a
non-cell graphic underneath. Buffer switches invalidate alternate placements;
the graceful transcript flush recreates eligible images on the normal screen.

Never retransmit full base64 image data on every frame. Kitty Unicode
placeholders remain capability-gated and can be overridden with the existing
image environment settings.

## 7. Core invariants

1. Programs decide finality (`settle`); only settled blocks and declared stable
   heads reach history, through ordered history batches.
2. Each batch is written exactly once and acknowledged by id; committed blocks
   are a prefix of `main`, and every block's rows are in history once, in
   order (replays rewrite the whole ledger in a new epoch).
3. A stable row never changes; a streaming head's history rows are verified
   every frame, and any mismatch replays.
4. Ordinary frames diff and repaint the viewport only. They never rewrite,
   audit or clear retained history.
5. Every active block keeps a viewport row while rows allow; overflow is
   summarized, never retired.
6. Only explicit display resets, `rebuild` resizes and ledger mismatches
   destructively clear native history, and only once rows of ours are on the
   normal screen (never in a session that drew only fullscreen frames).
7. A failed write stops the writer; a graceful stop flushes the transcript.
8. Width handling uses the shared ANSI-aware helpers and clamps rather than
   throwing in the render hot path. The renderer never probes scroll position.
