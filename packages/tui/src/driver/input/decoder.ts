/**
 * The stdin decoder: raw reads in, {@link InputEvent}s and
 * {@link TerminalReply}s out. Replies never reach the input listeners.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { InputEvent } from "../contract";
import { decodeKey } from "./keys";
import { decodeMouse, isSgrMouseReport, type SgrPixelGeometry } from "./mouse";
import { parseReply, type TerminalReply } from "./replies";
import { InputTokenizer, type TokenizerOptions, type TokenSink } from "./tokenizer";
import { parseTspMessage } from "./tsp";
import { isWin32Record, Win32RecordDecoder } from "./win32";

export interface DecoderSink {
	input(event: InputEvent): void;
	reply(reply: TerminalReply): void;
}

export interface InputDecoderOptions extends TokenizerOptions {
	/** Raw 0x08 is Ctrl+Backspace (see `rawBackspaceIsCtrl`). */
	readonly backspaceIsCtrl?: boolean;
}

export class InputDecoder {
	/** A cursor position request is outstanding: `CSI r ; c R` is its answer, not Ctrl/Shift+F3. */
	cprPending = false;
	/** SGR-pixel reporting (DECSET 1016) is on: SGR mouse reports are in pixels of this geometry. */
	pixelMouse: SgrPixelGeometry | null = null;

	readonly #sink: DecoderSink;
	readonly #main: InputTokenizer;
	readonly #relay: InputTokenizer;
	readonly #records = new Win32RecordDecoder();
	readonly #backspaceIsCtrl: boolean;
	#kitty = false;
	#processing = false;
	/** Inside {@link process} (both streams): a paste there marks the key after it. */
	#reading = false;
	/** A paste was decoded earlier in this read and no key followed it yet. */
	#afterPaste = false;
	#recordBytes = "";

	constructor(sink: DecoderSink, options: InputDecoderOptions = {}) {
		this.#sink = sink;
		this.#backspaceIsCtrl = options.backspaceIsCtrl ?? false;
		const paste = (text: string): void => {
			this.#sink.input({ type: "paste", paste: { text } });
			this.#afterPaste = this.#reading;
		};
		const tokens: TokenSink = {
			sequence: seq => this.#classify(seq, true),
			paste: text => {
				this.#flushRecords();
				paste(text);
			},
		};
		const relayed: TokenSink = {
			sequence: seq => this.#classify(seq, false),
			paste,
		};
		this.#main = new InputTokenizer(tokens, options);
		this.#relay = new InputTokenizer(relayed, options);
	}

	get kitty(): boolean {
		return this.#kitty;
	}

	set kitty(active: boolean) {
		this.#kitty = active;
		this.#main.kitty = active;
		this.#relay.kitty = active;
	}

	/** win32-input-mode is on: key records are decoded and their bytes re-tokenized. */
	get win32(): boolean {
		return this.#main.win32;
	}

	set win32(active: boolean) {
		this.#main.win32 = active;
	}

	set isStalled(probe: (() => boolean) | undefined) {
		this.#main.isStalled = probe;
		this.#relay.isStalled = probe;
	}

	/** The partial sequence held for the next read (main stream). */
	get pending(): string {
		return this.#main.pending;
	}

	/** A bracketed paste is open on the main stream. */
	get inPaste(): boolean {
		return this.#main.inPaste;
	}

	process(chunk: string | Uint8Array): void {
		this.#reading = true;
		try {
			this.#processing = true;
			try {
				this.#main.process(chunk);
			} finally {
				this.#processing = false;
			}
			this.#flushRecords();
		} finally {
			this.#reading = false;
			this.#afterPaste = false;
		}
	}

	flush(): void {
		this.#main.flush();
		this.#relay.flush();
	}

	clear(): void {
		this.#main.clear();
		this.#relay.clear();
		this.#recordBytes = "";
	}

	#flushRecords(): void {
		const bytes = this.#recordBytes;
		this.#recordBytes = "";
		// Keep consecutive records together until the read ends or direct input must follow them.
		if (bytes) this.#relay.process(bytes);
	}

	#classify(seq: string, direct: boolean): void {
		if (direct && this.win32 && isWin32Record(seq)) {
			this.#recordBytes += this.#records.decode(seq);
			if (!this.#processing) this.#flushRecords();
			return;
		}
		if (direct) this.#flushRecords();
		const tsp = parseTspMessage(seq);
		if (tsp) {
			this.#sink.input({
				type: "tsp",
				verb: tsp.verb,
				params: tsp.params,
				body: tsp.body,
			});
			return;
		}
		if (seq === "\x1b[I" || seq === "\x1b[O") {
			this.#sink.input({ type: "focus", focused: seq === "\x1b[I" });
			return;
		}
		const mouse = decodeMouse(seq, this.pixelMouse);
		if (mouse) {
			this.#sink.input({ type: "mouse", mouse });
			return;
		}
		// Kitty's pointer leave (and an out-of-window cell report): mouse framing, but no event.
		if (isSgrMouseReport(seq)) return;
		const reply = parseReply(seq, this.cprPending);
		if (reply) {
			this.#sink.reply(reply);
			return;
		}
		const key = decodeKey(seq, {
			kitty: this.#kitty,
			backspaceIsCtrl: this.#backspaceIsCtrl,
		});
		if (key) {
			const afterPaste = this.#afterPaste;
			this.#afterPaste = false;
			this.#sink.input({
				type: "key",
				key: afterPaste ? { ...key, afterPaste: true } : key,
			});
			return;
		}
		logger.debug("dropped unrecognized input sequence", {
			seq: JSON.stringify(seq),
		});
	}
}

/**
 * Decode raw terminal bytes held in full (an input listener's rewrite) into input events at once:
 * partial sequences are flushed, terminal replies dropped. `kitty`: the keyboard protocol is on.
 */
export function decodeInput(data: string, options: { readonly kitty?: boolean } = {}): InputEvent[] {
	const events: InputEvent[] = [];
	const decoder = new InputDecoder({
		input: event => events.push(event),
		reply: () => {},
	});
	decoder.kitty = options.kitty ?? false;
	decoder.process(data);
	decoder.flush();
	decoder.clear();
	return events;
}
