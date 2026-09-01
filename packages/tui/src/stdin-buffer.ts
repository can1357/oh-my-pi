/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */
import { EventEmitter } from "events";
import { isKittyProtocolActive } from "./keys";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
// Paste-mode recovery bounds: a lost/corrupted end marker (ssh/tmux
// truncation) must not hang input forever or grow memory unboundedly.
const PASTE_INACTIVITY_TIMEOUT_MS = 1000;
const PASTE_MAX_BYTES = 64 * 1024 * 1024;
// A buggy double-report (CSI-u event plus the bare printable for the same
// keypress) arrives in the same terminal write; a bare char that shows up
// later than this window is a real keystroke and must not be swallowed.
const KITTY_PRINTABLE_DEDUP_WINDOW_MS = 25;
// An SGR mouse report prefix is unambiguous: no keyboard sequence starts with
// `\x1b[<`, so a buffer still matching this is always the head of a split
// mouse report. Flushing it on timeout would deliver the tail as literal
// typed text to whatever component is focused (fullscreen overlays enable
// any-motion tracking, so report floods plus render stalls make the split
// routine — see the settings search leaking `[<35;8;16M`).
const SGR_MOUSE_PARTIAL = /^\x1b\[<[\d;]*$/;
// Upper bound on how long an unambiguous partial is held past the flush
// timeout before being delivered raw anyway (terminal died mid-sequence).
// This is also the worst-case added latency for a partial that never
// completes (e.g. a bare ESC delivered while the kitty-active flag is
// stale); keep it small.
const PARTIAL_HOLD_MAX_MS = 150;
// Escape-sequence length caps. `resolveEscapeEnd` scans within these bounds
// only, so a malformed CSI (missing final byte in `0x40-0x7E`) or a
// terminator-less OSC/DCS/APC cannot force `extractCompleteSequences` to
// re-inspect a growing prefix on every `process()` call — a single call
// stays bounded work, and a streamed run of garbage bytes is flushed as
// raw sequences instead of accumulated forever (issue #4073 case A).
//
// CSI is intentionally tight: real CSI keys, mouse reports, and DECRQM
// replies are always well under 4 KiB. OSC/DCS/APC allow much larger
// payloads (kitty OSC 5522 clipboard reads, Sixel DCS, kitty graphics APC),
// so the string-terminator cap is generous.
const MAX_CSI_BYTES = 4096;
const MAX_STRING_SEQ_BYTES = 16 * 1024 * 1024;
// Torn-string discard bounds. When a capped or timeout-expired OSC/DCS/APC
// partial is dropped, the bytes that follow are mid-string payload (base64
// clipboard data, Sixel, …) up to the next ST/BEL. Replaying them as
// keystrokes types kilobytes of garbage into the focused component (kitty
// OSC 5522 image paste spam), so discard mode swallows the tail until a
// terminator — bounded by a byte budget for a terminator-less stream and an
// inactivity watchdog for a stream that simply stops.
const STRING_DISCARD_MAX_BYTES = 2 * MAX_STRING_SEQ_BYTES;
const STRING_DISCARD_INACTIVITY_MS = 1000;
// Partial that can only be the head of an OSC/DCS/APC string sequence.
const STRING_SEQ_PARTIAL = /^\x1b[\]P_]/;

// SGR mouse report bodies live between `<` and the terminating `M`/`m`.
// Matched only when the trailing byte is a valid terminator, so the regex
// runs at most once per resolved report — never inside the growth loop.
const SGR_MOUSE_COMPLETE = /^<\d+;\d+;\d+[Mm]$/;

// Raw-paste classification holds CR/LF-bearing, ESC-free input briefly so
// adjacent stdin reads from one unmarked paste can be considered together.
// Fixed from the first break-bearing read (not an inactivity debounce): normal
// Enter latency and candidate memory remain bounded even under a continuous
// stream. Ten milliseconds spans adjacent PTY reads without becoming perceptible.
const RAW_PASTE_CLASSIFICATION_TIMEOUT_MS = 10;

