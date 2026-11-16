import { Terminal, type TerminalIo, type TerminalIoSink, type TerminalOptions } from "@oh-my-pi/pi-tui/terminal";
import { CELL_U32, CellFlags, type GraphicsPlacement, KittyTerminal, loadModuleSync } from "kitty-vt-wasm";

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

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

function createEngine(
	columns: number,
	rows: number,
	scrollback: number,
	onReply?: (bytes: Uint8Array) => void,
): KittyTerminal {
	return KittyTerminal.createSync({
		columns,
		rows,
		scrollback,
		wasm: kittyModule,
		// Forward cursor-position reports (CSI row;col R) to the application like
		// a real terminal answering DSR 6n; the post-resize anchor probe relies on
		// the round trip. Other query replies stay swallowed: the harness never
		// attaches input, so no capability probe is outstanding, and the
		// emulator's own answers (its cell size, keyboard protocol, DECRPM) would
		// override what each test configures.
		onOutput: onReply
			? bytes => {
					const match = utf8Decoder.decode(bytes).match(/\x1b\[\d+;\d+R/);
					if (match) onReply(utf8Encoder.encode(match[0]));
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
 * IO port of a {@link VirtualTerminal}: the terminal engine's captured output
 * goes to the emulator, and injected bytes (typed input, emulator replies)
 * come back as stdin.
 */
class VirtualIo implements TerminalIo {
	// Input is never attached: no raw mode to set, and no capability probes go
	// out. Injected bytes still reach the engine's input parser.
	readonly interactive = false;
	backlog = 0;
	columns: number;
	rows: number;
	sink: TerminalIoSink | undefined;
	/** The size changed while no sink was open; the next `open` reports it. */
	resizedWhileClosed = false;
	consume: (data: string) => void = () => {};

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	open(sink: TerminalIoSink): void {
		this.sink = sink;
		// Parity with ProcessIo.open, which raises SIGWINCH so the engine re-reads
		// geometry at start: a resize made while not started reaches the engine.
		if (!this.resizedWhileClosed) return;
		this.resizedWhileClosed = false;
		sink.resize(this.columns, this.rows);
	}

	write(chunks: readonly Uint8Array[]): void {
		// Streaming: a ConPTY-sized chunk boundary may fall inside a code point.
		for (const chunk of chunks) this.consume(utf8Decoder.decode(chunk, { stream: true }));
	}

	close(): void {
		this.sink = undefined;
	}
}

/**
 * Virtual terminal for testing, backed by kitty's WASM VT engine.
 *
 * The production {@link Terminal} glue and native terminal engine run
 * unchanged: the engine captures its output, which is fed to the emulator,
 * and the emulator's replies plus test input are injected as stdin bytes, so
 * capability negotiation, input parsing, painting, and resize handling are
 * the real ones.
 *
 * The emulator models the active screen grid plus a linear scrollback history and
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
export class VirtualTerminal extends Terminal {
	readonly #io: VirtualIo;
	#term: KittyTerminal;
	#scrollbackCap: number;
	#viewportY = 0;
	#pendingEngineResize = false;
	// Memoized text of committed scrollback rows, keyed by absolute offset. A
	// resize, clear, or bounded-history eviction renumbers offsets; those paths
	// reset this cache. Eliminates the per-op O(history) WASM re-reads that made
	// long streaming runs O(n²) in committed rows.
	#historyTextCache: string[] = [];

	constructor(columns = 80, rows = 24, scrollback?: number, options?: TerminalOptions) {
		const io = new VirtualIo(columns, rows);
		super(io, options);
		this.#io = io;
		this.#scrollbackCap = scrollback ?? DEFAULT_SCROLLBACK_LINES;
		this.#term = createEngine(columns, rows, this.#scrollbackCap, this.#reply);
		io.consume = data => this.receive(data);
	}

	// Deliver emulator replies asynchronously like a real PTY read loop; a
	// synchronous callback would re-enter the terminal engine mid-write.
	readonly #reply = (bytes: Uint8Array): void => {
		queueMicrotask(() => this.#io.sink?.input(bytes));
	};

	/**
	 * The simulated terminal receives output bytes: everything the terminal
	 * engine encodes (frames, probes, out-of-band writes) arrives here, in
	 * order. Subclasses override this to record or rewrite what the emulator
	 * sees, the way a multiplexer or console host sits in front of a terminal.
	 */
	receive(data: string): void {
		this.#engineWrite(data);
	}

	override async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain.
	}

	resize(columns: number, rows: number): void {
		const wasBottom = this.#atBottom();
		this.#io.columns = columns;
		this.#io.rows = rows;
		const sink = this.#io.sink;
		if (sink) {
			// The emulator's grid follows on the next write, as a real terminal's
			// does relative to the SIGWINCH the application reacts to.
			this.#pendingEngineResize = true;
			sink.resize(columns, rows);
		} else {
			this.#io.resizedWhileClosed = true;
			this.#engineResize();
			this.#refollowBottom(wasBottom);
		}
	}

	/** Return whether the virtual viewport is at the scrollback tail. */
	isNativeViewportAtBottom(): boolean | undefined {
		return this.#atBottom();
	}

	// --- Test-only helpers ---------------------------------------------------

	/** Bytes the simulated output stream still holds (see {@link setOutputBacklog}). */
	get outputBacklog(): number {
		return this.#io.backlog;
	}

	/**
	 * Simulate a slow consumer: the engine samples this as its output backlog
	 * and defers frames while it is deep. Lowering it reports a stream drain,
	 * as stdout's `drain` event does.
	 */
	setOutputBacklog(bytes: number): void {
		const previous = this.#io.backlog;
		this.#io.backlog = bytes;
		if (bytes < previous) this.#io.sink?.drained();
	}

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

	/** Simulate keyboard input: the bytes go through the engine's stdin parser. */
	sendInput(data: string): void {
		this.#io.sink?.input(utf8Encoder.encode(data));
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

	/**
	 * Engine output reaches the emulator synchronously, so nothing is left to
	 * drain; the returned promise only yields a microtask for tests that await
	 * ordering (and for emulator replies queued behind the last write).
	 */
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
		for (let i = 0; i < this.#io.rows; i++) {
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
		const total = capped + this.#io.rows;
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
	 * Raw background color words of a viewport row, for tests that assert a
	 * repaint recolored a row rather than reworded it (e.g. a hover band over
	 * an already-tinted row, where column coverage alone cannot observe the
	 * change). Compare snapshots opaquely; values are engine cell words.
	 */
	getViewportRowBackgroundValues(row: number): number[] {
		const words = this.#presentedRowCells(row);
		if (!words) return [];
		const values: number[] = [];
		for (let col = 0; col * CELL_U32 < words.length; col++) values.push(words[col * CELL_U32 + CELL_BG] ?? 0);
		return values;
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

	/** Columns in a viewport row whose cells are drawn in reverse video, such as link hint tags. */
	getViewportRowReverseColumns(row: number): number[] {
		const words = this.#presentedRowCells(row);
		if (!words) return [];
		const columns: number[] = [];
		for (let col = 0; col * CELL_U32 < words.length; col++) {
			if ((words[col * CELL_U32 + CELL_FLAGS] ?? 0) & CellFlags.REVERSE) columns.push(col);
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

	/**
	 * Kitty-graphics placements the engine currently tracks on the active
	 * screen (positions only; pixels are host-side). The engine keeps main and
	 * alternate screen image stores apart exactly as kitty does, so a
	 * placement that only ever reached the alternate buffer is absent here
	 * once the normal screen is back.
	 */
	graphicsPlacements(): GraphicsPlacement[] {
		return this.#term.graphicsPlacements();
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
		this.#term.resize(this.#io.columns, this.#io.rows);
		this.#historyTextCache.length = 0; // engine rewraps scrollback on resize
		const grown = this.#io.rows - prevRows;
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
		this.#term = createEngine(this.#io.columns, this.#io.rows, this.#scrollbackCap, this.#reply);
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
		if (activeRow < 0 || activeRow >= this.#io.rows) return null;
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
