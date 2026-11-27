/**
 * The frame writer: the output half of the terminal driver.
 *
 * Inline mode keeps two channels on the normal screen. History is an
 * append-only stream: every batch is written exactly once, right where the
 * viewport begins, and its id acknowledged. The viewport is the mutable
 * screen image anchored below history: rows are normalized, width-fitted
 * and written with autowrap off, and only changed rows are rewritten.
 * Fullscreen frames draw on the alternate screen and never touch history.
 *
 * Every frame is one write: synchronized output (DEC 2026) when the
 * terminal supports it, with the cursor parked and its visibility set
 * inside the update. Without it any prefix of a write may be on screen, so
 * frames whose rows move shift them with DL/IL instead of repainting
 * through them (see `shift.ts`).
 *
 * Resizes: by default the writer borrows the alternate screen while the
 * terminal reflows (frames show the viewport there), and after a quiet
 * window returns to the normal screen, recovers the viewport anchor with a
 * cursor position report and applies the replay policy. In-place resize
 * (Warp, or forced) blanks the viewport and paints nothing until the drag
 * settles. See docs/tui-core-renderer.md and docs/tui-runtime-internals.md.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { FramePlan } from "../contract";
import { alternatePlacement, rasterDamage } from "../images/viewport";
import type { KeyboardScreenModes } from "../io";
import {
	ALT_ENTER,
	ALT_LEAVE,
	AUTOWRAP_OFF,
	AUTOWRAP_ON,
	CLEAR_ALL,
	CURSOR_HIDE,
	CURSOR_SHOW,
	column,
	coveredCells,
	deleteLines,
	down,
	drawRow,
	ERASE_DOWN,
	ERASE_LINE,
	ERASE_LINE_LEFT,
	hasGraphics,
	insertLines,
	normalizeRow,
	position,
	reflowHeight,
	right,
	SYNC_BEGIN,
	SYNC_END,
	up,
} from "./ansi";
import { planShift } from "./shift";

/** Where frames go: the terminal's output stream. */
export interface OutputSink {
	/**
	 * Queue bytes in order (never reordered with other writes). Throws when
	 * the terminal is gone: the writer stops for good (nothing is written or
	 * acknowledged after a failed write) and rethrows.
	 */
	write(data: string): void;
	/** Resolves once everything written so far reached the terminal. */
	flush(): Promise<void>;
}

/** What retained history does after a settled resize. */
export type ResizeScrollback = "rebuild" | "append" | "preserve";

/** What the writer asks of the frame source. */
export type Invalidation =
	/** Present a frame again (geometry settled, the anchor was recovered). */
	| "repaint"
	/** The next frame must carry a `replay` history batch: the complete ledger at the current width, under a fresh id. */
	| "replay";

/** Which screen a write draws on. */
export type Screen = "main" | "alternate";

/** Image sequences written before a frame's rows (see `driver/images`). */
export interface FrameImages {
	/**
	 * Sequences to write before rows drawn on `screen`. kitty and Ghostty keep
	 * one image store per screen, so data sent on one is unknown to the other.
	 */
	takeSequences(screen: Screen): string;
	/** The alternate screen was entered: kitty and Ghostty start it with an empty image store. */
	enteredAlternate?(): void;
	/**
	 * The main screen and its history are being erased (the erase precedes
	 * the next sequences): an erase frees every image left without a
	 * placement, so everything drawn again must be transmitted again.
	 */
	cleared?(): void;
}

/** Configuration of a {@link FrameWriter}. */
export interface FrameWriterOptions {
	readonly sink: OutputSink;
	readonly columns: number;
	readonly rows: number;
	/** Wrap frames in DEC 2026 synchronized updates; read per frame. */
	readonly synchronizedOutput: () => boolean;
	/** A multiplexer owns the grid: CPR replies outrank the clip model and no SIGWINCH-side erase is done. */
	readonly multiplexer: () => boolean;
	/** A host that repaints the grid itself on resize (ConPTY): no anchor probe, settled resizes rebuild. */
	readonly hostOwnsGrid?: () => boolean;
	/** Warp: re-reports its size on alternate-screen toggles; the first ±1 height echo is consumed. */
	readonly warp?: () => boolean;
	/** Repaint in place after a resize settles instead of borrowing the alternate screen. */
	readonly inPlaceResize?: () => boolean;
	/**
	 * Settle a resize without borrowing the alternate screen (frames wait for
	 * the settle; the replay policy still applies). tmux: restoring the
	 * alternate screen schedules a redraw that ends a synchronized update
	 * early, exposing a long rebuild replay mid-write.
	 */
	readonly resizeAvoidsAlternate?: () => boolean;
	/** The host expires a synchronized update after a deadline (tmux): long writes renew it as they stream. */
	readonly renewsSynchronizedOutput?: () => boolean;
	/**
	 * The host may grow its grid before the resize reaches us (tmux): under
	 * `rebuild`, a grow that leaves a once-full viewport short of the bottom
	 * replays history instead of trusting the damaged copy.
	 */
	readonly growsBeforeResize?: () => boolean;
	/** Default `preserve`. */
	readonly resizeScrollback?: ResizeScrollback;
	/** Quiet window ending a resize burst, in ms. Default 100. */
	readonly settleMs?: number;
	/** Run `callback` after `ms`; returns a cancel. Default: `setTimeout`. */
	readonly schedule?: (callback: () => void, ms: number) => () => void;
	/** Cursor position report, 0-based; null when the terminal does not answer in time. */
	readonly queryCursor?: () => Promise<{ readonly row: number; readonly col: number } | null>;
	/** Bytes keeping keyboard reporting alive across alternate-screen switches. */
	readonly keyboardScreenModes?: () => KeyboardScreenModes;
	readonly images?: FrameImages;
	/** The frame source can answer `replay` invalidations (otherwise resizes never replay). */
	readonly canReplay?: () => boolean;
	/** Ask the frame source for a new frame. */
	readonly onInvalidate?: (request: Invalidation) => void;
}