/**
 * Whether `text` has two completed logical line breaks (three line segments).
 *
 * A single Enter may be batched with surrounding keystrokes in one stdin read,
 * so one break is ambiguous and must stay on the key path. CRLF counts as one
 * logical break. Content after the second break completes the third segment;
 * until then the classification window keeps buffering.
 */
function isRawMultilineBurst(text: string): boolean {
	let breaks = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x0d) {
			breaks++;
			if (text.charCodeAt(i + 1) === 0x0a) i++;
			continue;
		}
		if (code === 0x0a) {
			breaks++;
			continue;
		}
		if (breaks >= 2) return true;
	}
	return false;
}

/**
 * Resolve the exclusive-end index of the escape sequence starting at `pos`
 * (`buffer.charCodeAt(pos)` must be ESC). `resumeSearchFrom` is honored only
 * for OSC/DCS/APC — it lets a chunked payload skip the prefix that a prior
 * `process()` call already searched, so a large OSC 5522 image paste stays
 * O(total) instead of O(total²).
 *
 * Meta-ESC (`\x1b\x1b…`) is not resolved here; the outer loop handles the
 * disambiguation shared with the flush timer and the SGR mouse split. This
 * helper returns -1 when the first byte after ESC is another ESC.
 *
 * Return codes:
 *   `end > pos`  — complete sequence, exclusive end index.
 *   `-1`         — incomplete, still under the per-type cap; buffer for more.
 *   `-2`         — incomplete and the prefix already spans the per-type cap;
 *                  the caller cap-flushes CSI as raw bytes; string types
 *                  (OSC/DCS/APC) are dropped and their tail discarded.
 */
