/**
 * TUI paint → stream screen frames.
 *
 * Both consumers of a session's screen — the live `omp stream` publisher and
 * the `/record` recorder — observe `TuiPaint`s and need the same thing out of
 * them: rows reduced to the stream-safe ANSI subset, secrets redacted, and the
 * viewport expressed as full snapshots or row patches against what the
 * consumer last emitted. {@link StreamPaintEncoder} owns that pipeline;
 * callers only decide when to drain it and where the frames go.
 */
import { STREAM_HISTORY_LIMIT, type StreamRow } from "@oh-my-pi/pi-wire";
import type { TuiPaint } from "@oh-my-pi/pi-tui";
import type { StreamScreenFrame } from "./protocol";
import type { StreamRedactor } from "./redactor";

const IMAGE_PLACEHOLDER = "\u{10eeee}";

/** Paint coalescing window between encoder drains; bounds frame rate for live viewers and recordings alike. */
export const STREAM_FLUSH_INTERVAL_MS = 50;

/**
 * Convert one prepared terminal row into the stream-safe ANSI subset. Only SGR
 * and OSC 8 survive. Graphics placements become a visible text marker; OSC 66
 * contributes its visible payload without its terminal-specific scaling.
 */
export function normalizeStreamRow(row: string): string {
	if (row.includes(IMAGE_PLACEHOLDER)) return "[image]";
	// Kept text is appended a run at a time: `runStart` opens the current run
	// of printable code units, flushed whenever a dropped unit or escape ends it.
	let output = "";
	let runStart = 0;
	let image = false;
	for (let index = 0; index < row.length;) {
		const code = row.charCodeAt(index);
		if (code !== 0x1b) {
			if (!((code >= 0x20 && (code < 0x7f || code > 0x9f)) || code === 0x09)) {
				if (runStart < index) output += row.slice(runStart, index);
				runStart = index + 1;
			}
			index++;
			continue;
		}
		if (runStart < index) output += row.slice(runStart, index);
		const kind = row[index + 1];
		if (kind === "[") {
			let end = index + 2;
			while (end < row.length && (row.charCodeAt(end) < 0x40 || row.charCodeAt(end) > 0x7e)) end++;
			if (end >= row.length) {
				runStart = row.length;
				break;
			}
			if (row[end] === "m") output += row.slice(index, end + 1);
			index = runStart = end + 1;
			continue;
		}
		if (kind === "]" || kind === "_" || kind === "P") {
			let end = index + 2;
			const tmuxDcs = kind === "P" && row.startsWith("tmux;", end);
			while (end < row.length) {
				const bell = row.charCodeAt(end) === 0x07;
				const escapedTmuxEsc = tmuxDcs && end > index + 2 && row[end - 1] === "\x1b";
				const st = row[end] === "\x1b" && row[end + 1] === "\\" && !escapedTmuxEsc;
				if (bell || st) break;
				end++;
			}
			const terminatedBySt = row[end] === "\x1b";
			const sequenceEnd = Math.min(row.length, end + (terminatedBySt ? 2 : 1));
			const payload = row.slice(index + 2, end);
			if (kind === "]" && payload.startsWith("8;")) {
				output += row.slice(index, sequenceEnd);
			} else if (kind === "]" && payload.startsWith("66;")) {
				const separator = payload.indexOf(";", 3);
				if (separator >= 0) output += payload.slice(separator + 1);
			} else if (kind === "]" && /(?:^|;)File=/.test(payload)) {
				image = true;
			} else if (kind === "_") {
				const graphics = payload.startsWith("G") ? payload.slice(1) : "";
				if (/(?:^|,)a=[pT](?:,|$)/.test(graphics) || /(?:^|,)U=1(?:,|$)/.test(graphics)) {
					image = true;
				}
			} else if (kind === "P" && /^[0-9;]*q/.test(payload)) {
				image = true;
			} else if (kind === "P" && payload.startsWith("tmux;")) {
				const nested = normalizeStreamRow(payload.slice(5).replaceAll("\x1b\x1b", "\x1b"));
				if (nested === "[image]") image = true;
				else output += nested;
			}
			index = runStart = sequenceEnd;
			continue;
		}
		// ESC controls are paint mechanics rather than row content. Consume any
		// intermediate bytes as well as the final byte (for example ESC ( 0).
		let end = index + 1;
		while (end < row.length && row.charCodeAt(end) >= 0x20 && row.charCodeAt(end) <= 0x2f) end++;
		index = runStart = Math.min(row.length, end + 1);
	}
	if (image) return "[image]";
	if (runStart === 0) return row;
	if (runStart < row.length) output += row.slice(runStart);
	return output;
}

/**
 * Accumulates paints between drains and encodes them as ordered screen frames:
 * `reset`, `history`, `resize`, then one `viewport` snapshot or `patch`
 * against the last viewport this encoder emitted.
 */
export class StreamPaintEncoder {
	#redactor: StreamRedactor;
	/** Raw rows of the latest paint; normalized and redacted only when drained. */
	#pendingRawViewport: readonly string[] | undefined;
	/** Already-encoded viewport awaiting (re)send; set only by {@link resync}. */
	#pendingViewport: StreamRow[] | undefined;
	/** Raw history rows; normalized and redacted only when drained. */
	#pendingHistory: string[] = [];
	#pendingHistorySkipped = 0;
	#pendingReset = false;
	#pendingForceFull = false;
	#pendingColumns: number;
	#pendingRows: number;
	#lastColumns: number;
	#lastRows: number;
	#lastViewport: StreamRow[] | undefined;
	#lastAlt: boolean | undefined;
	#pendingAlt = false;
	/** Raw → normalized+redacted rows of the last drained viewport; most rows repeat frame to frame. */
	#rowCache = new Map<string, StreamRow>();