function schedule(callback: () => void, ms: number): () => void {
	const timer = setTimeout(callback, ms);
	return () => clearTimeout(timer);
}

/** A row that never equals a real one: screen content whose text is unknown. */
const UNKNOWN_ROW = "\u0000?";

/**
 * Cursor movement within one frame, in rows relative to an origin. Rows
 * below `limit` are known to exist on screen and are reached with CUD; rows
 * past it are created with line feeds (which scroll at the bottom).
 */
class Pen {
	out = "";
	row: number;
	limit: number;

	constructor(row: number, limit: number) {
		this.row = row;
		this.limit = Math.max(limit, row + 1);
	}

	goto(row: number): void {
		if (row < this.row) {
			this.out += up(this.row - row);
		} else if (row > this.row) {
			const reachable = Math.min(row, this.limit - 1);
			this.out += down(reachable - this.row);
			if (row > reachable) {
				this.out += "\r\n".repeat(row - reachable);
				this.limit = row + 1;
			}
		}
		this.row = row;
	}
}

interface Transaction {
	readonly columns: number;
	readonly rows: number;
	shrank: boolean;
	grew: boolean;
	readonly inPlace: boolean;
	/** Frames wait for the settle (in place, or no borrow). */
	readonly quiet: boolean;
	/** The viewport reached the bottom row before the resize. */
	readonly full: boolean;
	cancel: (() => void) | undefined;
}

/** Bytes after which a renewing host gets `CSI ? 2026 h` again (well inside tmux's one-second budget). */
const SYNC_RENEW_BYTES = 16 * 1024;

/** See the module docs. */
export class FrameWriter {
	readonly #options: FrameWriterOptions;
	readonly #sink: OutputSink;
	#columns: number;
	#rows: number;
	#started = false;

	/** The last viewport's rows, raw to normalized at {@link #normalizedWidth} ({@link #normalizeViewport}). */
	#normalized = new Map<string, { text: string; graphics: boolean }>();
	#shownGraphics = false;
	#normalizedWidth = 0;
	// Inline viewport on the normal screen.
	/** Rows shown, normalized. */
	#shown: string[] = [];
	/** Cursor row/column relative to the viewport top (column -1: unknown). */
	#cursorRow = 0;
	#cursorCol = 0;
	/** The shell's line may be partial (including a missing CPR); only the first inline frame may advance it. */
	#partialShellLine = false;
	/** Rows clipped from the start of the last inline frame. */
	#clipped = 0;
	/** Bounds on the viewport top's screen row; equal when known. */
	#topLo = 0;
	#topHi = 0;
	/** Rows below the viewport top known to exist (when the top is unknown). */
	#extent = 1;
	/** Cursor visibility the terminal holds; undefined after a buffer switch. */
	#visible: boolean | undefined = undefined;

	// Alternate screen.
	#alt = false;
	/** The alternate screen shows a fullscreen frame (otherwise a resize borrow). */
	#fullscreen = false;
	/** Rows on the alternate screen, null to repaint all. */
	#altShown: string[] | null = null;
	/** Deletes for direct Kitty bands on alt. Resizing invalidates row diffs but need not discard placements. */
	#altPlacements?: Set<string>;
	#altAnchors = false;

	/** The next inline frame clears screen and scrollback first (display reset, rebuild). */
	#pendingClear = false;
	/**
	 * Rows of ours are on the normal screen (an inline frame was written since start). A session
	 * drawing only fullscreen frames has none: resizes and display resets have nothing to rebuild there.
	 */
	#inlineWritten = false;
	/** The next replay batch appends below retained history instead of replacing it. */
	#replayAppends = false;
	/** The normal screen reflowed under the writer: recover the anchor before painting it. */
	#stale = false;
	#anchoring = false;
	/** The running anchor recovery, if any. */
	#recovery: Promise<void> = Promise.resolve();
	#resize: Transaction | undefined;
	/** The last settled resize (a Warp echo re-runs its anchor recovery). */
	#lastResize: Transaction | undefined;
	#expectEcho = false;
	/** Bumped by stop/start: async anchor probes from an older epoch are ignored. */
	#epoch = 0;
	/** The last history id written: a batch offered again is acknowledged, not rewritten. */
	#written = 0;
	/**
	 * The last frame offered while the normal screen could not take it (a
	 * resize borrow or settle, an anchor probe): {@link stop} writes it inline,
	 * so a graceful stop mid-resize still leaves its history and viewport.
	 */
	#deferred: FramePlan | undefined;
	/** Viewport rows a height shrink pushed into scrollback, oldest first (see `#pushedBy`). */
	#pushed: string[] = [];
	/** Where the cursor report after that shrink must find the cursor for `#pushed` to hold; undefined once checked. */
	#pushedCursor: number | undefined;

