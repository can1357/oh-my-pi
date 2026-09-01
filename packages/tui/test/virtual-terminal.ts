import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { CELL_U32, CellFlags, KittyTerminal, loadModuleSync } from "kitty-vt-wasm";

// ---------------------------------------------------------------------------
// Shared kitty VT engine
// ---------------------------------------------------------------------------
// `VirtualTerminal` is backed by kitty's real terminal core (screen.c +
// vt-parser.c) compiled to WASM (kitty-vt-wasm). Like the libghostty-vt
// backing it replaces, this is a *modern* grapheme-aware terminal: emoji
// presentation and VS16 promotion measure 2 cells, ZWJ/combining clusters
// collapse into their base cell, BCE/erase and scrollback behave exactly as
// kitty/ghostty/WezTerm/iTerm2 do. That makes the render-stress oracles assert
// against ground-truth modern-terminal semantics instead of an approximation,
// so kitty-class rendering bugs (wide-char overrun, pending-wrap staircase,
// grapheme mis-measure) surface here. Unlike ghostty-web 0.4, the engine is
// stable under the fuzz workloads (real wasi-libc allocator, safe free, native
// ED3 and margin-cluster handling), which retired the combining-mark
// stripping, event-log replay/compaction, OOM rotation, and full-clear
// engine-recreate workarounds that used to live here.
//
// The WASM module is compiled once per module evaluation. Synchronous compile
// (no top-level await): `bun test --parallel` leaves any module with top-level
// await broken. Each `VirtualTerminal` instantiates its own engine so
// allocator and grid state stay isolated across tests.
const kittyModule = loadModuleSync(Bun.resolveSync("kitty-vt-wasm/kitty-vt.wasm", import.meta.dir));