function resolveEscapeEnd(buffer: string, pos: number, length: number, resumeSearchFrom: number): number {
	if (pos + 1 >= length) return -1;
	const next = buffer.charCodeAt(pos + 1);

	switch (next) {
		case 0x1b /* ESC */:
			// Meta-ESC handled by the caller.
			return -1;
		case 0x5b /* [ */:
			{
				// CSI: ESC [ ... final byte in 0x40-0x7E.
				if (pos + 2 >= length) return -1;
				// Old-style X10 mouse: ESC [ M + 3 arbitrary bytes.
				if (buffer.charCodeAt(pos + 2) === 0x4d /* M */) {
					if (pos + 6 <= length) return pos + 6;
					// Fewer than 6 bytes buffered is always under MAX_CSI_BYTES,
					// so this is a plain "wait for more", never a cap flush.
					return -1;
				}
				const capEnd = Math.min(length, pos + MAX_CSI_BYTES);
				const isSgrMouse = buffer.charCodeAt(pos + 2) === 0x3c /* < */;
				// No resume hint for CSI: `extractCompleteSequences` records
				// hints only for OSC/DCS/APC. A partial CSI rescans from its
				// head, bounded by the tight MAX_CSI_BYTES cap.
				let i = pos + 2;
				while (i < capEnd) {
					const code = buffer.charCodeAt(i);
					if (code >= 0x40 && code <= 0x7e) {
						if (isSgrMouse) {
							// SGR mouse only terminates on M/m. Any other final
							// byte would be a malformed body — keep scanning to
							// match the prior `isCompleteCsiSequence` semantics.
							if (code !== 0x4d && code !== 0x6d) {
								i++;
								continue;
							}
							const payload = buffer.slice(pos + 2, i + 1);
							if (SGR_MOUSE_COMPLETE.test(payload)) return i + 1;
							// Malformed body ending in M/m — keep scanning for a
							// real terminator. Bounded by capEnd.
							i++;
							continue;
						}
						return i + 1;
					}
					i++;
				}
				return length - pos >= MAX_CSI_BYTES ? -2 : -1;
			}
		case 0x5d /* ] */:
			{
				// OSC: ESC ] ... BEL or ST (ESC \). Scan is bounded to
				// [searchFrom, scanLimit): `String#indexOf` has no end bound, so
				// an unterminated payload delivered as one huge chunk would
				// otherwise be scanned to the end of the buffer — past the cap
				// this function exists to enforce. `resumeSearchFrom - 1` keeps
				// the one-byte overlap so an `ESC \` split across chunks is
				// still found (the prior call's trailing ESC is re-inspected).
				const searchFrom = Math.max(pos + 2, resumeSearchFrom - 1);
				const scanLimit = Math.min(length, pos + MAX_STRING_SEQ_BYTES);
				for (let i = searchFrom; i < scanLimit; i++) {
					const code = buffer.charCodeAt(i);
					if (code === 0x07 /* BEL */) return i + 1;
					if (code === 0x1b /* ESC */) {
						// `ESC \` (ST) must end within the cap; a lone trailing
						// ESC at the buffer edge stays incomplete and is
						// re-examined next call via the resume overlap.
						if (i + 1 < scanLimit && buffer.charCodeAt(i + 1) === 0x5c /* \ */) return i + 2;
					}
				}
				return length - pos >= MAX_STRING_SEQ_BYTES ? -2 : -1;
			}
		case 0x50 /* P */:
		case 0x5f /* _ */:
			{
				// DCS / APC: ESC P/_ ... ST (ESC \). Same bounded scan and
				// split-ST overlap as the OSC branch, minus BEL.
				const searchFrom = Math.max(pos + 2, resumeSearchFrom - 1);
				const scanLimit = Math.min(length, pos + MAX_STRING_SEQ_BYTES);
				for (let i = searchFrom; i < scanLimit; i++) {
					if (
						buffer.charCodeAt(i) === 0x1b /* ESC */ &&
						i + 1 < scanLimit &&
						buffer.charCodeAt(i + 1) === 0x5c /* \ */
					) {
						return i + 2;
					}
				}
				return length - pos >= MAX_STRING_SEQ_BYTES ? -2 : -1;
			}
		case 0x4f /* O */:
			// SS3: ESC O + 1 char.
			return pos + 3 <= length ? pos + 3 : -1;
		default:
			// Meta chord: ESC + 1 char.
			return pos + 2;
	}
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(
	buffer: string,
	resumeSearchFrom: number,
): { sequences: string[]; remainder: string; resumeSearchFrom: number; discardFrom?: number } {
	const sequences: string[] = [];
	const length = buffer.length;
	let pos = 0;

	// Index-based scanning: this is the input hot path. Slicing the remaining
	// buffer (or Array.from-ing it) per iteration would make plain-text bursts
	// O(n²) — a 100KB non-bracketed paste must stay O(n).
	//
	// `resumeSearchFrom` applies only when the buffer starts with an
	// incomplete OSC/DCS/APC we buffered on the previous call; once any
	// bytes are consumed (pos advances past the leading escape), the hint no
	// longer maps to the current buffer offsets and is discarded.
	let hint = resumeSearchFrom;

	while (pos < length) {
		if (buffer.charCodeAt(pos) !== 0x1b) {
			// Not an escape sequence - take one Unicode scalar, not a UTF-16 code unit.
			const codePoint = buffer.codePointAt(pos)!;
			const charLength = codePoint > 0xffff ? 2 : 1;
			sequences.push(buffer.slice(pos, pos + charLength));
			pos += charLength;
			hint = 0;
			continue;
		}

		// `\x1b\x1b` is one of three things — see the outer switch below.
		// Kept in the outer loop because it interacts with flush timing
		// (bare `\x1b\x1b` is held for the timer chain) and with the SGR
		// mouse split that splits `\x1b\x1b[<…` into `\x1b` + `\x1b[<…`.
		if (pos + 1 < length && buffer.charCodeAt(pos + 1) === 0x1b) {
			if (pos + 2 >= length) {
				//   Two real Esc keypresses bursted by terminal input batching:
				//   when the buffer ends here, hold the partial for the flush
				//   window so cases 1/2 can still arrive; if no follower
				//   arrives, `flush()` splits the held remainder into two ESC
				//   events (#3857).
				return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: 0 };
			}
			const third = buffer.charCodeAt(pos + 2);
			if (third !== 0x5b && third !== 0x4f) {
				//   ESC followed by a legacy Alt chord (`\x1bd`, `\x1b\x7f`, …):
				//   emit the first ESC, then restart at the second ESC so
				//   downstream parsing still sees the Alt chord as one
				//   keypress (#3860 review).
				sequences.push(ESC);
				pos += 1;
				hint = 0;
				continue;
			}
			//   ESC prefixing CSI/SS3 (meta-CSI, held Esc joined by a follower):
			//   resolve the inner escape's end from `pos + 1`. Consuming two
			//   bytes here would tear the follower and leak its tail as typed
			//   text (settings search filling with "[B" or "[<35;22;17M").
			const innerEnd = resolveEscapeEnd(buffer, pos + 1, length, 0);
			if (innerEnd === -1) {
				return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: 0 };
			}
			if (innerEnd === -2) {
				// `third` is CSI/SS3 here, never a string type.
				const flushEnd = Math.min(length, pos + MAX_CSI_BYTES);
				sequences.push(buffer.slice(pos, flushEnd));
				pos = flushEnd;
				hint = 0;
				continue;
			}
			// ESC + SGR mouse is never a meta chord: alt-modified mouse
			// reports carry the modifier in the button bits, not an ESC
			// prefix. Deliver the bare ESC and the report separately.
			if (third === 0x5b && buffer.charCodeAt(pos + 3) === 0x3c) {
				sequences.push(ESC);
				sequences.push(buffer.slice(pos + 1, innerEnd));
				pos = innerEnd;
				hint = 0;
				continue;
			}
			sequences.push(buffer.slice(pos, innerEnd));
			pos = innerEnd;
			hint = 0;
			continue;
		}

		// Single ESC — resolve directly. Hint carries over from the previous
		// call only when we are still on the buffered escape (pos === 0).
		const end = resolveEscapeEnd(buffer, pos, length, pos === 0 ? hint : 0);
		if (end === -1) {
			// Buffer for more. When this is the leading OSC/DCS/APC,
			// remember how far we scanned so the next `process()` call
			// resumes from there instead of rescanning the whole buffer.
			const next = pos + 1 < length ? buffer.charCodeAt(pos + 1) : -1;
			const nextHint = pos === 0 && (next === 0x5d || next === 0x50 || next === 0x5f) ? length : 0;
			return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: nextHint };
		}
		if (end === -2) {
			const next = buffer.charCodeAt(pos + 1);
			if (next === 0x5d || next === 0x50 || next === 0x5f) {
				// Unterminated string sequence at the cap (issue #4073 case A):
				// the head is junk and everything after it is mid-string
				// payload. Hand both to the caller's discard mode instead of
				// flushing the payload as per-character typed text.
				return { sequences, remainder: "", resumeSearchFrom: 0, discardFrom: pos };
			}
			const flushEnd = Math.min(length, pos + MAX_CSI_BYTES);
			sequences.push(buffer.slice(pos, flushEnd));
			pos = flushEnd;
			hint = 0;
			continue;
		}
		sequences.push(buffer.slice(pos, end));
		pos = end;
		hint = 0;
	}

	return { sequences, remainder: "", resumeSearchFrom: 0 };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 75ms).
	 * After this time, a genuinely incomplete escape is flushed.
	 */
	timeout?: number;
	/**
	 * Maximum extra time (default: 150ms) an unambiguous escape partial — an
	 * SGR mouse prefix, or any dangling escape while the kitty keyboard
	 * protocol is active — is held past `timeout` waiting for its tail.
	 */
	partialHoldTimeout?: number;
	/**
	 * Paste-mode inactivity watchdog (default: 1000ms). If no input arrives for
	 * this long while waiting for the bracketed-paste end marker, the paste is
	 * assumed truncated: accumulated bytes are delivered and input recovers.
	 */
	pasteTimeout?: number;
	/**
	 * Paste-mode byte cap (default: 64 MiB). Exceeding it aborts paste mode the
	 * same way, bounding memory when the end marker never arrives.
	 */
	pasteByteLimit?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	#buffer: string = "";
	#timeout?: NodeJS.Timeout;
	#flushDeferral?: NodeJS.Timeout;
	#partialHoldStartMs = 0;
	readonly #timeoutMs: number;
	readonly #partialHoldMaxMs: number;
	readonly #pasteTimeoutMs: number;
	readonly #pasteByteLimit: number;
	#pasteMode: boolean = false;
	#pasteChunks: string[] = [];
	#pasteOverlap: string = "";
	#pasteBytes = 0;
	#pasteWatchdog?: NodeJS.Timeout;
	#pendingKittyPrintableCodepoint: number | undefined;
	#pendingKittyPrintableAtMs = 0;
	#escapeSearchOffset = 0;
	#rawPasteCandidate = "";
	#rawPasteTimer?: NodeJS.Timeout;
	#stringDiscardActive = false;
	#stringDiscardBytes = 0;
	#stringDiscardEscHeld = false;
	#stringDiscardWatchdog?: NodeJS.Timeout;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.#timeoutMs = options.timeout ?? 75;
		this.#partialHoldMaxMs = options.partialHoldTimeout ?? PARTIAL_HOLD_MAX_MS;
		this.#pasteTimeoutMs = options.pasteTimeout ?? PASTE_INACTIVITY_TIMEOUT_MS;
		this.#pasteByteLimit = options.pasteByteLimit ?? PASTE_MAX_BYTES;
	}

	process(data: string | Buffer): void {
		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}
		if (this.#stringDiscardActive) {
			// Mid torn-string: swallow payload up to the terminator; only what
			// follows the terminator re-enters normal parsing.
			str = this.#consumeStringDiscard(str);
			if (str.length === 0) return;
		}

		if (this.#flushDeferral && this.#isFreshEscapeAfterDeferredFlush(str)) {
			// The buffered partial already hit its flush timeout. A new escape is
			// a fresh sequence, not a tail; flush the stale partial first so the
			// new sequence can be parsed from a clean buffer.
			this.#flushExpired();
		} else {
			// Cancel any pending flush — new data may complete the buffered partial.
			this.#clearFlushTimer();
		}

		if (str.length === 0 && this.#buffer.length === 0 && this.#rawPasteCandidate.length === 0) {
			this.#emitDataSequence("");
			return;
		}

		if (this.#pasteMode) {
			this.#consumePasteChunk(str);
			return;
		}

		if (this.#rawPasteCandidate.length > 0) {
			if (str.indexOf(ESC) !== -1) {
				// Escape-bearing input cannot belong to an unmarked raw paste.
				// Replay the ambiguous prefix as keys before parsing the escape.
				this.#flushRawPasteCandidate();
			} else {
				this.#rawPasteCandidate += str;
				if (isRawMultilineBurst(this.#rawPasteCandidate)) {
					this.#emitRawPasteCandidate();
				}
				return;
			}
		}

		if (
			this.#buffer.length === 0 &&
			str.indexOf(ESC) === -1 &&
			(str.indexOf("\r") !== -1 || str.indexOf("\n") !== -1)
		) {
			// Hold the first break-bearing read briefly. A split raw paste can
			// then accumulate enough logical lines to classify; an ordinary
			// Enter is replayed unchanged when the fixed window expires.
			this.#rawPasteCandidate = str;
			if (isRawMultilineBurst(str)) {
				this.#emitRawPasteCandidate();
			} else {
				this.#armRawPasteTimer();
			}
			return;
		}

		this.#buffer += str;

		const startIndex = this.#buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.#buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste, 0);
				for (const sequence of result.sequences) {
					this.#emitDataSequence(sequence);
				}
			}

			this.#escapeSearchOffset = 0;
			this.#pendingKittyPrintableCodepoint = undefined;
			this.#buffer = this.#buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			const firstChunk = this.#buffer;
			this.#buffer = "";
			this.#pasteMode = true;
			this.#pasteChunks = [];
			this.#pasteOverlap = "";
			this.#pasteBytes = 0;
			this.#consumePasteChunk(firstChunk);
			return;
		}

		const result = extractCompleteSequences(this.#buffer, this.#escapeSearchOffset);
		if (result.discardFrom !== undefined) {
			const junk = this.#buffer.slice(result.discardFrom);
			this.#buffer = "";
			this.#escapeSearchOffset = 0;
			for (const sequence of result.sequences) {
				this.#emitDataSequence(sequence);
			}
			this.#enterStringDiscard();
			const after = this.#consumeStringDiscard(junk);
			if (after.length > 0) this.process(after);
			return;
		}
		this.#buffer = result.remainder;
		this.#escapeSearchOffset = result.resumeSearchFrom;

		for (const sequence of result.sequences) {
			this.#emitDataSequence(sequence);
		}

		if (this.#buffer.length > 0) {
			this.#armFlushTimer();
		} else {
			this.#partialHoldStartMs = 0;
		}
	}

	/**
	 * Consume one chunk of paste-mode input. Chunks are accumulated in an array
	 * and only joined once the end marker arrives, so a large paste delivered in
	 * many small terminal reads stays O(total) instead of the O(total^2) cost of
	 * re-concatenating and rescanning the whole buffer on every chunk. A short
	 * overlap tail (end-marker length - 1) is carried across chunk boundaries so
	 * a marker split between two reads is still detected without rescanning.
	 */
	#consumePasteChunk(chunk: string): void {
		const probe = this.#pasteOverlap + chunk;
		if (probe.indexOf(BRACKETED_PASTE_END) === -1) {
			this.#pasteChunks.push(chunk);
			this.#pasteBytes += chunk.length;
			const keep = BRACKETED_PASTE_END.length - 1;
			this.#pasteOverlap = probe.length > keep ? probe.slice(probe.length - keep) : probe;
			if (this.#pasteBytes > this.#pasteByteLimit) {
				this.#abortPaste();
				return;
			}
			this.#armPasteWatchdog();
			return;
		}

		// End marker arrived: join once and split at its first occurrence,
		// matching the prior indexOf-from-start semantics exactly.
		const flat = this.#pasteChunks.length > 0 ? `${this.#pasteChunks.join("")}${chunk}` : chunk;
		const endIndex = flat.indexOf(BRACKETED_PASTE_END);
		const pastedContent = flat.slice(0, endIndex);
		const remaining = flat.slice(endIndex + BRACKETED_PASTE_END.length);

		this.#clearPasteWatchdog();
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;

		this.emit("paste", pastedContent);

		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	/** Re-arm the paste-mode inactivity watchdog after each chunk. */
	#armPasteWatchdog(): void {
		if (this.#pasteWatchdog) clearTimeout(this.#pasteWatchdog);
		this.#pasteWatchdog = setTimeout(() => {
			this.#pasteWatchdog = undefined;
			this.#abortPaste();
		}, this.#pasteTimeoutMs);
	}

	#clearPasteWatchdog(): void {
		if (this.#pasteWatchdog) {
			clearTimeout(this.#pasteWatchdog);
			this.#pasteWatchdog = undefined;
		}
	}

	/**
	 * Recover from a paste whose end marker never arrived (dropped or corrupted
	 * in transit, or past the byte cap): exit paste mode and deliver the
	 * accumulated bytes as a paste, so they are neither lost, replayed as
	 * keystrokes, nor accumulated forever while input appears dead.
	 */
	#abortPaste(): void {
		this.#clearPasteWatchdog();
		const content = this.#pasteChunks.join("");
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.emit("paste", content);
	}

	/** Start one fixed window from the first break-bearing raw read. */
	#armRawPasteTimer(): void {
		if (this.#rawPasteTimer) return;
		this.#rawPasteTimer = setTimeout(() => {
			this.#rawPasteTimer = undefined;
			this.#flushRawPasteCandidate();
		}, RAW_PASTE_CLASSIFICATION_TIMEOUT_MS);
	}

	#clearRawPasteTimer(): void {
		if (this.#rawPasteTimer) {
			clearTimeout(this.#rawPasteTimer);
			this.#rawPasteTimer = undefined;
		}
	}

	#takeRawPasteCandidate(): string {
		this.#clearRawPasteTimer();
		const content = this.#rawPasteCandidate;
		this.#rawPasteCandidate = "";
		return content;
	}

	/** Emit a classified raw multiline burst through the paste channel. */
	#emitRawPasteCandidate(): void {
		const content = this.#takeRawPasteCandidate();
		this.#pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", content);
	}

	/** Replay an ambiguous raw candidate as the original per-key data events. */
	#flushRawPasteCandidate(): void {
		const content = this.#takeRawPasteCandidate();
		if (content.length === 0) return;
		const result = extractCompleteSequences(content, 0);
		for (const sequence of result.sequences) {
			this.#emitDataSequence(sequence);
		}
	}

	#emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (
			rawCodepoint !== undefined &&
			rawCodepoint === this.#pendingKittyPrintableCodepoint &&
			Date.now() - this.#pendingKittyPrintableAtMs <= KITTY_PRINTABLE_DEDUP_WINDOW_MS
		) {
			this.#pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.#pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		if (this.#pendingKittyPrintableCodepoint !== undefined) {
			this.#pendingKittyPrintableAtMs = Date.now();
		}
		this.emit("data", sequence);
	}

	/**
	 * setTimeout(0): when the event loop stalls past the timeout (heavy render)
	 * while the tail of a split escape is already queued on stdin, expired
	 * timers run before the poll phase that delivers the tail — flushing
	 * straight from the timer would tear the sequence apart and leak the tail
	 * as typed text. The zero-delay deferral runs on the next timers pass,
	 * after poll has had a chance to deliver the pending chunk to process()
	 * and cancel the deferral.
	 */
	#armFlushTimer(): void {
		this.#timeout = setTimeout(() => {
			this.#timeout = undefined;
			this.#flushDeferral = setTimeout(() => {
				this.#flushDeferral = undefined;
				this.#flushExpired(true);
			});
		}, this.#timeoutMs);
	}

	#clearFlushTimer(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}
		if (this.#flushDeferral) {
			clearTimeout(this.#flushDeferral);
			this.#flushDeferral = undefined;
		}
	}

	/**
	 * A deferred flush means the current buffer already waited for the
	 * incomplete-sequence timeout. If the next chunk starts a fresh escape, do
	 * not merge it into the stale partial. Keep ESC-backslash as a continuation
	 * for OSC/DCS/APC string terminators (`ST`).
	 */
	#isFreshEscapeAfterDeferredFlush(str: string): boolean {
		if (!str.startsWith(ESC) || this.#buffer.length === 0) return false;
		if (
			str.startsWith(`${ESC}\\`) &&
			(this.#buffer.startsWith(`${ESC}]`) ||
				this.#buffer.startsWith(`${ESC}P`) ||
				this.#buffer.startsWith(`${ESC}_`))
		) {
			return false;
		}
		return true;
	}

	/**
	 * Whether the dangling partial cannot be a finished keypress and is worth
	 * holding for its tail instead of flushing:
	 * - SGR mouse prefixes (`\x1b[<…`) — no keyboard sequence uses them.
	 * - Any partial while the kitty keyboard protocol is active — the ESC key
	 *   arrives as `\x1b[27u` and alt-chords as CSI-u, so a bare `\x1b` (or
	 *   any unterminated escape) is always a split sequence, never a key.
	 */
	#shouldHoldPartial(): boolean {
		return SGR_MOUSE_PARTIAL.test(this.#buffer) || isKittyProtocolActive();
	}

	/** Timeout-driven flush: hold unambiguous partials (bounded), else deliver. */
	#flushExpired(fromTimer = false): void {
		if (this.#buffer.length === 0) {
			this.#partialHoldStartMs = 0;
			return;
		}
		if (this.#shouldHoldPartial()) {
			if (this.#partialHoldStartMs === 0) this.#partialHoldStartMs = Date.now();
			if (Date.now() - this.#partialHoldStartMs < this.#partialHoldMaxMs) {
				this.#armFlushTimer();
				return;
			}
		}
		this.#partialHoldStartMs = 0;
		for (const sequence of this.#drainBuffered(fromTimer)) {
			this.#emitDataSequence(sequence);
		}
	}

	flush(): string[] {
		return this.#drainBuffered(false);
	}

	#drainBuffered(discardTornString: boolean): string[] {
		this.#clearFlushTimer();

		const rawCandidate = this.#takeRawPasteCandidate();
		const sequences = rawCandidate.length > 0 ? extractCompleteSequences(rawCandidate, 0).sequences : [];

		if (this.#buffer.length === 0) {
			this.#pendingKittyPrintableCodepoint = undefined;
			return sequences;
		}

		const buffered = this.#buffer;
		this.#buffer = "";
		this.#escapeSearchOffset = 0;
		this.#pendingKittyPrintableCodepoint = undefined;
		// Bare double-ESC remainder (no disambiguating "[" / "O" arrived in time):
		// two real Esc keypresses bursted by terminal batching, not a meta-CSI/SS3
		// prefix. `parseKey` returns undefined for the combined chunk, so a single
		// emission swallows the double-escape gesture (#3857). Mirror the inline
		// split in `extractCompleteSequences` and deliver two ESC events.
		if (buffered === `${ESC}${ESC}`) {
			sequences.push(ESC, ESC);
		} else if (isKittyProtocolActive() && STRING_SEQ_PARTIAL.test(buffered)) {
			// Torn OSC/DCS/APC head. Under the kitty keyboard protocol no key
			// ever arrives as a bare `\x1b]`/`\x1bP`/`\x1b_`, so this is always
			// terminal protocol data (kitty OSC 5522 clipboard read, graphics
			// reply) whose tail is still in flight. Never deliver the head as a
			// key; on a timeout flush also swallow the tail up to its
			// terminator so kilobytes of base64 are not typed into the focused
			// component (image paste spam).
			if (discardTornString) this.#enterStringDiscard();
		} else {
			sequences.push(buffered);
		}
		return sequences;
	}

	/** Enter torn-string discard: swallow mid-string bytes until ST/BEL. */
	#enterStringDiscard(): void {
		this.#stringDiscardActive = true;
		this.#stringDiscardBytes = 0;
		this.#stringDiscardEscHeld = false;
		this.#armStringDiscardWatchdog();
	}

	#exitStringDiscard(): void {
		this.#stringDiscardActive = false;
		this.#stringDiscardBytes = 0;
		this.#stringDiscardEscHeld = false;
		if (this.#stringDiscardWatchdog) {
			clearTimeout(this.#stringDiscardWatchdog);
			this.#stringDiscardWatchdog = undefined;
		}
	}

	/**
	 * Swallow mid-string bytes; returns the input remaining after the string
	 * terminator (empty while still inside the torn string). A trailing ESC is
	 * held across calls so an `ESC \` split between reads is still detected.
	 * The byte budget bounds a terminator-less stream; the inactivity watchdog
	 * recovers a stream that stops without ever terminating.
	 */
	#consumeStringDiscard(str: string): string {
		if (this.#stringDiscardEscHeld) {
			this.#stringDiscardEscHeld = false;
			if (str.charCodeAt(0) === 0x5c /* \ */) {
				this.#exitStringDiscard();
				return str.slice(1);
			}
		}
		for (let i = 0; i < str.length; i++) {
			const code = str.charCodeAt(i);
			if (code === 0x07 /* BEL */) {
				this.#exitStringDiscard();
				return str.slice(i + 1);
			}
			if (code === 0x1b /* ESC */) {
				if (i + 1 === str.length) {
					this.#stringDiscardEscHeld = true;
					break;
				}
				if (str.charCodeAt(i + 1) === 0x5c /* \ */) {
					this.#exitStringDiscard();
					return str.slice(i + 2);
				}
			}
		}
		this.#stringDiscardBytes += str.length;
		if (this.#stringDiscardBytes > STRING_DISCARD_MAX_BYTES) {
			this.#exitStringDiscard();
			return "";
		}
		this.#armStringDiscardWatchdog();
		return "";
	}

	#armStringDiscardWatchdog(): void {
		if (this.#stringDiscardWatchdog) clearTimeout(this.#stringDiscardWatchdog);
		this.#stringDiscardWatchdog = setTimeout(() => {
			this.#stringDiscardWatchdog = undefined;
			this.#exitStringDiscard();
		}, STRING_DISCARD_INACTIVITY_MS);
	}

	clear(): void {
		this.#clearFlushTimer();
		this.#clearPasteWatchdog();
		this.#clearRawPasteTimer();
		this.#exitStringDiscard();
		this.#buffer = "";
		this.#rawPasteCandidate = "";
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;
		this.#partialHoldStartMs = 0;
		this.#escapeSearchOffset = 0;
	}

	getBuffer(): string {
		return `${this.#rawPasteCandidate}${this.#buffer}`;
	}

	destroy(): void {
		this.clear();
	}
}
