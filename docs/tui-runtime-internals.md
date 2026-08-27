# TUI runtime internals

This document maps terminal input and rendering ownership in interactive mode. See [`tui-core-renderer.md`](./tui-core-renderer.md) for terminal-write invariants.

## Ownership

- **`packages/tui`** owns terminal lifecycle, input normalization, focus, overlays, image protocols, cursor placement, scheduling, explicit history writes, and mutable viewport painting.
- **`packages/coding-agent`** owns transcript order, block finality, tool allocation, editor/status chrome, and the `TerminalFrameProvider` implementation in `modes/composer.ts`.

The terminal core never interprets messages, tools, transcript blocks, or finality.

## Boot and root composition

`Composer` creates the `TUI`, welcome header, editor, and status host. Once `InteractiveMode` is ready it mounts the session containers, with `TranscriptContainer` as the transcript root.

Each normal frame:

1. Render mandatory editor, status, HUD, and overlay chrome.
2. Subtract those rows from the physical viewport.
3. Offer a history batch only under capacity pressure: the settled prefix that must retire for the live tail to fit the remainder.
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

Finalizing a later block never bypasses an active predecessor. `peekFinalizedBatch(width, capacity)` retires the shortest settled prefix that lets the remaining live tail fit `capacity`, stops at the first active block, and reoffers the same id until `acknowledgeFinalizedBatch()` succeeds. `peekFlushBatch(width)` takes the whole eligible prefix during graceful shutdown. While the screen has room nothing retires during ordinary operation, so a submitted message is visible immediately and recent blocks keep reflowing on resize.

Display replay has an independent cursor over committed entries. It never changes
`committed` states or the logical frontier, and an offered replay never removes
the active tail from the projected viewport.

Every emitted transcript block owns one trailing separator row. This preserves spacing between a finalized user/tool block and the next active assistant/tool row without duplicating separators across batches.

## Viewport allocation and tool collapse

The product root reserves chrome first, gives every active block one row, then allocates surplus to newer blocks. When active count exceeds available rows, it uses a bounded aggregate rather than committing or cancelling work.

`ToolExecutionComponent` owns generic compact presentation:

- three or more rows: full tool renderer;
- two rows: semantic folded card;
- one row: stable label/activity line with shared-clock pulse;
- zero rows: finalized and hidden.

Built-in and extension tools use the same wrapper. Renderers may provide semantic activity data; otherwise the wrapper derives command/path/input text and falls back to `tool · running`.

## Terminal write path

A provider frame contains two channels:

```ts
interface TerminalFramePlan {
  history?: { id: number; rows: readonly string[] };
  viewport: readonly string[];
}
```

The writer:

1. Normalizes and width-fits every row with autowrap disabled.
2. Appends only an unacknowledged history id.
3. Repaints the anchored mutable viewport in place.
4. Clears stale rows below the viewport.
5. Restores autowrap, synchronized-output state, and cursor state.
6. Acknowledges the exact history id only after the write is accepted in-process.

Viewport-only frames cannot create history. Theme changes leave native history terminal-owned; settled resizes may replay it according to `ResizeScrollbackMode`.

## Resize

During resize, TUI borrows the alternate buffer. The frame provider supplies a full semantic viewport tail for that transient buffer; history offers are never acknowledged there. After a short quiet window TUI restores the normal buffer — which the terminal has reflowed — and recovers the viewport anchor with a DSR (CSI 6n) round trip: every normal paint parks the hardware cursor at a known viewport offset, terminals keep that cursor attached to its logical line through width rewrap, and the settled anchor is `min(reported − parkOffset, height − staleReflowedRows)`. The second bound reconstructs height-shrink scrollback pushes that clamp the cursor instead of scrolling it (bottom-preserving resize guarantees the stale viewport ends on the last screen row whenever a push happened); multiplexers clip instead of rewrapping, so the stale-row measure counts one row per row there. The repaint waits for the CPR reply (200 ms timeout falls back to the bounded retained anchor); `packages/tui/test/resize-anchor-recovery.test.ts` validates the formula against kitty's real core.

A settled resize then applies `ResizeScrollbackMode`. `rebuild` clears native history with ED3 and asks the provider to replay the complete committed transcript under fresh monotonic ids. `append` performs the same independent replay below retained history. `preserve` skips replay and only repaints the anchored viewport. The raw TUI default is `preserve`; the coding agent sets `rebuild`.

A shrink can make the terminal itself push live viewport rows into scrollback before the app hears about the resize; those rows are unreachable to an inline app and may remain above the repainted frame at their old width. The screen itself always converges to exactly one copy. Likewise, when a history append overflows the screen, the writer first erases the old live viewport region so a scroll can only push committed rows and blanks into scrollback, never an unfinished frame.

## Explicit display reset

`resetDisplay()` is destructive and user-driven. It is reserved for session replacement, tree/resume replacement, Ctrl+L, and settings that rebuild the semantic transcript. Before ED3, the provider resets retirement state so the complete finalized prefix is reoffered under new monotonic history ids. The same reset-and-reoffer transaction serves settled resizes in `rebuild` mode; ordinary rendering, animation, and tool finalization cannot reach it.

Theme or visibility changes that affect only current/future output repaint the mutable viewport; already-retired history remains immutable.

## Overlays and images

Fullscreen overlays use the alternate buffer and never append history. Normal overlays composite over the mutable viewport only.

Inline image data and purge commands are emitted before row placements. Active images may remain graphical in the viewport; finalized history uses textual fallback unless the protocol can account for stable physical rows.

## Shutdown

Interactive shutdown disposes session-owned work, drains terminal input, restores title/protocol state, and calls `TUI.stop()`. TUI exits any alternate buffer, asks the provider to Flush all eligible finalized history, cancels render/resize timers, preserves terminal-owned image state, places the shell cursor directly after visible TUI content, restores cursor visibility, then delegates terminal-mode restoration to `ProcessTerminal.stop()`.
