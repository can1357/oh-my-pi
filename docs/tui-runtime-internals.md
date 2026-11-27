# TUI runtime internals

This document maps terminal input and rendering ownership in interactive mode. See [`tui-core-renderer.md`](./tui-core-renderer.md) for terminal-write invariants.

## Ownership

- **`packages/tui`** (`@oh-my-pi/pi-tui`) owns terminal lifecycle (`host.ts`), the driver (`driver/`: input decoding, probes, the frame writer `driver/output/writer.ts`, images), the terminal backend (`term/backend.ts`: history batches, commit frontier, natural streaming, viewport allocation, replay, shutdown flush), painters (`term/painters/`) and the native Tern backend (`native/`).
- **`packages/coding-agent`** owns session semantics: it builds the surface (`src/modes/interactive/`: the transcript as `main`, composer/status/HUD as `dock`) and settles blocks when messages and tools finalize. Tool looks render viewport allocations (`src/ui/styles/tools/block.ts`).

The terminal backend never interprets messages, tools or transcript blocks: it sees `main` nodes, their settle marks and the rows (and stable heads) their painters return.

## Boot and root composition

`startHost()` starts the driver, negotiates TSP, and renders the program's `Surface` natively (Tern) or with the `TermBackend`. The coding agent's frame puts the transcript blocks in `main` and live chrome in `dock`.

Before settings load, the startup composer can use cached geometry, but it cannot trust a cached mode to decide whether to clear shell history. Without an explicit launch override, the terminal preview draws on the alternate screen. Confirming inline mode returns to the normal screen and clears it with the first inline frame. Confirming fullscreen leaves the normal screen untouched.

Each terminal frame (`TermBackend.#compose`):

1. Paint the dock; the rest of the screen height is the room for `main`.
2. Under row pressure, offer the settled prefix after the commit frontier that must retire for the live tail to fit, or stable rows of the first live block (a streaming head). A display that lost its history gets the replay batch instead (the ledger, then what retires in the same frame).
3. Allocate the room among the live blocks (see below), composite layers.
4. Hand one `FramePlan` to the driver; an acknowledged batch commits its blocks and schedules the next frame.

The welcome block is an ordinary settled `main` block: it stays in the viewport while the screen has room and retires first when content overflows.

## Input and focus

Input path (terminal backend):

`stdin -> driver tokenizer -> decoder -> host intercept -> onKey bubbling -> focused widget -> host onKey`

`packages/tui/src/driver/input/tokenizer.ts` reassembles fragmented CSI/SS3/OSC/DCS/APC sequences and bracketed paste across reads (a lone ESC becomes Escape after a timeout). `decoder.ts` turns them into `InputEvent`s; `keys.ts` gives each key a canonical `KeyEvent.id` (`ctrl+c`, `shift+enter`, …) and a `kind` (`press`, `repeat`, `release`); `replies.ts` routes terminal reports (probe answers) to their owners so they never reach input listeners.

The host's `intercept` sees every decoded event first and may consume it (coding-agent's `Shell` uses it for input interceptors). `TermBackend` (`packages/tui/src/term/backend.ts`) then routes a key along the focus path (`packages/tui/src/dispatch.ts`, `bubbleKey`): `onKey` handlers from the focused node up, then the focused kind's widget (`term/widgets.ts`, `term/widgets/*`: editor edits, picker select/activate, button actions), then the host's global `onKey`. Pastes go to `onPaste` handlers and the widget's `paste`; mouse clicks resolve through the last frame's hit regions.

Widgets read their keys from the widget keymap (`packages/tui/src/term/keymap.ts`: `select.*`, `editor.*`); coding-agent fills it from the user's keybindings via `setWidgetKeymap` (`packages/coding-agent/src/config/keybindings/keybindings.ts`). Matchers ignore key releases.

`Surface.focus(node)` moves focus; both backends draw the caret/focus ring on the focused node, and an `editor`/`input` painter places the terminal cursor. Under Tern the terminal handles input itself and sends the resulting events, which the native backend routes to the same node handlers.

## Explicit transcript lifecycle

`main` keeps blocks in semantic order:

- **active** — unsettled: mutable and viewport-resident (a streaming head may move its stable rows to history ahead of settling);
- **settled** — `settle(node)` was called: final but still live; it repaints at the current width every frame (so resizes reflow it) until row pressure retires it — only the rows that no longer fit, so a settled block may be partly in history and still repaint the rest (a tool card collapsing with Ctrl+O below its rows in history);
- **committed** — all its rows were acknowledged by the writer. Committed blocks always form a prefix of `main` (the commit frontier), in commit order.

