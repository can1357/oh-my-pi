import * as fs from "node:fs";
import type { OutputSink } from "./writer";

/** The stream surface a sink writes to (process.stdout satisfies it). */
export interface TtyStream {
	write(data: string): boolean;
	readonly writableNeedDrain?: boolean;
	/** Bytes queued and not yet handed to the terminal. */
	readonly writableLength?: number;
	once(event: "drain", listener: () => void): unknown;
}

/** Configuration of {@link streamSink}. */
export interface StreamSinkOptions {
	/**
	 * A Windows pseudoconsole reads the stream: writes larger than
	 * {@link CONPTY_CHUNK_BYTES} go out in line-bounded pieces (one oversized
	 * write makes conhost misplace its viewport).
	 */
	readonly conpty?: () => boolean;
	/** Append every write to this file (debugging; `PI_TUI_WRITE_LOG`). OSC 52 clipboard payloads are logged by length only. */
	readonly logPath?: string;
}

/** An {@link OutputSink} that also reports its backlog. */
export interface StreamSink extends OutputSink {
	/** Bytes written but not yet consumed by the terminal. */
	pending(): number;
	/** Run `callback` once the backlog drained (at once when there is none). */
	onDrain(callback: () => void): void;
}

/** Largest single write a ConPTY host gets. */
export const CONPTY_CHUNK_BYTES = 16 * 1024;

const OSC52 = /\x1b\]52;([^;\x07\x1b]*);([^\x07\x1b]*)(\x07|\x1b\\)/g;

/** UTF-8 bytes of the UTF-16 unit at `i` (a surrogate pair counts 4 on its high half). */
function unitBytes(data: string, i: number): { bytes: number; units: number } {
	const cu = data.charCodeAt(i);
	if (cu < 0x80) return { bytes: 1, units: 1 };
	if (cu < 0x800) return { bytes: 2, units: 1 };
	if (cu >= 0xd800 && cu < 0xdc00) {
		const next = data.charCodeAt(i + 1);
		if (next >= 0xdc00 && next < 0xe000) return { bytes: 4, units: 2 };
	}
	return { bytes: 3, units: 1 };
}

/**
 * Split `data` into pieces of at most `max` UTF-8 bytes, cut after a line
 * terminator (`\n`, or a `\r` not opening `\r\n`) so escape sequences and rows
 * stay whole; a window without one is cut at a code point boundary.
 */
export function chunkForConPTY(data: string, max: number = CONPTY_CHUNK_BYTES): string[] {
	if (Buffer.byteLength(data, "utf8") <= max) return [data];
	const chunks: string[] = [];
	let pos = 0;
	while (pos < data.length) {
		let bytes = 0;
		let cut = -1;
		let i = pos;
		for (; i < data.length;) {
			const unit = unitBytes(data, i);
			if (bytes + unit.bytes > max && i > pos) break;
			bytes += unit.bytes;
			const cu = data.charCodeAt(i);
			i += unit.units;
			if (cu === 0x0a || (cu === 0x0d && data.charCodeAt(i) !== 0x0a)) cut = i;
		}
		if (i >= data.length) {
			chunks.push(data.slice(pos));
			break;
		}
		let end = cut > pos ? cut : i;
		// A hard cut between `\r` and `\n` moves before the `\r`.
		if (end === i && data.charCodeAt(i) === 0x0a && data.charCodeAt(i - 1) === 0x0d && i - 1 > pos) end = i - 1;
		chunks.push(data.slice(pos, end));
		pos = end;
	}
	return chunks;
}

/** An {@link OutputSink} over a tty stream; `flush` waits for a pending drain. */
export function streamSink(stream: TtyStream = process.stdout, options: StreamSinkOptions = {}): StreamSink {
	const { conpty, logPath } = options;
	const drained = (callback: () => void): void => {
		if (!stream.writableNeedDrain) callback();
		else stream.once("drain", callback);
	};
	return {
		write(data) {
			if (data.length > CONPTY_CHUNK_BYTES / 4 && conpty?.()) {
				for (const chunk of chunkForConPTY(data)) stream.write(chunk);
			} else {
				stream.write(data);
			}
			if (logPath) {
				try {
					fs.appendFileSync(
						logPath,
						data.replace(OSC52, (_seq, selection: string, payload: string, end: string) => {
							return `\x1b]52;${selection};<${payload.length} bytes>${end}`;
						}),
					);
				} catch {
					// Logging is best-effort.
				}
			}
		},
		flush() {
			const { promise, resolve } = Promise.withResolvers<void>();
			drained(resolve);
			return promise;
		},
		pending: () => stream.writableLength ?? 0,
		onDrain: drained,
	};
}

/**
 * Tells a stalled terminal (a reader that stopped consuming for good) from a
 * slow one draining a huge write. An episode starts once the backlog exceeds
 * `armBytes` and ends when it drains to `clearBytes`; during it, the terminal
 * counts as gone only after `stallMs` without a new low-water mark.
 */
export class StallWatchdog {
	#armed = false;
	#lowWater = Number.POSITIVE_INFINITY;
	#since = 0;

	constructor(
		readonly armBytes = 64 * 1024 * 1024,
		readonly clearBytes = 256 * 1024,
		readonly stallMs = 60_000,
	) {}

	/** An episode is running: keep sampling until it ends. */
	get armed(): boolean {
		return this.#armed;
	}

	/** Feed the backlog at `now`; true once the terminal stalled. */
	sample(pending: number, now: number): boolean {
		if (!this.#armed) {
			if (pending <= this.armBytes) return false;
			this.#armed = true;
			this.#lowWater = pending;
			this.#since = now;
			return false;
		}
		if (pending <= this.clearBytes) {
			this.reset();
			return false;
		}
		if (pending < this.#lowWater) {
			this.#lowWater = pending;
			this.#since = now;
			return false;
		}
		return now - this.#since >= this.stallMs;
	}

	reset(): void {
		this.#armed = false;
		this.#lowWater = Number.POSITIVE_INFINITY;
		this.#since = 0;
	}
}
