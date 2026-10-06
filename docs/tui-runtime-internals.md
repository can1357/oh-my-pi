# TUI runtime internals

This document maps terminal input and rendering ownership in interactive mode. See [`tui-core-renderer.md`](./tui-core-renderer.md) for terminal-write invariants.

## Ownership

- **`packages/tui`** owns terminal lifecycle, input normalization, focus, overlays, image protocols, cursor placement, scheduling, explicit history writes, and mutable viewport painting.
- **`packages/coding-agent`** owns session semantics and tells the shared TUI components when messages and tools finalize.
- **`packages/tui` integration components** own transcript layout/retirement (`src/chrome/transcript-container.ts`), tool presentation (`src/chat/tool-execution.ts`), editor/status chrome, and the `TerminalFrameProvider` implementation (`src/prompt/composer.ts`).

The terminal core never interprets messages, tools, transcript blocks, or finality.

## Boot and root composition

`Composer` creates the `TUI`, welcome header, editor, and status host. Once `InteractiveMode` is ready it mounts the session containers, with `TranscriptContainer` as the transcript root.

Each normal frame:

1. Render mandatory editor, status, HUD, and overlay chrome.
2. Subtract those rows from the physical viewport.
3. Under capacity pressure, offer the settled prefix that must retire for the live tail to fit, or emit stable rows from the current append-only head. Explicit replay/flush policies can also offer history.
4. Ask `TranscriptContainer` for the live rows within the exact remainder.
5. Return one bounded `TerminalFramePlan`.

Graceful shutdown switches the provider to Flush policy and synchronously drains
every currently eligible finalized prefix before terminal handoff.

The welcome header follows the same ordered retirement model but is composer-owned: it stays live viewport chrome while its intro animates and while the screen has room, then retires once — before any transcript batch — when content first overflows.

## Input and focus

Input path:

`stdin -> ProcessTerminal -> StdinBuffer -> TUI.#handleInput -> focusedComponent.handleInput`

`StdinBuffer` assembles fragmented CSI/OSC/DCS/APC/SS3 sequences and bracketed paste before dispatch. TUI input listeners may consume or transform input first. Key releases are filtered unless the focused component opts in.

`setFocus()` updates `Focusable.focused`; focused components emit `CURSOR_MARKER`, which the frame writer strips while recording the physical cursor target.

Optimistic user submissions call `renderNow()` before agent dispatch so synchronous startup/model work cannot delay the visible user row.

## Explicit transcript lifecycle

`TranscriptContainer` keeps blocks in semantic order:

- **active** — mutable and viewport-resident;
- **settled** — finalized but still live: it re-renders at the current width every frame (so resizes reflow it) until capacity pressure retires it;
- **committed** — acknowledged by the terminal writer and released from render caches.

Finalizing a later block never bypasses an active predecessor. `peekFinalizedBatch(width, capacity)` retires the shortest settled prefix that lets the remaining live tail fit `capacity`, in batches capped by a per-frame render budget (the remainder is offered on later frames), stops at the first active block, and reoffers the same id until `acknowledgeFinalizedBatch()` succeeds. An append-only head may instead emit a monotonically extending prefix of stable semantic rows under pressure, retaining its mutable suffix; final retirement emits only the remainder. `peekFlushBatch(width)` takes the whole eligible finalized prefix during graceful shutdown. Ordinary retirement also bounds the number of live blocks; otherwise, while the screen has room nothing retires, so recent blocks keep reflowing on resize.

The composer opens each frame with `beginFrame(frame)` before offering history. Until that frame's `renderViewport(width, rows, frame)` returns, every full-allocation measurement of a live block (retirement peek, `liveRowCount`, viewport layout) renders the block once and replays those rows; `renderViewport` closes the frame, so no measurement outlives the synchronous composition that took it. Allocation-constrained viewport renders are never shared.