Settling a later block never bypasses an active predecessor: retirement takes the rows of the settled prefix after the frontier that must leave for the live tail to fit (whole blocks, then the leading rows of the block the room ends in), stops at the first active block, and reoffers the same batch id until `present()` acknowledges it. A batch still unwritten is prepared again when the width changed, when the blocks it writes no longer follow the frontier, or when the display is lost again; `retired(node)` counts blocks in such a batch, so removing or redrawing them replays. An append-only head (`Block.stable`, e.g. streaming Markdown) may instead emit a monotonically extending prefix of stable rows under pressure, never more than the pressure asks; final retirement emits only the remainder. The backend checks every frame that a block partly in history still starts with the rows it wrote; one that changed them at the same width replays history. After a width change the prefix in history (kept as written, at its width) is mapped to the new rows by its letters and digits instead (no replay: `preserve` and in-place resize keep scrollback; under them, and whenever `driver.replaysOnResize()` is false, pressure moves whole blocks and whole stable heads so the mapping is exact). Inserting a block above history, removing the block partly in history, or reordering committed blocks replays history, so each block is written once and in order. A backend started again after a stop (an external editor) replays history too.

Display replay rewrites the committed ledger under a fresh id, followed by whatever retires in the same frame (stable head rows included), at the current width. It never rewinds the commit frontier.

Separators: `separator(above, below)` blank rows go before a non-empty block, written with it into history (or shown in the viewport) and never duplicated across batches.

## Viewport allocation and tool collapse

While the live tail fits it shows whole. A taller tail is allocated newest first: the dock is reserved first, every active (unsettled) block gets at least one row, newer blocks take the surplus, settled blocks get what is left. When active blocks outnumber the rows, the newest `rows - 1` keep a row each under a bounded summary row (`⋯ N more running`) — never by committing or cancelling work. The allocation's bookkeeping is O(viewport): unsettled indices are a memo over `main` and settle marks.

A block allocated fewer rows than it has is painted at that height (`paint(node, width, height)`); painters that ignore the height are clipped to their tail. The coding agent's tool block (`src/ui/styles/tools/block.ts`, `paintAllocated`) owns compact presentation:

- its own look when it fits the allocation;
- two rows: a frame edge with the title;
- one row: a status line (spinner while running);
- zero rows: nothing, without changing execution or finality.

