/**
 * Streaming stdin tokenizer: raw reads in, complete sequences and pastes out.
 *
 * Reads arrive split anywhere (SSH, tmux and PTYs chunk without regard for
 * escape boundaries), so every family — CSI, SS3, OSC, DCS, APC, PM/SOS,
 * ESC-prefixed Alt chords, legacy X10 mouse — is reassembled across reads.
 * Ambiguous heads resolve on timers: a lone ESC is the Escape key after
 * `keyTimeout`; partial key sequences flush after `sequenceTimeout`; heads
 * only a terminal sends (private CSI reports, SGR mouse, reply strings) are
 * held much longer and never leak as typed text.
 *
 * Also handled here because they need the raw read boundaries:
 * - bracketed paste, delivered whole, with TSP messages routed out of it, a
 *   byte cap and an inactivity watchdog for a lost end marker;
 * - unbracketed multi-line bursts (two line breaks with text after them,
 *   gathered for `burstTimeout` from the first break) coalesced into one
 *   paste unless the event loop was stalled (then they are typed keys);
 * - terminals that double-report a kitty printable as CSI u plus the bare
 *   character;
 * - string replies that stall mid-payload: held, abandoned when a key read
 *   interrupts them or nothing arrives for `stringAbandonMs` (single
 *   characters typed into the stall are replayed), and completed when a late
 *   tail still arrives within `stringDormantMs`.
 */
import { type Clock, systemClock } from "./clock";
import { TSP_OPENERS } from "./tsp";

export interface TokenSink {
	/** One complete sequence: a single character, an escape sequence, or an unterminated head flushed on timeout. */
	sequence(seq: string): void;
	paste(text: string, bracketed?: true): void;
}

export interface TokenizerOptions {
	readonly clock?: Clock;
	/** Lone ESC and ESC + introducer. */
	readonly keyTimeout?: number;
	/**
	 * How long a read holding a line break waits for the rest of an unbracketed paste, counted from
	 * that first read. A typed Enter is delivered when it runs out, so keys typed after it reach
	 * what the Enter opened.
	 */
	readonly burstTimeout?: number;
	/** Partial key sequences (`CSI 1;5`). */
	readonly sequenceTimeout?: number;
	/** Heads only a terminal sends (private CSI, mouse); also a lone ESC under the kitty protocol. */
	readonly reportTimeout?: number;
	/** Paste inactivity watchdog (a lost `CSI 201~`). */
	readonly pasteTimeout?: number;
	/** Paste size cap in UTF-8 bytes. */
	readonly pasteByteLimit?: number;
	readonly stringAbandonMs?: number;
	readonly stringDormantMs?: number;
	/** A kitty printable's bare duplicate is swallowed within this window. */
	readonly dedupWindow?: number;
	readonly maxCsiBytes?: number;
	readonly maxStringBytes?: number;
}