Display replay has an independent cursor over committed entries. It never changes
`committed` states or the logical frontier, and an offered replay never removes
the active tail from the projected viewport.

Every emitted transcript block owns one trailing separator row. This preserves spacing between a finalized user/tool block and the next active assistant/tool row without duplicating separators across batches.

## Viewport allocation and tool collapse

The product root reserves chrome first, gives every active block one row, then allocates surplus to newer blocks. When active count exceeds available rows, it uses a bounded aggregate rather than committing or cancelling work.

`ToolExecutionComponent` owns generic compact presentation:

- three or more rows: full tool renderer;
- two rows: semantic folded card if the full content exceeds the allocation;
- one row: stable label/activity line with shared-clock pulse if the full content exceeds the allocation;
- zero rows: hidden, without changing execution or finality.

Built-in and extension tools use the same wrapper. Renderers may provide semantic activity data; otherwise the wrapper derives command/path/input text and falls back to `tool · running`.

## Terminal write path

A provider frame contains two channels:

```ts
interface TerminalFramePlan {
	readonly history?: {
		readonly id: number;
		readonly rows: readonly string[];
		readonly kind?: "append" | "replay";
	};
	readonly viewport: readonly string[];
	readonly pinBottom?: boolean;
}
```

The writer:

1. Normalizes and width-fits every row with autowrap disabled.
2. Appends only an unacknowledged history id.
3. Repaints the anchored mutable viewport in place.
4. Clears stale rows below the viewport, or, for a `pinBottom` frame, pads blank rows above it down to the bottom row without scrolling on-screen history away.
5. Restores autowrap, synchronized-output state, and cursor state.
6. Acknowledges the exact history id only after the write is accepted in-process.

Viewport-only frames cannot create history. Theme changes leave native history terminal-owned; settled resizes may replay it according to `ResizeScrollbackMode`.

## Resize

During resize, TUI normally borrows the alternate buffer. The frame provider supplies a full semantic viewport tail for that transient buffer; history offers are never acknowledged there. After a quiet window TUI restores the normal buffer and recovers its viewport anchor with a DSR (CSI 6n) round trip. The parked cursor offset and stale viewport rows are remeasured at the new width, including inside multiplexers.

Direct terminals use a bottom-preserving bound: `max(0, min(reported − reflowedParkOffset, height − staleReflowedRows))`. Multiplexer CPR replies instead outrank that bound, because height shrink can discard rows below the cursor rather than pushing rows above it. A missing reply falls back to retained geometry and tracked growth/shrink; multiplexer or growth timeouts retry once before falling back. `packages/tui/src/tui.ts` owns these distinct anchor-recovery paths.

Warp is the exception: it re-reports size on `CSI ?1049h` / `CSI ?1049l`, so borrowing that buffer loops. Warp defaults to in-place repaint outside multiplexers/ConPTY; inside a multiplexer the mux owns the grid and consumes the toggles itself, so an inherited Warp marker keeps the mux-tuned borrow path. `PI_TUI_RESIZE_IN_PLACE=1` forces in-place repaint even inside a multiplexer or ConPTY. `PI_TUI_RESIZE_IN_PLACE=0` forces the borrow even on Warp. The first Warp height-only ±1 SIGWINCH after a toggle write is consumed as that echo: while a borrow owns the alt buffer it is swallowed without probing (a CPR issued now would snapshot the alternate grid); otherwise the in-flight anchor probe is retired and reissued at the echoed size so a predating CPR reply cannot anchor it. A later real one-row resize still restarts the transaction.