Dock rows a painter marks `Block.covering` (the composer's completion popup) draw over the transcript: the room for `main` does not shrink for them and the live rows under them are hidden, not retired.

Once the viewport has reached the bottom of the screen, it keeps its height when live content shrinks: blank rows between the live main rows and the dock hold the dock at the bottom. The padding is not live content (retirement and allocation never count it); a replay or a resize resets it (a fullscreen layer leaves the normal screen, and the pin, as they were).

## Terminal write path

The backend hands the driver a `FramePlan` (`packages/tui/src/driver/contract.ts`): an optional history batch (`{ id, rows, kind?: "append" | "replay" }`), the viewport rows, the cursor, or a fullscreen layer.

The writer (`packages/tui/src/driver/output/writer.ts`):

1. Normalizes and width-fits every row with autowrap disabled.
2. Appends only an unacknowledged history id, right where the viewport begins (a replay first clears, unless an `append` resize asked to keep history). History under an empty viewport ends with a blank row the cursor parks on.
3. Repaints the anchored mutable viewport in place, rewriting only changed rows.
4. Clears stale rows below the viewport.
5. Restores autowrap, synchronized-output state, and cursor state.
6. Acknowledges the history id only after the sink accepted the write. A sink write that throws stops the writer for good (nothing is written or acknowledged after it) and rethrows.

Viewport-only frames cannot create history. Theme changes leave native history terminal-owned; settled resizes may replay it according to the scrollback policy.

## Resize

During resize, the writer normally borrows the alternate buffer. Frames show their viewport tail there; history offers are never acknowledged there (the backend prepares an unwritten batch again at the new width). After a quiet window the writer restores the normal buffer and recovers its viewport anchor with a DSR (CSI 6n) round trip. The parked cursor offset and stale viewport rows are remeasured at the new width, including inside multiplexers.

Direct terminals use a bottom-preserving bound: `max(0, min(reported − reflowedParkOffset, height − staleReflowedRows))`. Multiplexer CPR replies instead outrank that bound, because height shrink can discard rows below the cursor rather than pushing rows above it. A missing reply falls back to retained geometry and tracked growth/shrink; multiplexer or growth timeouts retry once before falling back. `FrameWriter` (`packages/tui/src/driver/output/writer.ts`) owns these distinct anchor-recovery paths.

Warp is the exception: it re-reports size on `CSI ?1049h` / `CSI ?1049l`, so borrowing that buffer loops. Warp defaults to in-place repaint outside multiplexers/ConPTY; inside a multiplexer the mux owns the grid and consumes the toggles itself, so an inherited Warp marker keeps the mux-tuned borrow path. `PI_TUI_RESIZE_IN_PLACE=1` forces in-place repaint even inside a multiplexer or ConPTY. `PI_TUI_RESIZE_IN_PLACE=0` forces the borrow even on Warp. The first Warp height-only ±1 SIGWINCH after a toggle write is consumed as that echo: while a borrow owns the alt buffer it is swallowed without probing (a CPR issued now would snapshot the alternate grid); otherwise the in-flight anchor probe is retired and reissued at the echoed size so a predating CPR reply cannot anchor it. A later real one-row resize still restarts the transaction.

A ConPTY host is excluded from in-place resize for the same reason as a multiplexer: conhost owns the grid the application writes to, so `Terminal.hostOwnsGridOnResize` routes those sessions to the borrow. Measured on conhost, resizing the pseudoconsole makes it re-emit its whole viewport from `CSI H` with absolute addressing while the application writes nothing, and it re-homes the cursor, so a DSR reply after a resize reports column 1 instead of the parked tag column and can never be attributed. In-place resize has neither of its preconditions there — a recoverable anchor and a grid nobody else repaints — so the anchor probe is skipped outright (an unattributable reply would only burn a tag column for the session and stall the settled repaint for the full timeout), the settled repaint anchors on the fallback, and the `ResizeScrollbackMode` rebuild erases conhost's stale copy. Two exemptions keep the probe: inside a multiplexer the mux, not conhost, answers the DSR from its own grid, so the reply is attributable and the width-reflow and hidden-grow logic still needs it; and `PI_TUI_RESIZE_IN_PLACE=1` forces in-place there, which restores the CPR round trip along with it.

Warp drags therefore only re-arm the settle window and paint nothing until it goes quiet; each drag event blanks the live viewport up front (the alt path's pre-erase, without the borrow) so shrink reflows can only push committed rows or blanks into scrollback. The single settled repaint runs the same CPR anchor probe and skips the `ResizeScrollbackMode` replay, so native scrollback keeps whatever width it reflowed at instead of an ED3 rewrap. A toggle echo that arrives while a fullscreen overlay owns the alt buffer repaints the modal instead of probing the normal anchor against the alternate grid.

A settled borrowed-buffer resize then applies `ResizeScrollbackMode`. `rebuild` clears native history with ED3 and asks the backend to replay the complete committed ledger (and what retires with it, a streaming head's stable rows included) under a fresh monotonic id. `append` performs the same independent replay below retained history on width changes, skipping height-only duplicates. `preserve` skips replay and only repaints the anchored viewport; history keeps its old width (the backend maps a block partly in history to the new width by its words, see the transcript lifecycle). The raw default is `preserve`; the coding agent sets `rebuild`.

A shrink can make the terminal itself push live viewport rows into scrollback before the app hears about the resize. The writer computes which rows it pushed (blank rows below the cursor are dropped first, then top rows go), confirms that with the cursor report of the anchor recovery, and skips them when the next history batch starts with the same rows, so a transcript block retired after the shrink is not written twice. The screen itself always converges to exactly one copy. Likewise, when a history append overflows the screen, the writer first erases the old live viewport region so a scroll can only push committed rows and blanks into scrollback, never an unfinished frame.

In the fullscreen presentation every frame is drawn on the alternate buffer, so a settled resize just repaints: the transcript window keeps its reading anchor (a block and one of its rows, found again by content at the new width) and nothing is replayed into scrollback.

## Explicit display reset

`Host.replayHistory()` (`driver.resetDisplay()`) is destructive and user-driven. It is reserved for session replacement, tree/resume replacement, the display-reset action (Alt+L by default), removing or redrawing a block with rows in history, and settings that rebuild the semantic transcript. The next frame carries a replay of the committed ledger under a fresh monotonic history id; it does not rewind the commit frontier. The backend replays on its own only when history no longer matches the ledger: a block inserted above committed blocks, or a streaming head whose history rows changed. Ordinary rendering, animation, and tool finalization cannot reach it.

While the presentation is fullscreen the reset is owed instead of run: the alternate buffer is not the display it would clear. It runs before the first inline frame after a switch back.

Theme or visibility changes that affect only current/future output repaint the mutable viewport; already-retired history remains immutable.

## Overlays and images

Fullscreen overlays use the alternate buffer and never append history. Normal overlays composite over the mutable viewport only.

Inline image data and purge commands are emitted before row placements. Active images may remain graphical in the viewport; finalized history uses textual fallback unless the protocol can account for stable physical rows.

## Native surfaces

A supported Tern Surface Protocol handshake bypasses the row/history renderer.
`Composer.describeSurface()` supplies the flowing transcript as `main` and live
chrome as `dock`; the terminal owns layout and scrolling. Components with no
semantic `describe()` implementation fall back to `rows` nodes. Resizes update
the fallback width without replaying history, and terminal acknowledgements pace
native frames. See [native rendering](./tui-core-renderer.md#native-rendering-tern-surface-protocol).

## Shutdown

`Host.stop()` flushes before handing the terminal back: `TermBackend.flush()` composes one last frame that writes every live `main` block as it is now (settled or not: frozen), after the ledger a pending replay still owes, into history, with the dock as the viewport. Overlays and fullscreen layers are not part of it. When the writer cannot write inline yet (a resize borrow or quiet resize, an anchor probe), or the driver skipped it for an output backlog, the writer keeps that frame and writes it from the viewport top in `FrameWriter.stop()`, which then leaves any alternate buffer, places the shell cursor directly after the visible content, and restores autowrap and the cursor before the driver restores terminal modes. `Host.suspend()` does not flush; the backend replays history when it starts again after the external program returns.

In the fullscreen presentation the flush writes nothing: `FrameWriter.stop()` leaves the alternate buffer and the normal screen shows what it held before the program started drawing there.