	/** `size` is the terminal geometry the consumer already announced (e.g. in `hello`). */
	constructor(size: { columns: number; rows: number }, redactor: StreamRedactor) {
		this.#redactor = redactor;
		this.#pendingColumns = this.#lastColumns = size.columns;
		this.#pendingRows = this.#lastRows = size.rows;
	}

	/** True when a drain would emit at least one frame. */
	get pending(): boolean {
		return (
			this.#pendingReset ||
			this.#pendingHistory.length > 0 ||
			this.#pendingHistorySkipped > 0 ||
			this.#pendingRawViewport !== undefined ||
			this.#pendingViewport !== undefined
		);
	}

	push(paint: TuiPaint): void {
		if (paint.reset) {
			this.#pendingReset = true;
			this.#pendingForceFull = true;
			this.#pendingHistory = [];
			this.#pendingHistorySkipped = 0;
		}
		if (paint.history.length > 0) {
			for (const row of paint.history) this.#pendingHistory.push(row);
			const capacity = this.#pendingHistorySkipped > 0 ? STREAM_HISTORY_LIMIT - 1 : STREAM_HISTORY_LIMIT;
			if (this.#pendingHistory.length > capacity) {
				const excess = this.#pendingHistory.length - (STREAM_HISTORY_LIMIT - 1);
				this.#pendingHistorySkipped += excess;
				this.#pendingHistory.splice(0, excess);
			}
		}
		if (paint.columns !== this.#pendingColumns || paint.rows !== this.#pendingRows) this.#pendingForceFull = true;
		if (this.#lastAlt !== undefined && paint.alt !== this.#lastAlt) this.#pendingForceFull = true;
		if (paint.alt) this.#pendingForceFull = true;
		this.#lastAlt = paint.alt;
		this.#pendingAlt = paint.alt;
		this.#pendingColumns = paint.columns;
		this.#pendingRows = paint.rows;
		this.#pendingRawViewport = paint.viewport;
		this.#pendingViewport = undefined;
	}

	/** Redact rows drained from now on with `redactor`; cached rows are dropped so the next drain re-redacts. */
	setRedactor(redactor: StreamRedactor): void {
		this.#redactor = redactor;
		this.#rowCache.clear();
	}

	/** Make the next drain emit a full viewport snapshot, re-sending the last one when nothing is pending. */
	resync(): void {
		this.#pendingForceFull = true;
		if (this.#pendingRawViewport === undefined) this.#pendingViewport ??= this.#lastViewport;
	}

	/**
	 * Drain pending state into frames. With `screen: false` (consumer is
	 * backpressured) only control frames are emitted; the viewport stays pending
	 * and the next screen drain sends a full snapshot.
	 */
	drain(options?: { screen?: boolean }): StreamScreenFrame[] {
		const frames: StreamScreenFrame[] = [];
		if (this.#pendingReset) frames.push({ t: "reset" });
		if (this.#pendingHistory.length > 0 || this.#pendingHistorySkipped > 0) {
			// History rows usually just scrolled out of the cached viewport.
			const history = this.#encodeRows(this.#pendingHistory, new Map());
			const rows =
				this.#pendingHistorySkipped > 0 ? [`… (${this.#pendingHistorySkipped} rows skipped)`, ...history] : history;
			frames.push({ t: "history", rows });
		}
		const resized = this.#pendingColumns !== this.#lastColumns || this.#pendingRows !== this.#lastRows;
		if (resized) {
			frames.push({ t: "resize", cols: this.#pendingColumns, rows: this.#pendingRows });
			this.#lastColumns = this.#pendingColumns;
			this.#lastRows = this.#pendingRows;
		}

		const raw = this.#pendingRawViewport;
		const pendingViewport = this.#pendingViewport;
		const forceFull = this.#pendingForceFull || this.#pendingReset || resized || this.#pendingAlt;
		this.#pendingReset = false;
		this.#pendingHistory = [];
		this.#pendingHistorySkipped = 0;
		this.#pendingForceFull = false;
		if (raw === undefined && pendingViewport === undefined) return frames;
		if (options?.screen === false) {
			this.#pendingForceFull = true;
			return frames;
		}
		this.#pendingRawViewport = undefined;
		this.#pendingViewport = undefined;
		let viewport: StreamRow[];
		if (raw === undefined) {
			viewport = pendingViewport!;
		} else {
			const cache = new Map<string, StreamRow>();
			viewport = this.#encodeRows(raw, cache);
			this.#rowCache = cache;
		}

		const last = this.#lastViewport;
		this.#lastViewport = viewport;
		if (!last || forceFull) {
			frames.push({ t: "viewport", rows: viewport });
			return frames;
		}
		const ops: [number, StreamRow][] = [];
		for (let index = 0; index < viewport.length; index++) {
			if (viewport[index] !== last[index]) ops.push([index, viewport[index]!]);
		}
		const changed = ops.length + Math.max(0, last.length - viewport.length);
		if (changed === 0) return frames;
		frames.push(
			changed > viewport.length / 2 ? { t: "viewport", rows: viewport } : { t: "patch", ops, rows: viewport.length },
		);
		return frames;
	}

	/** Normalize and redact rows, reusing the last viewport's results; fills `cache` with this call's results. */
	#encodeRows(rows: readonly string[], cache: Map<string, StreamRow>): StreamRow[] {
		return rows.map(row => {
			let normalized = cache.get(row) ?? this.#rowCache.get(row);
			if (normalized === undefined) normalized = this.#redactor.redactRow(normalizeStreamRow(row));
			cache.set(row, normalized);
			return normalized;
		});
	}
}