function createEngine(
	columns: number,
	rows: number,
	scrollback: number,
	onReply?: (data: string) => void,
): KittyTerminal {
	return KittyTerminal.createSync({
		columns,
		rows,
		scrollback,
		wasm: kittyModule,
		// Forward cursor-position reports (CSI row;col R) to the application like
		// a real terminal answering DSR 6n; TUI's post-resize anchor probe relies
		// on the round trip. Other query replies stay swallowed: tests assert on
		// grid state, and unsolicited capability responses would leak into the
		// focused component as junk keystrokes.
		onOutput: onReply
			? bytes => {
					const reply = new TextDecoder().decode(bytes);
					const match = reply.match(/\x1b\[\d+;\d+R/);
					if (match) onReply(match[0]);
				}
			: undefined,
		// Swallow host events (title, bell, engine log lines); tests read the
		// grid, and the default log fallback would console.error into test
		// output.
		onEvent: () => {},
	});
}

// xterm.js' default scrollback line cap, used when a terminal is created without
// an explicit one. Passed to the engine as its history line budget, and the
// exposed scrollback is clamped to it (below).
const DEFAULT_SCROLLBACK_LINES = 1000;
const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const OSC_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

// Word offsets inside kitty-vt-wasm's 8-word cell snapshot:
// ch, cc1, cc2, fg, bg, decoration_fg, flags, hyperlink. Color words decode as
// kind = word >>> 24 (0 default, 1 palette, 2 truecolor).
const CELL_FG = 3;
const CELL_BG = 4;
const CELL_FLAGS = 6;

/**
 * Virtual terminal for testing, backed by kitty's WASM VT engine.
 *
 * The engine models the active screen grid plus a linear scrollback history and
 * ships its own interactive viewport, but the harness relies on xterm-style
 * scroll bookkeeping (`baseY`/`viewportY`/`scrollLines`), so this wrapper keeps
 * emulating that window over `[history ++ active grid]`:
 *
 * - `baseY` is the scrollback line count, clamped to the requested line cap so a
 *   small `scrollback` evicts oldest history exactly like xterm's line cap (the
 *   engine's history budget equals the cap, so both agree on eviction).
 * - `viewportY` is an absolute scroll offset in `[0, baseY]`; it follows the
 *   bottom on writes/resizes unless the caller scrolled up, matching xterm.
 *
 * This emulation was validated to match `@xterm/headless` bit-for-bit on
 * baseY/viewportY/viewport/scrollBuffer across append, overflow, scroll, write-
 * while-scrolled, and resize sequences.
 */
export class VirtualTerminal implements Terminal {
	#term: KittyTerminal;
	#columns: number;
	#rows: number;
	#scrollbackCap: number;
	#viewportY = 0;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#pendingEngineResize = false;
	// Memoized text of committed scrollback rows, keyed by absolute offset. A
	// resize, clear, or bounded-history eviction renumbers offsets; those paths
	// reset this cache. Eliminates the per-op O(history) WASM re-reads that made
	// long streaming runs O(n²) in committed rows.
	#historyTextCache: string[] = [];

	constructor(columns = 80, rows = 24, scrollback?: number) {
		this.#columns = columns;
		this.#rows = rows;
		this.#scrollbackCap = scrollback ?? DEFAULT_SCROLLBACK_LINES;
		this.#term = createEngine(columns, rows, this.#scrollbackCap, reply => {
			// Deliver asynchronously like a real PTY read loop; a synchronous
			// callback would re-enter the TUI mid-write.
			queueMicrotask(() => this.#inputHandler?.(reply));
		});
	}

	// --- Terminal interface --------------------------------------------------

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal.
		this.#engineWrite("\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain.
	}

	stop(): void {
		this.#engineWrite("\x1b[?2004l\x1b[?5522l");
		this.#inputHandler = undefined;
		this.#resizeHandler = undefined;
	}

	write(data: string): void {
		this.#engineWrite(data);
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		// Backed by kitty's real core: the Kitty keyboard protocol is genuinely
		// supported, so tests can rely on it being active.
		return true;
	}

	get kittyEnableSequence(): string | null {
		return "\x1b[>1u";
	}

	get keyboardEnhancementEnterSequence(): string | null {
		return "\x1b[>1u";
	}

	get keyboardEnhancementExitSequence(): string | null {
		return "\x1b[<u";
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {
		// No-op for virtual terminal.
	}

	moveBy(lines: number): void {
		if (lines > 0) this.#engineWrite(`\x1b[${lines}B`);
		else if (lines < 0) this.#engineWrite(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.#engineWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#engineWrite("\x1b[?25h");
	}

	clearLine(): void {
		this.#engineWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#engineWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#engineWrite("\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		this.#engineWrite(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.#engineWrite(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}

	resize(columns: number, rows: number): void {
		const wasBottom = this.#atBottom();
		this.#columns = columns;
		this.#rows = rows;
		if (this.#resizeHandler) {
			this.#pendingEngineResize = true;
		} else {
			this.#engineResize();
			this.#refollowBottom(wasBottom);
		}
		this.#resizeHandler?.();
	}

	/** Return whether the virtual viewport is at the scrollback tail. */
	isNativeViewportAtBottom(): boolean | undefined {
		return this.#atBottom();
	}

	// --- Test-only helpers ---------------------------------------------------

	/**
	 * Wait for TUI's throttled render pipeline to settle (matches the ~33ms
	 * frame budget). Fixed sleeps race starved CI timers, so callers asserting
	 * on a specific frame pass `until`; polling continues (10ms slices, ~2s
	 * cap) until the predicate observes the expected viewport.
	 */
	async waitForRender(until?: () => boolean): Promise<void> {
		const nextTick = Promise.withResolvers<void>();
		process.nextTick(nextTick.resolve);
		await nextTick.promise;
		await Bun.sleep(40);
		if (until) {
			const deadline = Date.now() + 2_000;
			while (!until() && Date.now() < deadline) await Bun.sleep(10);
		}
		await this.flush();
	}

	/** Simulate keyboard input. */
	sendInput(data: string): void {
		this.#inputHandler?.(data);
	}

	/**
	 * Simulate the user scrolling through native terminal scrollback.
	 * Negative values scroll up; positive values scroll down.
	 */
	scrollLines(lines: number): void {
		this.#viewportY = Math.max(0, Math.min(this.#cappedBaseY(), this.#viewportY + lines));
	}

	/** Get the terminal buffer's scrollback and viewport offsets. */
	getBufferPosition(): { baseY: number; viewportY: number } {
		return { baseY: this.#cappedBaseY(), viewportY: this.#viewportY };
	}

	/** Engine writes are synchronous; nothing to drain. Yield a microtask for ordering. */
	async flush(): Promise<void> {
		await Promise.resolve();
	}

	/** Flush and get viewport - convenience method for tests. */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/** Get the visible viewport (what's currently on screen). */
	getViewport(): string[] {
		const capped = this.#cappedBaseY();
		const historyLen = this.#term.scrollbackLength;
		const lines: string[] = [];
		for (let i = 0; i < this.#rows; i++) {
			const index = this.#viewportY + i;
			lines.push(
				index < capped ? this.#historyRowText(historyLen - capped + index) : this.#term.line(index - capped),
			);
		}
		return lines;
	}

	/** Get the entire scroll buffer (clamped scrollback history followed by the active grid). */
	getScrollBuffer(): string[] {
		const capped = this.#cappedBaseY();
		const historyLen = this.#term.scrollbackLength;
		const lines: string[] = [];
		const total = capped + this.#rows;
		for (let i = 0; i < total; i++) {
			lines.push(i < capped ? this.#historyRowText(historyLen - capped + i) : this.#term.line(i - capped));
		}
		return lines;
	}

	/**
	 * Columns in a viewport row whose cells carry a non-default background color.
	 * Used by the SGR-bleed oracle: background attributes must appear only on
	 * rows whose logical content carries background SGR — BCE (back-color-erase)
	 * makes `\x1b[K`/`\x1b[2K` fill erased cells with the *current* background,
	 * so leaked SGR state paints whole phantom-colored rows.
	 */
	getViewportRowBackgroundColumns(row: number): number[] {
		return this.#rowColumnsWithColor(row, CELL_BG);
	}

	/**
	 * Columns in a viewport row whose cells carry a non-default foreground color.
	 * Used with unreset-SGR regressions to ensure per-line resets confine
	 * foreground attributes to the row that emitted them.
	 */
	getViewportRowForegroundColumns(row: number): number[] {
		return this.#rowColumnsWithColor(row, CELL_FG);
	}

	/**
	 * Columns in a viewport row whose cells carry underline.
	 * Used with unreset-SGR regressions to ensure style attributes do not bleed
	 * into later rows or erased blanks.
	 */
	getViewportRowUnderlineColumns(row: number): number[] {
		const words = this.#presentedRowCells(row);
		if (!words) return [];
		const columns: number[] = [];
		for (let col = 0; col * CELL_U32 < words.length; col++) {
			if ((words[col * CELL_U32 + CELL_FLAGS] ?? 0) & CellFlags.UNDERLINE_MASK) columns.push(col);
		}
		return columns;
	}

	/** Whether the cell at a viewport position carries the italic attribute. */
	getCellItalic(row: number, col: number): boolean {
		const words = this.#presentedRowCells(row);
		return !!words && ((words[col * CELL_U32 + CELL_FLAGS] ?? 0) & CellFlags.ITALIC) !== 0;
	}

	/**
	 * Get the hardware cursor position within the visible viewport.
	 * Both coordinates are 0-indexed; row is relative to the top of the active grid.
	 */
	getCursor(): { row: number; col: number } {
		const cursor = this.#term.cursor;
		return { row: cursor.y, col: cursor.x };
	}

	/** Clear the buffer to a blank slate (fresh engine terminal). */
	clear(): void {
		this.#recreate();
	}

	/** Reset the terminal completely (fresh engine terminal). */
	reset(): void {
		this.#recreate();
	}

	// --- Internals -----------------------------------------------------------

	#engineWrite(data: string): void {
		const wasBottom = this.#atBottom();
		if (this.#pendingEngineResize) {
			this.#engineResize();
			this.#pendingEngineResize = false;
		}
		if (data.includes("\x1b[3J")) {
			// ED3 clears history and renumbers scrollback offsets, so the
			// offset-keyed history text cache is stale. The engine processes the
			// bytes natively — full-clear and destructive no-ED2 repaints both
			// exercise the real self-clear contract the render tests exist to
			// catch.
			this.#historyTextCache.length = 0;
		}
		this.#term.write(this.#stripSynchronizedOutput(data));
		if (this.#term.scrollbackLength >= this.#scrollbackCap) this.#historyTextCache.length = 0;
		this.#refollowBottom(wasBottom);
	}

	/**
	 * Strip synchronized-output markers and OSC strings before the engine sees
	 * them. Mode 2026 would buffer a frame until its end marker, but the tests
	 * assert on readback between writes of a frame; OSC payloads (titles,
	 * notifications, clipboard) have no grid effect the oracles read.
	 */
	#stripSynchronizedOutput(data: string): string {
		if (!data.includes(SYNC_OUTPUT_BEGIN) && !data.includes(SYNC_OUTPUT_END) && !data.includes("\x1b]")) return data;
		return data.replaceAll(SYNC_OUTPUT_BEGIN, "").replaceAll(SYNC_OUTPUT_END, "").replace(OSC_SEQUENCE, "");
	}

	#atBottom(): boolean {
		return this.#viewportY >= this.#cappedBaseY();
	}

	/** Scrollback line count exposed to callers, clamped to the requested line cap. */
	#cappedBaseY(): number {
		return Math.min(this.#term.scrollbackLength, this.#scrollbackCap);
	}

	#refollowBottom(wasBottom: boolean): void {
		const base = this.#cappedBaseY();
		this.#viewportY = wasBottom ? base : Math.min(this.#viewportY, base);
	}
	/** Apply the pending grid size to the engine, preserving xterm resize semantics. */
	#engineResize(): void {
		const prevRows = this.#term.rows;
		this.#term.resize(this.#columns, this.#rows);
		this.#historyTextCache.length = 0; // engine rewraps scrollback on resize
		const grown = this.#rows - prevRows;
		if (grown > 0) {
			// kitty leaves scrolled-out lines in history when the grid grows;
			// xterm/tmux/ghostty pull them back onto the new blank rows. Emulate
			// with kitty's SD+ (scroll down filling from scrollback), then move
			// the cursor down with the shifted content.
			const pull = Math.min(grown, this.#term.scrollbackLength);
			if (pull > 0) this.#term.write(`\x1b[${pull}+T\x1b[${pull}B`);
		}
	}

	#recreate(): void {
		this.#term.dispose();
		this.#term = createEngine(this.#columns, this.#rows, this.#scrollbackCap, reply => {
			queueMicrotask(() => this.#inputHandler?.(reply));
		});
		this.#pendingEngineResize = false;
		this.#viewportY = 0;
		this.#historyTextCache.length = 0; // fresh engine: prior scrollback is gone
	}

	/** Raw cell words of the presented viewport row (history when scrolled up, else active grid). */
	#presentedRowCells(row: number): Uint32Array | null {
		const index = this.#viewportY + row;
		const capped = this.#cappedBaseY();
		if (index < capped) {
			return this.#term.scrollbackLineCells(this.#term.scrollbackLength - capped + index);
		}
		const activeRow = index - capped;
		if (activeRow < 0 || activeRow >= this.#rows) return null;
		return this.#term.lineCells(activeRow);
	}

	/** Columns of a viewport row whose color word at `wordOffset` is non-default. */
	#rowColumnsWithColor(row: number, wordOffset: number): number[] {
		const words = this.#presentedRowCells(row);
		if (!words) return [];
		const columns: number[] = [];
		for (let col = 0; col * CELL_U32 < words.length; col++) {
			// Color word kind: 0 default, 1 palette, 2 truecolor.
			if ((words[col * CELL_U32 + wordOffset] ?? 0) >>> 24 !== 0) columns.push(col);
		}
		return columns;
	}

	/** Text of a scrollback-history row by line offset (0 = oldest), memoized. */
	#historyRowText(offset: number): string {
		const cached = this.#historyTextCache[offset];
		if (cached !== undefined) return cached;
		const text = this.#term.scrollbackLine(offset) ?? "";
		this.#historyTextCache[offset] = text;
		return text;
	}
}