A ConPTY host is excluded from in-place resize for the same reason as a multiplexer: conhost owns the grid the application writes to, so `Terminal.hostOwnsGridOnResize` routes those sessions to the borrow. Measured on conhost, resizing the pseudoconsole makes it re-emit its whole viewport from `CSI H` with absolute addressing while the application writes nothing, and it re-homes the cursor, so a DSR reply after a resize reports column 1 instead of the parked tag column and can never be attributed. In-place resize has neither of its preconditions there — a recoverable anchor and a grid nobody else repaints — so the anchor probe is skipped outright (an unattributable reply would only burn a tag column for the session and stall the settled repaint for the full timeout), the settled repaint anchors on the fallback, and the `ResizeScrollbackMode` rebuild erases conhost's stale copy. Two exemptions keep the probe: inside a multiplexer the mux, not conhost, answers the DSR from its own grid, so the reply is attributable and the width-reflow and hidden-grow logic still needs it; and `PI_TUI_RESIZE_IN_PLACE=1` forces in-place there, which restores the CPR round trip along with it.

Warp drags therefore only re-arm the settle window and paint nothing until it goes quiet; each drag event blanks the live viewport up front (the alt path's pre-erase, without the borrow) so shrink reflows can only push committed rows or blanks into scrollback. The single settled repaint runs the same CPR anchor probe and skips the `ResizeScrollbackMode` replay, so native scrollback keeps whatever width it reflowed at instead of an ED3 rewrap. A toggle echo that arrives while a fullscreen overlay owns the alt buffer repaints the modal instead of probing the normal anchor against the alternate grid.

A settled borrowed-buffer resize then applies `ResizeScrollbackMode`. `rebuild` clears native history with ED3 and asks the provider to replay the complete committed ledger and any emitted stable-head prefix under a fresh monotonic id. `append` performs the same independent replay below retained history on width changes, skipping height-only duplicates. `preserve` skips replay and only repaints the anchored viewport. The raw TUI default is `preserve`; the coding agent sets `rebuild`.

A shrink can make the terminal itself push live viewport rows into scrollback before the app hears about the resize; those rows are unreachable to an inline app and may remain above the repainted frame at their old width. The screen itself always converges to exactly one copy. Likewise, when a history append overflows the screen, the writer first erases the old live viewport region so a scroll can only push committed rows and blanks into scrollback, never an unfinished frame.

## Explicit display reset

`resetDisplay()` is destructive and user-driven. It is reserved for session replacement, tree/resume replacement, the display-reset action (Alt+L by default), and settings that rebuild the semantic transcript. Before ED3, the provider starts an independent replay of the committed ledger and any emitted stable-head prefix under a fresh monotonic history id; it does not rewind logical retirement. The same replay transaction serves settled resizes in `rebuild` mode; ordinary rendering, animation, and tool finalization cannot reach it.

Theme or visibility changes that affect only current/future output repaint the mutable viewport; already-retired history remains immutable.

## Overlays and images

Fullscreen overlays use the alternate buffer and never append history. Normal overlays composite over the mutable viewport only. They position in screen rows, so the frame under them normally covers the screen; a `pinBottom` frame keeps its own height and the history above it when no overlay reaches above it, and otherwise covers the screen still aligned to the bottom row.

Inline image data and purge commands are emitted before row placements. Active images may remain graphical in the viewport; finalized history uses textual fallback unless the protocol can account for stable physical rows.

## Native surfaces

A supported Tern Surface Protocol handshake bypasses the row/history renderer.
`Composer.describeSurface()` supplies the flowing transcript as `main` and live
chrome as `dock`; the terminal owns layout and scrolling. Components with no
semantic `describe()` implementation fall back to `rows` nodes. Resizes update
the fallback width without replaying history, and terminal acknowledgements pace
native frames. See [native rendering](./tui-core-renderer.md#native-rendering-tern-surface-protocol).

## Shutdown

Interactive shutdown disposes session-owned work, drains terminal input, restores title/protocol state, and calls `TUI.stop()`. TUI exits any alternate buffer, asks the provider to Flush all eligible finalized history, cancels render/resize timers, preserves terminal-owned image state, places the shell cursor directly after visible TUI content, restores cursor visibility, then delegates terminal-mode restoration to `ProcessTerminal.stop()`.