const ESC = "\x1b";
/** Enter as the kitty keyboard protocol reports a plain press of it. */
const KITTY_ENTER = /^\x1b\[13(?:;1(?::1)?)?u$/;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

type Match =
	| { readonly kind: "complete"; readonly end: number }
	/** The head continues past the buffer. */
	| { readonly kind: "partial" }
	/** Emit a lone ESC and rescan from the next byte. */
	| { readonly kind: "lone" }
	/** A string introducer whose body ended without a terminator (an ESC that is not ST interrupted it). */
	| { readonly kind: "unterminated"; readonly end: number }
	/** A string body past the size cap. */
	| { readonly kind: "overflow" };

/**
 * A DEC 2048 in-band resize report body without its `t` terminator. iTerm2
 * writes body and terminator in separate chunks (and a read can bundle the
 * body with the next report's introducer); the body is complete, so it is
 * applied as is and the stray `t` that follows is swallowed.
 */
const IN_BAND_BODY = /^\x1b\[48;\d+;\d+;\d+;\d+$/;
/** A head that can only be an in-band resize report (a kitty key `CSI 48;mods u` has at most three fields). */
const IN_BAND_HEAD = /^\x1b\[48;\d+;\d+;\d*/;
/** How long after a terminator-less body a lone `t` is still its terminator. */
const IN_BAND_TERMINATOR_GRACE_MS = 150;

const PARTIAL: Match = { kind: "partial" };
const LONE: Match = { kind: "lone" };

/** How sure we are that a string head is a terminal reply (vs. an Alt chord plus typing). */
function replyLike(head: string): "yes" | "maybe" | "no" {
	const intro = head[1];
	const body = head.slice(2);
	if (TSP_OPENERS.some(opener => head.startsWith(opener))) return "yes";
	if (TSP_OPENERS.some(opener => opener.startsWith(head))) return "maybe";
	if (intro === "]") {
		if (/^\d+;/.test(body)) return "yes";
		return /^\d*$/.test(body) ? "maybe" : "no";
	}
	if (intro === "_") {
		// Kitty graphics replies, and Glyph Protocol replies (`25a1;`).
		if (/^(G[a-z]=|25a1;)/.test(body)) return "yes";
		return /^(G[a-z]?|2|25|25a|25a1)?$/.test(body) ? "maybe" : "no";
	}
	if (intro === "P") {
		if (/^(>\||\d+[$+]r)/.test(body)) return "yes";
		return /^(>|\d+[$+]?)?$/.test(body) ? "maybe" : "no";
	}
	return "no";
}

/** A late TSP tail can contain spaces and end in the same read as real typing. */
function closesTspString(data: string, head: string): boolean {
	if (!TSP_OPENERS.some(opener => head.startsWith(opener))) return false;
	if (head.endsWith(ESC)) return data.startsWith("\\");
	return /^[^\x00-\x1f\x7f]*(?:\x1b\\|\x07)/.test(data);
}

/**
 * A read that cannot continue a pending string payload: a key arrived instead.
 * A new escape sequence always interrupts; a control key does too (DCS
 * replies may carry CR/LF format effectors, so those only after a stall); a
 * space only after a stall, since replies (XTVERSION, TSP JSON) contain spaces.
 */
function interruptsString(data: string, head: string, stalled: boolean): boolean {
	const code = data.charCodeAt(0);
	if (code === 0x1b) return data.length > 1 && data[1] !== "\\";
	if (code === 0x07) return false;
	if (code === 0x20) return stalled && !closesTspString(data, head);
	if (code === 0x0d || code === 0x0a) return stalled || head[1] !== "P";
	return code < 0x20 || code === 0x7f;
}

/** A read that may be the late tail of an abandoned string: payload bytes, optionally a terminator. */
function continuesString(data: string): boolean {
	const body = data.replace(/(\x07|\x1b\\?)$/, "");
	return !/[\x00-\x20\x7f]/.test(body);
}

/**
 * Whether `text` holds two completed line breaks with something after them (CRLF is one break).
 * One Enter may share a read with the keys around it, and typed-ahead input ends on its Enter
 * (`/cmd⏎ word⏎`), so neither is a paste; until a third segment starts the window keeps buffering.
 */
function isMultilineBurst(text: string): boolean {
	let breaks = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x0d) {
			breaks++;
			if (text.charCodeAt(i + 1) === 0x0a) i++;
		} else if (code === 0x0a) breaks++;
		else if (breaks >= 2) return true;
	}
	return false;
}

/**
 * Whether a multi-line burst ends with an Enter typed after the pasted text: a final CR when every
 * earlier break is LF (a paste encodes its breaks one way, so a lone CR after them is the submit key).
 */
function endsWithTypedEnter(text: string): boolean {
	const last = text.length - 1;
	return text.charCodeAt(last) === 0x0d && text.lastIndexOf("\r", last - 1) === -1;
}

interface StringTracking {
	lastRead: number;
	/** Single characters that arrived after a stall: typed keys, replayed if the string is abandoned. */
	readonly suspects: { readonly at: number; readonly text: string }[];
	readonly resumed: boolean;
}

interface PasteState {
	readonly chunks: string[];
	bytes: number;
	/** A trailing head that may be the end marker or a TSP message. */
	pending: string;
}

export class InputTokenizer {
	/** The kitty keyboard protocol is active: a bare ESC is always the head of a sequence. */
	kitty = false;
	/** The raw stream can carry win32-input-mode CSI key records. */
	win32 = false;
	/** Whether the event loop was stalled (a multi-line burst is then batched typing, not a paste). */
	isStalled: (() => boolean) | undefined;

	readonly #sink: TokenSink;
	readonly #clock: Clock;
	readonly #keyTimeout: number;
	readonly #burstTimeout: number;
	readonly #sequenceTimeout: number;
	readonly #reportTimeout: number;
	readonly #pasteTimeout: number;
	readonly #pasteByteLimit: number;
	readonly #stringAbandonMs: number;
	readonly #stringDormantMs: number;
	readonly #dedupWindow: number;
	readonly #maxCsi: number;
	readonly #maxString: number;
	readonly #utf8 = new TextDecoder();

	/** Unconsumed input: empty, or one partial sequence at its head. */
	#buf = "";
	/** Where the string-terminator search of the head resumes. */
	#hint = 0;
	#cancelPartial: (() => void) | null = null;
	#str: StringTracking | null = null;
	#cancelAbandon: (() => void) | null = null;
	#dormant: { readonly head: string; readonly until: number } | null = null;
	#discard: "body" | "esc" | null = null;
	#paste: PasteState | null = null;
	#cancelPasteWatchdog: (() => void) | null = null;
	#burst = "";
	#cancelBurst: (() => void) | null = null;
	/** Reads waiting behind an Enter delivered this turn (see {@link #pause}); null while nothing waits. */
	#waiting: string[] | null = null;
	#cancelWaiting: (() => void) | null = null;
	/** {@link flush} is delivering everything now: no Enter makes the rest wait. */
	#draining = false;
	#dedup: { readonly ch: string; readonly at: number } | null = null;
	/** When a terminator-less in-band resize body was emitted (0: none); see `IN_BAND_BODY`. */
	#inBandTail = 0;

	constructor(sink: TokenSink, options: TokenizerOptions = {}) {
		this.#sink = sink;
		this.#clock = options.clock ?? systemClock;
		this.#keyTimeout = options.keyTimeout ?? 20;
		this.#burstTimeout = options.burstTimeout ?? 10;
		this.#sequenceTimeout = options.sequenceTimeout ?? 100;
		this.#reportTimeout = options.reportTimeout ?? 1000;
		this.#pasteTimeout = options.pasteTimeout ?? 500;
		this.#pasteByteLimit = options.pasteByteLimit ?? 64 * 1024 * 1024;
		this.#stringAbandonMs = options.stringAbandonMs ?? 5000;
		this.#stringDormantMs = options.stringDormantMs ?? 10_000;
		this.#dedupWindow = options.dedupWindow ?? 10;
		this.#maxCsi = options.maxCsiBytes ?? 4096;
		this.#maxString = options.maxStringBytes ?? 16 * 1024 * 1024;
	}

	/** The partial sequence held for the next read. */
	get pending(): string {
		return this.#buf;
	}

	get inPaste(): boolean {
		return this.#paste !== null;
	}

	process(chunk: string | Uint8Array): void {
		let data = typeof chunk === "string" ? chunk : this.#utf8.decode(chunk, { stream: true });
		if (data === "") return;
		if (this.#waiting) {
			this.#waiting.push(data);
			return;
		}
		if (this.#paste) {
			this.#feedPaste(data);
			return;
		}
		if (this.#discard) {
			const rest = this.#feedDiscard(data);
			if (rest === null) return;
			data = rest;
		}
		const now = this.#clock.now();
		if (this.#dormant) {
			const dormant = this.#dormant;
			this.#dormant = null;
			if (now <= dormant.until && (closesTspString(data, dormant.head) || continuesString(data))) {
				this.#buf = dormant.head;
				this.#hint = 0;
				this.#str = { lastRead: now, suspects: [], resumed: true };
				this.#append(data);
				return;
			}
		}
		if (this.#str && this.#buf) {
			const str = this.#str;
			const stalled = now - str.lastRead > this.#keyTimeout;
			if (!interruptsString(data, this.#buf, stalled)) {
				if (stalled && String.fromCodePoint(data.codePointAt(0)!) === data) {
					str.suspects.push({ at: this.#buf.length, text: data });
				}
				str.lastRead = now;
				this.#append(data);
				return;
			}
			this.#abandonString(false);
			this.#append(data);
			return;
		}
		if (this.#buf === "" && this.#feedBurst(data)) return;
		this.#append(data);
	}

	/** Deliver everything held now: partial sequences as they are (reply strings are dropped), a held burst as keys. */
	flush(): void {
		this.#draining = true;
		try {
			this.#releaseBurst();
			this.#resume();
			if (this.#str) this.#abandonString(false);
			this.#scan(true);
		} finally {
			this.#draining = false;
		}
	}

	/** Drop held input without delivering it. */
	clear(): void {
		this.#cancelPartial?.();
		this.#cancelPartial = null;
		this.#cancelAbandon?.();
		this.#cancelAbandon = null;
		this.#cancelBurst?.();
		this.#cancelBurst = null;
		this.#cancelWaiting?.();
		this.#cancelWaiting = null;
		this.#waiting = null;
		this.#cancelPasteWatchdog?.();
		this.#cancelPasteWatchdog = null;
		this.#buf = "";
		this.#hint = 0;
		this.#str = null;
		this.#dormant = null;
		this.#discard = null;
		this.#paste = null;
		this.#burst = "";
		this.#dedup = null;
		this.#inBandTail = 0;
	}

	#append(data: string): void {
		this.#buf += data;
		this.#scan(false);
	}

	// ── Sequence matching ─────────────────────────────────────────────────

	#match(buf: string, i: number): Match {
		const n = buf.length;
		if (i + 1 >= n) return PARTIAL;
		const next = buf[i + 1]!;
		switch (next) {
			case "[":
				return this.#matchCsi(buf, i);
			case "O":
				return i + 2 < n ? { kind: "complete", end: i + 3 } : PARTIAL;
			case "]":
			case "P":
			case "_":
			case "^":
			case "X":
				return this.#matchString(buf, i);
			case ESC: {
				if (i + 2 >= n) return PARTIAL;
				const third = buf[i + 2];
				if (third !== "[" && third !== "O") return LONE;
				const inner = this.#match(buf, i + 1);
				if (inner.kind === "partial") return PARTIAL;
				if (inner.kind !== "complete") return LONE;
				// Meta-CSI is a key; an ESC before a mouse report or terminal report is the Escape key.
				return /^\x1b\[[<?>=M]/.test(buf.slice(i + 1, i + 4)) ? LONE : { kind: "complete", end: inner.end };
			}
			default: {
				const code = buf.charCodeAt(i + 1);
				if (code >= 0xd800 && code <= 0xdbff) return i + 2 < n ? { kind: "complete", end: i + 3 } : PARTIAL;
				return { kind: "complete", end: i + 2 };
			}
		}
	}

	#matchCsi(buf: string, i: number): Match {
		const n = buf.length;
		let k = i + 2;
		if (k >= n) return PARTIAL;
		// Legacy X10 mouse: CSI M plus three raw bytes.
		if (buf[k] === "M") return k + 3 < n ? { kind: "complete", end: k + 4 } : PARTIAL;
		// Linux console function keys: CSI [ A…E.
		if (buf[k] === "[") {
			if (k + 1 >= n) return PARTIAL;
			if (/[A-E]/.test(buf[k + 1]!)) return { kind: "complete", end: k + 2 };
			k++;
		}
		for (; k < n; k++) {
			const code = buf.charCodeAt(k);
			if (code >= 0x40 && code <= 0x7e) return { kind: "complete", end: k + 1 };
			if (code === 0x24) {
				// `$` is DECRPM's intermediate (`$y`) or rxvt's Shift suffix (`CSI 2 $`).
				if (k + 1 >= n) return PARTIAL;
				const following = buf.charCodeAt(k + 1);
				return { kind: "complete", end: following >= 0x40 && following <= 0x7e ? k + 2 : k + 1 };
			}
			if (code < 0x20 || code > 0x3f) return { kind: "complete", end: k };
			// Malformed run without a final byte: cut it so one read stays bounded.
			if (k - i >= this.#maxCsi) return { kind: "complete", end: k };
		}
		return PARTIAL;
	}

	#matchString(buf: string, i: number): Match {
		const n = buf.length;
		let k = i === 0 ? Math.max(2, this.#hint) : i + 2;
		for (;;) {
			const bel = buf.indexOf("\x07", k);
			const esc = buf.indexOf(ESC, k);
			if (bel >= 0 && (esc < 0 || bel < esc)) return { kind: "complete", end: bel + 1 };
			if (esc < 0) {
				k = n;
				break;
			}
			if (esc + 1 >= n) {
				k = esc;
				break;
			}
			if (buf[esc + 1] === "\\") return { kind: "complete", end: esc + 2 };
			return { kind: "unterminated", end: esc };
		}
		// Relative to the head, which the partial becomes once the buffer is trimmed to it.
		this.#hint = k - i;
		if (n - i > this.#maxString) return { kind: "overflow" };
		return PARTIAL;
	}

	// ── Scanning ──────────────────────────────────────────────────────────

	/** Consume complete sequences from the head of the buffer; `force` flushes a trailing partial too. */
	#scan(force: boolean): void {
		const buf = this.#buf;
		const n = buf.length;
		let i = 0;
		/** An Enter was delivered in this pass: the next key waits a turn (see {@link #pause}). */
		let entered = false;
		while (i < n) {
			// The terminal's own messages (frame acks) are no keys: they pass, the wait starts at the next key.
			if (entered && !TSP_OPENERS.some(opener => buf.startsWith(opener, i))) {
				if (this.#pause()) break;
				entered = false;
			}
			const code = buf.charCodeAt(i);
			if (code !== 0x1b) {
				let end = i + 1;
				if (code >= 0xd800 && code <= 0xdbff) {
					if (end >= n && !force) break;
					end = Math.min(n, i + 2);
				}
				this.#emitText(buf.slice(i, end));
				i = end;
				entered = code === 0x0d || code === 0x0a;
				continue;
			}
			const match = this.#match(buf, i);
			if (match.kind === "complete") {
				const seq = buf.slice(i, match.end);
				if (seq === PASTE_START) {
					this.#consumed();
					this.#buf = "";
					this.#hint = 0;
					this.#startPaste(buf.slice(match.end));
					return;
				}
				this.#emitSequence(seq);
				i = match.end;
				if (KITTY_ENTER.test(seq)) entered = true;
				continue;
			}
			if (match.kind === "lone") {
				this.#emitSequence(ESC);
				i++;
				continue;
			}
			if (match.kind === "unterminated") {
				i = this.#resolveStringHead(buf, i, match.end);
				continue;
			}
			if (match.kind === "overflow") {
				// Torn protocol data: drop it and swallow everything up to its own terminator.
				this.#discard = buf.endsWith(ESC) ? "esc" : "body";
				i = n;
				break;
			}
			if (!force) break;
			i = this.#forceHead(buf, i);
		}
		if (i > 0) {
			this.#consumed();
			this.#buf = buf.slice(i);
		}
		if (this.#buf === "") this.#hint = 0;
		// What waits behind an Enter is scanned when its turn comes: no partial timer runs on it.
		if (!this.#waiting) this.#armPartial();
	}

	/**
	 * An Enter was delivered with keys behind it in the same batch (one read, or keys gathered while
	 * its read was held): they wait for the next event-loop turn, so what the Enter opens in its
	 * handler's continuation (a selector, a dialog) is there to take the keys typed after it.
	 * Later reads queue behind them. Returns whether scanning stops here.
	 */
	#pause(): boolean {
		if (this.#draining) return false;
		this.#waiting = [];
		this.#cancelWaiting = this.#clock.schedule(0, () => {
			this.#cancelWaiting = null;
			this.#resume();
		});
		return true;
	}

	/** Deliver what waited behind an Enter: the rest of its batch, then the reads that arrived since. */
	#resume(): void {
		this.#cancelWaiting?.();
		this.#cancelWaiting = null;
		const reads = this.#waiting;
		if (!reads) return;
		this.#waiting = null;
		this.#scan(false);
		for (let i = 0; i < reads.length; i++) {
			// Another Enter in the rest: the remaining reads wait behind it in turn.
			if (this.#waiting) {
				(this.#waiting as string[]).push(...reads.slice(i));
				return;
			}
			this.process(reads[i]!);
		}
	}

	/** A string introducer that ended without a terminator: an Alt chord plus typing, or a torn reply. */
	#resolveStringHead(buf: string, i: number, end: number): number {
		if (replyLike(buf.slice(i, end)) === "yes") {
			this.#emitSequence(buf.slice(i, end));
			return end;
		}
		this.#emitSequence(buf.slice(i, i + 2));
		return i + 2;
	}

	/** Flush a partial head on timeout; returns where scanning resumes. */
	#forceHead(buf: string, i: number): number {
		const head = buf.slice(i);
		if (head.length <= 1 || head[1] === ESC) {
			this.#emitSequence(ESC);
			return i + 1;
		}
		const intro = head[1]!;
		if ("]P_^X".includes(intro)) {
			// Reply strings never become keys; anything else was an Alt chord plus typing.
			if (replyLike(head) === "yes") return buf.length;
			this.#emitSequence(head.slice(0, 2));
			return i + 2;
		}
		this.#emitSequence(head);
		return buf.length;
	}

	#consumed(): void {
		this.#str = null;
		this.#cancelAbandon?.();
		this.#cancelAbandon = null;
	}

	#armPartial(): void {
		this.#cancelPartial?.();
		this.#cancelPartial = null;
		const head = this.#buf;
		if (head === "") return;
		let timeout: number;
		if (head.length === 1) {
			timeout = head === ESC && this.kitty ? this.#reportTimeout : this.#keyTimeout;
		} else if (head[1] === ESC) {
			timeout = head.length === 2 ? this.#keyTimeout : this.#sequenceTimeout;
		} else if ("]P_^X".includes(head[1]!)) {
			const kind = replyLike(head);
			if (kind === "yes") {
				this.#trackString();
				return;
			}
			timeout = kind === "maybe" ? this.#sequenceTimeout : this.#keyTimeout;
		} else if (head[1] === "[") {
			if (head.length === 2) timeout = this.#keyTimeout;
			else
				timeout =
					"<?>=".includes(head[2]!) || IN_BAND_HEAD.test(head) ? this.#reportTimeout : this.#sequenceTimeout;
		} else {
			timeout = this.#keyTimeout;
		}
		this.#cancelPartial = this.#clock.schedule(
			timeout,
			this.win32 && (head === ESC || head[1] === "[")
				? () => {
						// An overdue timer can run before stdin delivers the rest of the record.
						this.#cancelPartial = this.#clock.schedule(0, this.#flushPartial);
					}
				: this.#flushPartial,
		);
	}

	readonly #flushPartial = (): void => {
		this.#cancelPartial = null;
		this.#scan(true);
	};

	#trackString(): void {
		if (!this.#str) this.#str = { lastRead: this.#clock.now(), suspects: [], resumed: false };
		this.#cancelAbandon?.();
		const deadline = this.#str.lastRead + this.#stringAbandonMs;
		this.#cancelAbandon = this.#clock.schedule(Math.max(0, deadline - this.#clock.now()), () => {
			this.#cancelAbandon = null;
			this.#abandonString(true);
		});
	}

	/** Give up on a stalled reply string: replay keys typed into it; optionally keep it dormant for a late tail. */
	#abandonString(dormant: boolean): void {
		const str = this.#str;
		const head = this.#buf;
		this.#consumed();
		this.#cancelPartial?.();
		this.#cancelPartial = null;
		this.#buf = "";
		this.#hint = 0;
		if (!str) return;
		let payload = head;
		for (let s = str.suspects.length - 1; s >= 0; s--) {
			const suspect = str.suspects[s]!;
			payload = payload.slice(0, suspect.at) + payload.slice(suspect.at + suspect.text.length);
		}
		if (dormant && !str.resumed) this.#dormant = { head: payload, until: this.#clock.now() + this.#stringDormantMs };
		for (const suspect of str.suspects) this.#emitSequence(suspect.text);
	}

	#feedDiscard(data: string): string | null {
		let from = 0;
		if (this.#discard === "esc") {
			if (data[0] === "\\") {
				this.#discard = null;
				return data.slice(1);
			}
		}
		for (;;) {
			const bel = data.indexOf("\x07", from);
			const esc = data.indexOf(ESC, from);
			if (bel >= 0 && (esc < 0 || bel < esc)) {
				this.#discard = null;
				return data.slice(bel + 1);
			}
			if (esc < 0) {
				this.#discard = "body";
				return null;
			}
			if (esc + 1 >= data.length) {
				this.#discard = "esc";
				return null;
			}
			if (data[esc + 1] === "\\") {
				this.#discard = null;
				return data.slice(esc + 2);
			}
			from = esc + 1;
		}
	}

	// ── Emission ──────────────────────────────────────────────────────────

	#emitSequence(seq: string): void {
		this.#inBandTail = 0;
		if (IN_BAND_BODY.test(seq)) {
			seq += "t";
			this.#inBandTail = this.#clock.now() || 1;
		}
		const kitty = /^\x1b\[(\d+)(?::(\d+))?(?:;([12]))?u$/.exec(seq);
		if (kitty) {
			const cp = Number(kitty[3] === "2" && kitty[2] ? kitty[2] : kitty[1]);
			this.#dedup =
				cp >= 0x20 && cp < 0xe000 && cp !== 0x7f ? { ch: String.fromCodePoint(cp), at: this.#clock.now() } : null;
		} else {
			this.#dedup = null;
		}
		this.#sink.sequence(seq);
	}

	#emitText(ch: string): void {
		const tail = this.#inBandTail;
		this.#inBandTail = 0;
		if (ch === "t" && tail !== 0 && this.#clock.now() - tail <= IN_BAND_TERMINATOR_GRACE_MS) return;
		const dedup = this.#dedup;
		this.#dedup = null;
		// Some terminals report a kitty printable twice: CSI u and then the bare character.
		if (dedup && dedup.ch === ch && this.#clock.now() - dedup.at <= this.#dedupWindow) return;
		this.#sink.sequence(ch);
	}

	// ── Raw multi-line bursts ─────────────────────────────────────────────

	/** Returns whether the read was taken by burst handling. */
	#feedBurst(data: string): boolean {
		if (data.includes(ESC)) {
			if (this.#burst === "") return false;
			// An escape sequence is no part of a paste: the held keys and this read go on as one batch.
			this.#cancelBurst?.();
			this.#cancelBurst = null;
			const held = this.#burst;
			this.#burst = "";
			this.#append(held + data);
			return true;
		}
		if (this.#burst === "" && !/[\r\n]/.test(data)) return false;
		this.#burst += data;
		// A blocked loop batches typed keys into one read: those are keys, and are not held further.
		if (this.isStalled?.()) {
			this.#releaseBurst();
			return true;
		}
		if (!isMultilineBurst(this.#burst)) {
			// One fixed window from the first break-bearing read: an ordinary Enter replays unchanged when it ends.
			this.#cancelBurst ??= this.#clock.schedule(this.#burstTimeout, () => {
				this.#cancelBurst = null;
				this.#releaseBurst();
			});
			return true;
		}
		const paste = this.#burst;
		this.#cancelBurst?.();
		this.#cancelBurst = null;
		this.#burst = "";
		if (endsWithTypedEnter(paste)) {
			this.#sink.paste(paste.slice(0, -1));
			this.#emitSequence("\r");
		} else this.#sink.paste(paste);
		return true;
	}

	#releaseBurst(): void {
		this.#cancelBurst?.();
		this.#cancelBurst = null;
		const held = this.#burst;
		this.#burst = "";
		if (held) this.#append(held);
	}

	// ── Bracketed paste ───────────────────────────────────────────────────

	#startPaste(rest: string): void {
		this.#paste = { chunks: [], bytes: 0, pending: "" };
		this.#armPasteWatchdog();
		if (rest) this.#feedPaste(rest);
	}

	#armPasteWatchdog(): void {
		this.#cancelPasteWatchdog?.();
		this.#cancelPasteWatchdog = this.#clock.schedule(this.#pasteTimeout, () => {
			this.#cancelPasteWatchdog = null;
			this.#endPaste("");
		});
	}

	#feedPaste(data: string): void {
		const paste = this.#paste!;
		const text = paste.pending + data;
		paste.pending = "";
		let grew = false;
		const add = (part: string): void => {
			if (!part) return;
			paste.chunks.push(part);
			paste.bytes += Buffer.byteLength(part, "utf8");
			grew = true;
		};
		let i = 0;
		while (i < text.length) {
			const k = text.indexOf(ESC, i);
			if (k < 0) {
				add(text.slice(i));
				break;
			}
			add(text.slice(i, k));
			if (text.startsWith(PASTE_END, k)) {
				this.#endPaste(text.slice(k + PASTE_END.length));
				return;
			}
			if (text.startsWith(PASTE_START, k)) {
				i = k + PASTE_START.length;
				continue;
			}
			const opener = TSP_OPENERS.find(prefix => text.startsWith(prefix, k));
			if (opener) {
				// Terminal messages keep flowing while a paste is open; route them out of its content.
				const end = this.#stringEnd(text, k + opener.length);
				if (end < 0) {
					paste.pending = text.slice(k);
					break;
				}
				this.#emitSequence(text.slice(k, end));
				i = end;
				continue;
			}
			const tail = text.slice(k);
			if ([PASTE_END, PASTE_START, ...TSP_OPENERS].some(prefix => prefix.startsWith(tail))) {
				paste.pending = tail;
				break;
			}
			add(ESC);
			i = k + 1;
		}
		if (paste.bytes > this.#pasteByteLimit) {
			this.#endPaste("");
			return;
		}
		if (grew) this.#armPasteWatchdog();
	}

	#stringEnd(text: string, from: number): number {
		const bel = text.indexOf("\x07", from);
		const st = text.indexOf("\x1b\\", from);
		if (bel >= 0 && (st < 0 || bel < st)) return bel + 1;
		return st < 0 ? -1 : st + 2;
	}

	#endPaste(rest: string): void {
		const paste = this.#paste;
		if (!paste) return;
		this.#paste = null;
		this.#cancelPasteWatchdog?.();
		this.#cancelPasteWatchdog = null;
		this.#sink.paste(paste.chunks.join(""), true);
		// An unfinished TSP message stays on the report path; a partial end marker is dropped.
		const pending = TSP_OPENERS.some(prefix => paste.pending.startsWith(prefix)) ? paste.pending : "";
		const after = pending + rest;
		if (after) this.#append(after);
	}
}