	constructor(options: FrameWriterOptions) {
		this.#options = options;
		this.#sink = options.sink;
		this.#columns = Math.max(1, options.columns);
		this.#rows = Math.max(1, options.rows);
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	/** Map a pointer report into the frame actually on screen, never guessing an unknown inline anchor. */
	viewportRow(screenRow: number): number | null {
		if (!this.#started || screenRow < 0 || screenRow >= this.#rows) return null;
		if (this.#alt) return this.#fullscreen && this.#altShown ? screenRow : null;
		if (this.#stale || this.#anchoring || this.#deferred || !this.#topKnown()) return null;
		const row = screenRow - this.#topLo;
		return row >= 0 && row < this.#shown.length ? row + this.#clipped : null;
	}

	/** Resolves once the last anchor recovery (cursor position report after a resize) finished. */
	whenAnchored(): Promise<void> {
		return this.#recovery;
	}

	/** Whether the alternate screen is active (fullscreen frame or resize borrow). */
	get alternateScreen(): boolean {
		return this.#alt;
	}

	/**
	 * Start writing below the cursor. `cursor` is its 0-based position when
	 * known (CPR at startup); otherwise the viewport top stays unknown until
	 * content fills the screen.
	 */
	start(cursor?: { readonly row: number; readonly col: number } | null, deferShellLine = false): void {
		this.#epoch++;
		this.#started = true;
		this.#shown = [];
		this.#cursorRow = 0;
		this.#cursorCol = 0;
		this.#extent = 1;
		this.#visible = undefined;
		this.#alt = false;
		this.#fullscreen = false;
		this.#altShown = null;
		this.#stale = false;
		this.#anchoring = false;
		this.#pendingClear = false;
		this.#inlineWritten = false;
		this.#replayAppends = false;
		this.#deferred = undefined;
		this.#pushed = [];
		this.#pushedCursor = undefined;
		this.#partialShellLine = deferShellLine && (!cursor || cursor.col > 0);
		if (cursor) {
			let row = Math.min(Math.max(0, cursor.row), this.#rows - 1);
			if (cursor.col > 0 && !this.#partialShellLine) {
				// Leave a partial line the shell left behind.
				this.#send("\r\n");
				row = Math.min(row + 1, this.#rows - 1);
			}
			this.#topLo = this.#topHi = row;
		} else {
			this.#topLo = 0;
			this.#topHi = this.#rows - 1;
		}
	}

	/**
	 * Show `frame`. Returns the id of the history batch it wrote: history is
	 * only written inline on the normal screen, never during a resize borrow
	 * or under a fullscreen frame (the batch stays pending and is offered again).
	 */
	present(frame: FramePlan): number | undefined {
		if (!this.#started) return undefined;
		if (frame.fullscreen) {
			this.#deferred = undefined;
			if (!this.#anchoring) this.#paintAlternate(frame.fullscreen, frame.cursor, "", true);
			return undefined;
		}
		this.#deferred = frame;
		if (this.#anchoring || this.#resize?.quiet) return undefined;
		let prefix = "";
		if (this.#alt) {
			if (this.#resize && !this.#pendingClear) {
				// Resize borrow: the viewport tail on the alternate screen.
				this.#paintBorrowed(frame);
				return undefined;
			}
			prefix = this.#leaveAlt();
			if (this.#stale && !this.#pendingClear) {
				this.#send(prefix);
				this.#recovery = this.#recover();
				return undefined;
			}
		} else if (this.#resize) {
			// First frame of a resize burst: blank the live viewport, then borrow.
			const erase = this.#options.multiplexer() ? "" : this.#preErase();
			this.#paintBorrowed(frame, `${erase}${this.#enterAlt()}`);
			return undefined;
		}
		this.#deferred = undefined;
		return this.#paintInline(frame, prefix);
	}

	/**
	 * Keep `frame` for {@link stop} without writing it now (the driver skips
	 * frames while the terminal does not drain): the last one is written when
	 * the writer stops, so a shutdown flush is not lost.
	 */
	hold(frame: FramePlan): void {
		if (this.#started) this.#deferred = frame.fullscreen ? undefined : frame;
	}

	/** Whether a settled width change replays history (the policy rebuilds or appends it, not in place). */
	replaysOnWidthChange(): boolean {
		if (this.#options.inPlaceResize?.() || !(this.#options.canReplay?.() ?? false)) return false;
		return (this.#options.hostOwnsGrid?.() ?? false) || (this.#options.resizeScrollback ?? "preserve") !== "preserve";
	}

	/** Write bytes that bypass frame diffing (protocol messages). */
	writeRaw(data: string): void {
		if (data) this.#send(data);
	}

	/**
	 * Clear terminal history and the screen. The clear is fused with the next
	 * inline frame (which should carry the replay) so no blank screen shows.
	 */
	resetDisplay(): void {
		if (this.#alt) this.#altShown = null;
		if (this.#alt && this.#fullscreen && !this.#inlineWritten) {
			// Only fullscreen frames so far: the normal screen holds nothing of ours to clear or replay.
			this.#options.onInvalidate?.("repaint");
			return;
		}
		this.#pendingClear = true;
		this.#replayAppends = false;
		this.#stale = false;
		this.#options.onInvalidate?.("replay");
	}

	/** The terminal's size changed (raw, unsettled; called once per change). */
	resize(columns: number, rows: number): void {
		columns = Math.max(1, columns);
		rows = Math.max(1, rows);
		if (columns === this.#columns && rows === this.#rows) return;
		const before = { columns: this.#columns, rows: this.#rows };
		this.#columns = columns;
		this.#rows = rows;
		if (!this.#started) return;
		if (this.#alt) this.#altShown = null;
		if (this.#expectEcho && !this.#resize && columns === before.columns && Math.abs(rows - before.rows) === 1) {
			// Warp's echo of our own alternate-screen toggle: nothing reflowed.
			this.#expectEcho = false;
			if (this.#anchoring && !this.#alt) {
				// The terminal adopted the echoed size, so a cursor report already in flight may
				// predate it: retire that probe and ask again at the new size (no toggle: terminates).
				this.#epoch++;
				this.#recovery = this.#recover(this.#lastResize, true);
				return;
			}
			this.#options.onInvalidate?.("repaint");
			return;
		}
		this.#expectEcho = false;
		if (!this.#resize) {
			const inPlace = this.#options.inPlaceResize?.() ?? false;
			this.#resize = {
				columns: before.columns,
				rows: before.rows,
				shrank: false,
				grew: false,
				inPlace,
				quiet: inPlace || (!this.#alt && (this.#options.resizeAvoidsAlternate?.() ?? false)),
				full: this.#topKnown() && this.#shown.length > 0 && this.#topLo + this.#shown.length >= before.rows,
				cancel: undefined,
			};
		}
		const tx = this.#resize;
		// Rows pushed by an earlier step of this burst are not checked yet: another step makes them a guess.
		if (this.#pushedCursor !== undefined) this.#dropPushed();
		else if (rows < before.rows && columns === before.columns && !this.#alt) this.#pushedBy(before.rows - rows);
		if (rows < before.rows) tx.shrank = true;
		if (rows > before.rows) tx.grew = true;
		if (!this.#pendingClear) this.#stale = true;
		if (tx.inPlace && !this.#alt && !this.#options.multiplexer()) {
			const erase = this.#preErase();
			if (erase) this.#send(erase);
		}
		tx.cancel?.();
		tx.cancel = (this.#options.schedule ?? schedule)(() => this.#settle(), this.#options.settleMs ?? 100);
	}

	/**
	 * A height shrink of `by` rows on the normal screen: the terminal drops blank rows below the
	 * cursor, then pushes the top rows into scrollback. Viewport rows it pushes are remembered
	 * (`#pushed`): when the next history batch starts with them they are already there and are
	 * not written again.
	 */
	#pushedBy(by: number): void {
		if (!this.#topKnown() || this.#shown.length === 0 || this.#pendingClear || this.#options.multiplexer()) return;
		let blank = Math.max(0, this.#rows + by - (this.#topLo + this.#shown.length));
		for (let row = this.#shown.length - 1; row > this.#cursorRow && this.#shown[row] === ""; row--) blank++;
		const pushed = Math.max(0, by - blank);
		const rows = Math.min(Math.max(0, pushed - this.#topLo), this.#cursorRow);
		const cursor = this.#topLo + this.#cursorRow - pushed;
		if (rows > 0) {
			this.#pushed.push(...this.#shown.slice(0, rows));
			this.#shown = this.#shown.slice(rows);
			if (this.#shownGraphics) this.#shownGraphics = this.#shown.some(hasGraphics);
			this.#cursorRow -= rows;
			// The anchor's cursor report confirms the model: a terminal that pushed fewer rows (or dropped
			// rows below the cursor instead) leaves the cursor elsewhere, and nothing is skipped then.
			this.#pushedCursor = cursor;
		}
		this.#topLo = this.#topHi = Math.max(0, this.#topLo - pushed);
	}

	#dropPushed(): void {
		this.#pushed = [];
		this.#pushedCursor = undefined;
	}

	/**
	 * Hand the terminal back: leave the alternate screen, write the last frame
	 * a resize or an anchor probe held back (inline, from where the viewport
	 * starts), put the cursor on the line after the visible content, restore
	 * autowrap and the cursor. The caller restores input modes and flushes the
	 * sink.
	 */
	stop(emergency = false): void {
		if (!this.#started) return;
		this.#epoch++;
		this.#started = false;
		this.#anchoring = false;
		this.#resize?.cancel?.();
		this.#resize = undefined;
		// Do not take a cached transcript flush through the renderer when urgently handing back alt.
		const deferred = emergency && this.#alt ? undefined : this.#deferred;
		this.#deferred = undefined;
		if (deferred) {
			// The cursor is where the viewport starts (an alternate-screen exit restores it there); a viewport
			// still on screen is blanked first, so the frame streams down from its top.
			let prefix = this.#alt ? this.#leaveAlt() : "";
			if (this.#stale) prefix += this.#preErase();
			this.#stale = false;
			this.#paintInline(deferred, prefix);
		}
		let out = "";
		if (this.#alt) out += this.#leaveAlt();
		if (this.#partialShellLine) {
			// Nothing took the normal-screen cursor. Even CR would move the next shell output.
			this.#send(`${out}${AUTOWRAP_ON}${CURSOR_SHOW}`);
			return;
		}
		const content = this.#shown.findLastIndex(row => row !== "");
		if (this.#stale) {
			// Mid-resize: the cursor sits where the reflow left it.
			out += this.#shown.length > 0 ? `${down(this.#reflowed().below)}\r\n` : "\r";
		} else if (content >= 0) {
			const pen = new Pen(this.#cursorRow, this.#existing());
			pen.goto(content);
			out += `${pen.out}\r\n`;
		} else {
			const pen = new Pen(this.#cursorRow, this.#existing());
			pen.goto(0);
			out += `${pen.out}\r`;
		}
		out += `${AUTOWRAP_ON}${CURSOR_SHOW}`;
		this.#visible = true;
		this.#send(out);
	}

	/** Write to the sink; a failed write stops the writer for good (fail-stop: no retry, no acknowledgement). */
	#send(data: string): void {
		try {
			this.#sink.write(data);
		} catch (error) {
			this.#epoch++;
			this.#started = false;
			this.#anchoring = false;
			this.#deferred = undefined;
			this.#resize?.cancel?.();
			this.#resize = undefined;
			throw error;
		}
	}

	// ── inline ────────────────────────────────────────────────────────────

	#topKnown(): boolean {
		return this.#topLo === this.#topHi;
	}

	/** Rows from the viewport top known to exist on screen. */
	#existing(): number {
		return this.#topKnown() ? this.#rows - this.#topLo : this.#extent;
	}

	/** `rows` normalized at `width`, reusing the previous frame's results: most rows repeat frame to frame. */
	#normalizeViewport(rows: readonly string[], width: number, first: number): string[] {
		const previous = width === this.#normalizedWidth ? this.#normalized : undefined;
		const next = new Map<string, { text: string; graphics: boolean }>();
		const out: string[] = [];
		let graphics = false;
		for (let i = first; i < rows.length; i++) {
			const row = rows[i]!;
			let entry = next.get(row) ?? previous?.get(row);
			if (!entry) {
				const text = normalizeRow(row, width);
				entry = { text, graphics: hasGraphics(text) };
			}
			next.set(row, entry);
			out.push(entry.text);
			graphics ||= entry.graphics;
		}
		this.#normalized = next;
		this.#normalizedWidth = width;
		this.#shownGraphics = graphics;
		return out;
	}

	#paintInline(frame: FramePlan, prefix: string): number | undefined {
		const width = this.#columns;
		const height = this.#rows;
		let body = "";
		const offered = frame.history;
		const history = offered && offered.id > this.#written ? offered : undefined;
		if (history?.kind === "replay") {
			if (this.#replayAppends) this.#replayAppends = false;
			else this.#pendingClear = true;
		}
		let lead = prefix;
		if (this.#pendingClear) {
			// Switch buffers and erase before uploading pictures to the destination buffer.
			lead += CLEAR_ALL;
			this.#options.images?.cleared?.();
			this.#pendingClear = false;
			this.#shown = [];
			this.#cursorRow = 0;
			this.#topLo = this.#topHi = 0;
			this.#extent = height;
		} else if (this.#partialShellLine) {
			lead += "\r\n";
			this.#topLo = Math.min(this.#topLo + 1, height - 1);
			this.#topHi = Math.min(this.#topHi + 1, height - 1);
		}
		this.#partialShellLine = false;
		const previousGraphics = this.#shown.length > 0 && this.#shownGraphics;
		this.#clipped = Math.max(0, frame.viewport.length - height);
		let viewport = this.#normalizeViewport(frame.viewport, width, this.#clipped);
		let cursor = frame.cursor;
		if (this.#clipped > 0) {
			cursor = cursor && cursor.row >= this.#clipped ? { row: cursor.row - this.#clipped, col: cursor.col } : null;
		}
		let past = history ? history.rows.map(row => normalizeRow(row, width)) : [];
		let skipped = 0;
		if (this.#pushed.length > 0 && (this.#pendingClear || history?.kind === "replay")) this.#pushed = [];
		if (this.#pushed.length > 0 && past.length > 0) {
			// Rows a height shrink already pushed into scrollback are not written twice.
			let same = 0;
			while (same < past.length && same < this.#pushed.length && past[same] === this.#pushed[same]) same++;
			this.#pushed = same === past.length ? this.#pushed.slice(same) : [];
			skipped = same;
			past = past.slice(skipped);
		}
		// Compare plain rows before adding one-shot control sequences: a resize
		// can already have scrolled some of these rows beyond the writer's reach.
		if (history?.marks) {
			for (const { row, before, after } of history.marks) {
				const index = row - skipped;
				const text = past[index];
				if (text !== undefined) past[index] = before + text + after;
			}
		}
		// History under an empty viewport ends with the row the cursor parks on, made by a line feed like
		// every row past the bottom: the next frame (or the shell) writes there, never over history.
		if (past.length > 0 && viewport.length === 0) viewport = [""];
		const stream = past.length > 0 ? [...past, ...viewport] : viewport;
		if (stream.length > 0) this.#inlineWritten = true;
		const shift =
			!this.#options.synchronizedOutput() &&
			this.#topKnown() &&
			!previousGraphics &&
			!this.#shownGraphics &&
			!past.some(hasGraphics);
		const pen = shift ? this.#shifted(stream, past.length, viewport.length) : this.#rewritten(stream);
		body += pen.out;
		const written = pen.out !== "" || past.length > 0;

		// Anchor below the new history (the cursor's row exists even for an empty viewport).
		const h = past.length;
		const n = viewport.length;
		this.#topLo = Math.min(this.#topLo + h, height - Math.max(1, n));
		this.#topHi = Math.min(this.#topHi + h, height - Math.max(1, n));
		this.#shown = viewport;
		pen.row -= h;
		pen.limit = this.#topKnown() ? this.#existing() : pen.limit - h;

		const show = cursor !== null && n > 0;
		const target = show
			? { row: Math.min(Math.max(0, cursor!.row), n - 1), col: cursor!.col }
			: { row: Math.max(0, n - 1), col: 0 };
		const col = Math.min(Math.max(0, target.col), width - 1);
		const before = pen.out.length;
		pen.goto(target.row);
		let park = pen.out.slice(before);
		if (written || park !== "" || this.#cursorCol !== col) park += column(col);
		this.#cursorRow = target.row;
		this.#cursorCol = col;
		this.#extent = Math.max(1, pen.limit);
		this.#write(body, park, show, lead);
		// Acknowledged only once the sink took the bytes (a failed write threw above).
		if (history) this.#written = history.id;
		return offered?.id;
	}

	/** Write the changed rows of `stream` from the viewport top down (history first). */
	#rewritten(stream: readonly string[]): Pen {
		const pen = new Pen(this.#cursorRow, this.#existing());
		const shown = this.#shown;
		for (let k = 0; k < stream.length; k++) {
			if (k < shown.length && k < pen.limit && shown[k] === stream[k]) continue;
			pen.goto(k);
			pen.out += drawRow(stream[k]!, this.#columns, coveredCells(stream, k));
		}
		if (shown.length > stream.length) {
			pen.goto(stream.length);
			pen.out += this.#eraseBelow(shown.length - stream.length);
		}
		return pen;
	}

	/**
	 * The unsynchronized path with a known top: rows that will scroll into
	 * history show their history line first, line feeds on the bottom row
	 * push them out, then surviving rows shift into place and only rows
	 * that still differ are rewritten. Returns a pen in viewport-top rows.
	 */
	#shifted(stream: readonly string[], h: number, n: number): Pen {
		const height = this.#rows;
		const top = this.#topLo;
		const existing = height - top;
		const current = Array.from({ length: existing }, (_, row) => this.#shown[row] ?? "");
		const pen = new Pen(this.#cursorRow, existing);
		const scroll = Math.max(0, top + h + n - height);
		const pushed = Math.max(0, scroll - top);
		// Rows past the screen bottom are reached with line feeds there, which scroll.
		for (let row = 0; row < pushed; row++) {
			if (current[row] === stream[row]) continue;
			pen.goto(row);
			pen.out += drawRow(stream[row]!, this.#columns);
		}
		// Line feeds on the bottom row push the rest out (pen rows are content rows: the bottom is existing - 1 + scroll).
		if (scroll > 0) pen.goto(existing - 1 + scroll);
		// The region: from the first screen row holding stream content to the bottom.
		const regionTop = Math.max(0, top - scroll);
		const regionHeight = height - regionTop;
		// Region row r shows content row r + pushed: an old row still on screen, or a blank a line feed brought.
		const before = Array.from({ length: regionHeight }, (_, row) => current[row + pushed] ?? "");
		const after = Array.from({ length: regionHeight }, (_, row) => stream[row + pushed] ?? "");
		// Region row r is content row r + pushed.
		for (const step of planShift(before, after, regionTop === 0)) {
			pen.goto(step.row + pushed);
			if (step.kind === "delete") pen.out += deleteLines(step.count);
			else if (step.kind === "insert") pen.out += insertLines(step.count);
			else pen.out += drawRow(step.kind === "clear" ? "" : after[step.row]!, this.#columns);
		}
		return pen;
	}

	/** Erase `count` rows from the cursor row down, never starting a screen-wide clear on the first cell. */
	#eraseBelow(count: number): string {
		if (this.#columns > 1) return `\r${right(1)}${ERASE_DOWN}\r${ERASE_LINE_LEFT}`;
		let out = "";
		for (let row = 0; row < count; row++) out += `${row > 0 ? down(1) : ""}${ERASE_LINE}`;
		return `${out}${up(count - 1)}`;
	}

	// ── alternate screen ──────────────────────────────────────────────────

	#enterAlt(): string {
		this.#options.images?.enteredAlternate?.();
		this.#altPlacements = undefined;
		this.#alt = true;
		this.#altShown = null;
		this.#visible = undefined;
		this.#expectEcho = this.#echoes();
		return `${ALT_ENTER}${this.#options.keyboardScreenModes?.().enterAlt ?? ""}`;
	}

	#leaveAlt(): string {
		const modes = this.#options.keyboardScreenModes?.();
		this.#alt = false;
		this.#fullscreen = false;
		this.#altShown = null;
		this.#visible = undefined;
		this.#altPlacements = undefined;
		this.#expectEcho = this.#echoes();
		return `${modes?.leaveAltBefore ?? ""}${ALT_LEAVE}${modes?.leaveAltAfter ?? ""}`;
	}

	/** Warp re-reports its size on alternate-screen toggles (a multiplexer absorbs them). */
	#echoes(): boolean {
		return (this.#options.warp?.() ?? false) && !this.#options.multiplexer();
	}

	#paintAlternate(rows: readonly string[], cursor: FramePlan["cursor"], prefix: string, fullscreen: boolean): void {
		let lead = this.#alt ? prefix : prefix + this.#enterAlt();
		let body = "";
		this.#fullscreen = fullscreen;
		const height = this.#rows;
		const width = this.#columns;
		const shown = this.#altShown ?? [];
		const next: string[] = [];
		let placements: Set<string> | undefined;
		let anchors = false;
		for (let row = 0; row < height; row++) {
			const text = normalizeRow(rows[row] ?? "", width);
			anchors ||= text.includes("\x1b7\x1b[");
			const placement = alternatePlacement(text, row);
			next.push(placement?.row ?? text);
			if (placement) (placements ??= new Set()).add(placement.deletion);
		}
		if (this.#altPlacements) {
			for (const deletion of this.#altPlacements) if (!placements?.has(deletion)) lead += deletion;
		}
		this.#altPlacements = placements;
		const damaged = this.#altShown && (anchors || this.#altAnchors) ? rasterDamage(shown, next) : undefined;
		this.#altAnchors = anchors;
		for (let row = 0; row < height; row++) {
			const text = next[row]!;
			if (this.#altShown && shown[row] === text && !damaged?.[row]) continue;
			body += `${position(row, 0)}${drawRow(text, width, coveredCells(next, row))}`;
		}
		this.#altShown = next;
		const show = cursor !== null && cursor.row >= 0 && cursor.row < height;
		const park = show ? position(cursor.row, Math.min(cursor.col, width - 1)) : body ? position(height - 1, 0) : "";
		this.#write(body, park, show, lead);
	}

	/** The viewport tail, bottom-anchored on the borrowed alternate screen. */
	#paintBorrowed(frame: FramePlan, prefix = ""): void {
		const height = this.#rows;
		const tail = frame.viewport.slice(-height);
		const pad = height - tail.length;
		const cut = frame.viewport.length - tail.length;
		const rows = [...Array.from({ length: pad }, () => ""), ...tail];
		const cursor =
			frame.cursor && frame.cursor.row >= cut ? { row: frame.cursor.row - cut + pad, col: frame.cursor.col } : null;
		this.#paintAlternate(rows, cursor, prefix, false);
	}

	// ── resize ────────────────────────────────────────────────────────────

	/** Rows the shown viewport takes after reflowing at the current width, split at the cursor. */
	#reflowed(): { above: number; below: number; total: number } {
		const columns = this.#columns;
		let above = 0;
		let total = 0;
		for (let row = 0; row < this.#shown.length; row++) {
			const rows = reflowHeight(this.#shown[row]!, columns);
			if (row < this.#cursorRow) above += rows;
			total += rows;
		}
		above += Math.floor(Math.max(0, this.#cursorCol) / columns);
		return { above, below: Math.max(0, total - above - 1), total };
	}

	/**
	 * Blank the live viewport where the reflowed screen now holds it, leaving
	 * the cursor on its top row, so a shrink can only push history or blanks.
	 */
	#preErase(): string {
		if (this.#shown.length === 0) return "";
		const { above, total } = this.#reflowed();
		const out = `${AUTOWRAP_OFF}${up(above)}${this.#eraseBelow(total)}${AUTOWRAP_ON}`;
		if (this.#pushedCursor !== undefined) {
			// The cursor moves up to the viewport top; at the screen's top row the move would be clipped.
			this.#pushedCursor -= above;
			if (this.#pushedCursor < 0) this.#dropPushed();
		}
		this.#shown = [];
		this.#cursorRow = 0;
		this.#cursorCol = 0;
		this.#extent = 1;
		this.#topLo = 0;
		this.#topHi = this.#rows - 1;
		return out;
	}

	#settle(): void {
		const tx = this.#resize;
		if (!tx || !this.#started) return;
		this.#resize = undefined;
		this.#lastResize = tx;
		const widthChanged = tx.columns !== this.#columns;
		const ownsGrid = this.#options.hostOwnsGrid?.() ?? false;
		const canReplay = this.#options.canReplay?.() ?? false;
		const mode = this.#options.resizeScrollback ?? "preserve";
		if (this.#alt && this.#fullscreen && !this.#inlineWritten) {
			// Only fullscreen frames so far: nothing of ours on the normal screen to rebuild or re-anchor.
			// The first inline frame (the shutdown flush) starts wherever the cursor is.
			this.#stale = false;
			this.#topLo = 0;
			this.#topHi = this.#rows - 1;
			this.#options.onInvalidate?.("repaint");
			return;
		}
		let replay: "rebuild" | "append" | null = null;
		if (!tx.inPlace && canReplay) {
			if (ownsGrid) replay = "rebuild";
			else if (mode === "rebuild" && (widthChanged || (tx.shrank && this.#options.multiplexer())))
				replay = "rebuild";
			else if (mode === "append" && widthChanged) replay = "append";
		}
		if (replay === "rebuild" || (ownsGrid && !tx.inPlace)) {
			// Fused with the next inline frame: leave the borrow, clear, replay.
			this.#pendingClear = true;
			this.#replayAppends = false;
			this.#stale = false;
			this.#options.onInvalidate?.(replay ? "replay" : "repaint");
			return;
		}
		this.#replayAppends = replay === "append";
		if (this.#alt && this.#fullscreen) {
			// The overlay keeps the alternate screen; the anchor is recovered when it closes.
			this.#options.onInvalidate?.("repaint");
			return;
		}
		if (this.#alt) this.#send(this.#leaveAlt());
		this.#recovery = this.#recover(tx);
	}

	/**
	 * Find the viewport top again after the normal screen reflowed (CPR), then
	 * ask for a frame. `fresh`: a report already in flight predates the
	 * geometry, so it is awaited and discarded before asking again.
	 */
	async #recover(tx?: Transaction, fresh = false): Promise<void> {
		const epoch = this.#epoch;
		this.#anchoring = true;
		const query = async (): Promise<{ readonly row: number; readonly col: number } | null> => {
			if (!this.#options.queryCursor) return null;
			try {
				return await this.#options.queryCursor();
			} catch (error) {
				logger.warn("pi-tui: cursor position probe failed", { error: String(error) });
				return null;
			}
		};
		if (fresh) await query();
		if (epoch !== this.#epoch || !this.#started) return;
		let reply = await query();
		// A multiplexer under load, or a terminal still growing, may miss the window once.
		if (!reply && this.#options.queryCursor && (this.#options.multiplexer() || tx?.grew)) {
			if (epoch !== this.#epoch || !this.#started) return;
			reply = await query();
		}
		if (epoch !== this.#epoch || !this.#started) return;
		this.#anchoring = false;
		const height = this.#rows;
		const { above, total } = this.#reflowed();
		if (this.#pushedCursor !== undefined) {
			if (!reply || reply.row !== this.#pushedCursor) this.#dropPushed();
			this.#pushedCursor = undefined;
		}
		if (reply) {
			const row = Math.min(Math.max(0, reply.row), height - 1);
			const top = this.#options.multiplexer()
				? Math.max(0, row - above)
				: Math.max(0, Math.min(row - above, height - total));
			this.#cursorRow = row - top;
			this.#topLo = this.#topHi = top;
		} else {
			this.#cursorRow = Math.min(above, height - 1);
			this.#topLo = 0;
			this.#topHi = height - 1 - this.#cursorRow;
		}
		this.#cursorCol = -1;
		// What remains of the old viewport is unknown text: the next frame rewrites or erases it.
		const stale = Math.min(total, this.#topKnown() ? height - this.#topLo : total);
		this.#shown = Array.from({ length: stale }, () => UNKNOWN_ROW);
		this.#shownGraphics = false;
		this.#extent = Math.max(stale, this.#cursorRow + 1);
		this.#stale = false;
		if (
			reply &&
			tx?.grew &&
			tx.full &&
			this.#topLo + stale < height &&
			(this.#options.resizeScrollback ?? "preserve") === "rebuild" &&
			(this.#options.canReplay?.() ?? false) &&
			(this.#options.growsBeforeResize?.() ?? false)
		) {
			// The host grew before we heard of it and a frame may have landed at the old
			// coordinates: replay instead of trusting the pulled-down copy.
			this.#pendingClear = true;
			this.#replayAppends = false;
			this.#options.onInvalidate?.("replay");
			return;
		}
		const replay = this.#replayAppends;
		this.#options.onInvalidate?.(replay ? "replay" : "repaint");
	}

	// ── output ────────────────────────────────────────────────────────────

	/**
	 * One frame write: `lead` (a screen switch and erase), images, rows with
	 * autowrap off, cursor parked and shown/hidden inside the update.
	 */
	#write(body: string, park: string, show: boolean, lead = ""): void {
		const images = this.#options.images?.takeSequences(this.#alt ? "alternate" : "main") ?? "";
		const visibility = show === this.#visible ? "" : show ? CURSOR_SHOW : CURSOR_HIDE;
		if (!lead && !images && !body && !park && !visibility) return;
		const sync = this.#options.synchronizedOutput();
		let out = sync ? SYNC_BEGIN : "";
		const hide = !sync && (body !== "" || lead !== "") && this.#visible !== false;
		if (hide) out += CURSOR_HIDE;
		out += lead;
		out += images;
		if (body) {
			out += `${AUTOWRAP_OFF}${sync && this.#options.renewsSynchronizedOutput?.() ? renewSync(body) : body}${AUTOWRAP_ON}`;
		}
		out += park;
		out += hide ? (show ? CURSOR_SHOW : "") : visibility;
		if (sync) out += SYNC_END;
		this.#visible = show;
		this.#send(out);
	}
}

/** `body` with `CSI ? 2026 h` re-sent before the first row start past every {@link SYNC_RENEW_BYTES}. */
function renewSync(body: string): string {
	if (body.length <= SYNC_RENEW_BYTES) return body;
	let out = "";
	let from = 0;
	while (body.length - from > SYNC_RENEW_BYTES) {
		const at = body.indexOf("\r", from + SYNC_RENEW_BYTES);
		if (at < 0) break;
		out += body.slice(from, at) + SYNC_BEGIN;
		from = at;
	}
	return out + body.slice(from);
}
