/**
 * Decode Windows console win32-input-mode key records into the key sequences
 * the rest of the TUI already understands.
 *
 * Hosts without the kitty keyboard protocol (Windows Terminal before 1.25)
 * deliver Shift+Enter as a bare `\r` (indistinguishable from Enter) and
 * Ctrl+Enter as `\n`. Enabling `CSI ? 9001 h` makes the console host serving
 * this process report every key as `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`, which
 * carries the full modifier state. Mouse reports and terminal replies keep
 * arriving as plain VT. Pasted text mostly does too, but the console host
 * re-encodes some pasted characters (line breaks) as key records inside the
 * bracketed paste; {@link Win32InputModeDecoder.decodePaste} turns those back
 * into text.
 *
 * Unmodified and legacy-expressible keys translate to the bytes a legacy
 * terminal sends; chords legacy encoding loses (modified Enter/Tab/Escape,
 * Ctrl+Shift+letter, …) translate to kitty CSI-u, which key matching already
 * parses.
 */

const W32IM_PATTERN = /^\x1b\[([\d;]*)_$/;
const W32IM_RECORDS = /\x1b\[[\d;]*_/g;

const RIGHT_ALT_PRESSED = 0x0001;
const LEFT_ALT_PRESSED = 0x0002;
const RIGHT_CTRL_PRESSED = 0x0004;
const LEFT_CTRL_PRESSED = 0x0008;
const SHIFT_PRESSED = 0x0010;

const VK_BACK = 0x08;
const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const VK_MENU = 0x12;
const VK_ESCAPE = 0x1b;
const VK_SPACE = 0x20;
const VK_PACKET = 0xe7;

/** Modifier and lock keys: their own presses produce no input. */
const MODIFIER_VKS = new Set([
	0x10, // VK_SHIFT
	0x11, // VK_CONTROL
	0x12, // VK_MENU
	0x14, // VK_CAPITAL
	0x5b, // VK_LWIN
	0x5c, // VK_RWIN
	0x90, // VK_NUMLOCK
	0x91, // VK_SCROLL
	0xa0, // VK_LSHIFT
	0xa1, // VK_RSHIFT
	0xa2, // VK_LCONTROL
	0xa3, // VK_RCONTROL
	0xa4, // VK_LMENU
	0xa5, // VK_RMENU
]);

/** Cursor keys: legacy `CSI <final>`, modified `CSI 1 ; <mod> <final>`. */
const CURSOR_FINALS = new Map<number, string>([
	[0x23, "F"], // VK_END
	[0x24, "H"], // VK_HOME
	[0x25, "D"], // VK_LEFT
	[0x26, "A"], // VK_UP
	[0x27, "C"], // VK_RIGHT
	[0x28, "B"], // VK_DOWN
	[0x70, "P"], // VK_F1 (legacy SS3)
	[0x71, "Q"], // VK_F2
	[0x72, "R"], // VK_F3
	[0x73, "S"], // VK_F4
]);
const SS3_VKS = new Set([0x70, 0x71, 0x72, 0x73]);

/** Tilde keys: `CSI <n> ~`, modified `CSI <n> ; <mod> ~`. */
const TILDE_CODES = new Map<number, number>([
	[0x21, 5], // VK_PRIOR
	[0x22, 6], // VK_NEXT
	[0x2d, 2], // VK_INSERT
	[0x2e, 3], // VK_DELETE
	[0x74, 15], // VK_F5
	[0x75, 17], // VK_F6
	[0x76, 18], // VK_F7
	[0x77, 19], // VK_F8
	[0x78, 20], // VK_F9
	[0x79, 21], // VK_F10
	[0x7a, 23], // VK_F11
	[0x7b, 24], // VK_F12
]);

interface KeyRecord {
	vk: number;
	uc: number;
	down: boolean;
	state: number;
	repeat: number;
}

function parseRecord(data: string): KeyRecord | undefined {
	const match = W32IM_PATTERN.exec(data);
	if (!match) return undefined;
	const params = match[1]!.split(";");
	if (params.length > 6) return undefined;
	const at = (index: number, fallback: number): number => {
		const raw = params[index];
		return raw ? Number.parseInt(raw, 10) : fallback;
	};
	return { vk: at(0, 0), uc: at(2, 0), down: at(3, 0) === 1, state: at(4, 0), repeat: Math.max(1, at(5, 1)) };
}

/** Lowercase codepoint a letter/digit virtual key stands for, or 0. */
function baseCodepointForVk(vk: number): number {
	if (vk >= 0x41 && vk <= 0x5a) return vk + 0x20;
	if (vk >= 0x30 && vk <= 0x39) return vk;
	return 0;
}

function encodeKey(record: KeyRecord): string | null {
	const { vk, uc, state } = record;
	const shift = (state & SHIFT_PRESSED) !== 0;
	const alt = (state & (LEFT_ALT_PRESSED | RIGHT_ALT_PRESSED)) !== 0;
	const ctrl = (state & (LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED)) !== 0;
	const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
	const text = uc === 0 ? "" : String.fromCharCode(uc);

	switch (vk) {
		case VK_RETURN:
			return mod === 1 ? "\r" : `\x1b[13;${mod}u`;
		case VK_TAB:
			if (mod === 1) return "\t";
			return mod === 2 ? "\x1b[Z" : `\x1b[9;${mod}u`;
		case VK_BACK:
			if (mod === 1) return "\x7f";
			return mod === 3 ? "\x1b\x7f" : `\x1b[127;${mod}u`;
		case VK_ESCAPE:
			return mod === 1 ? "\x1b" : `\x1b[27;${mod}u`;
		case VK_SPACE:
			if (!ctrl && !alt) return " ";
			return `\x1b[32;${mod}u`;
	}

	const cursorFinal = CURSOR_FINALS.get(vk);
	if (cursorFinal !== undefined) {
		if (mod !== 1) return `\x1b[1;${mod}${cursorFinal}`;
		return SS3_VKS.has(vk) ? `\x1bO${cursorFinal}` : `\x1b[${cursorFinal}`;
	}
	const tildeCode = TILDE_CODES.get(vk);
	if (tildeCode !== undefined) {
		return mod === 1 ? `\x1b[${tildeCode}~` : `\x1b[${tildeCode};${mod}~`;
	}

	// AltGr arrives as Right Alt + Left Ctrl; when it composed printable text,
	// that text is the input.
	const altGr = (state & RIGHT_ALT_PRESSED) !== 0 && (state & LEFT_CTRL_PRESSED) !== 0;
	if (altGr && uc >= 0x20 && uc !== 0x7f) return text;

	const base = baseCodepointForVk(vk);
	if (ctrl) {
		// Ctrl+Shift+letter collapses onto Ctrl+letter in legacy bytes; keep it distinct.
		if ((shift || uc === 0) && base !== 0) return `\x1b[${base};${mod}u`;
		if (uc === 0) return null;
		return alt ? `\x1b${text}` : text;
	}
	if (alt) {
		if (uc !== 0) return `\x1b${text}`;
		return base !== 0 ? `\x1b${String.fromCharCode(base)}` : null;
	}
	// Plain or shifted key; Uc 0 is a dead key whose composed text arrives with the next key.
	return uc === 0 ? null : text;
}

/** Stateful decoder: joins UTF-16 surrogate halves that arrive as separate records. */
export class Win32InputModeDecoder {
	#pendingHighSurrogate = 0;

	/**
	 * Translate one stdin sequence. Returns `undefined` when `data` is not a
	 * win32-input-mode record (pass it through unchanged), otherwise the key
	 * events it produces — empty for key releases and bare modifier presses.
	 */
	decode(data: string): string[] | undefined {
		const record = parseRecord(data);
		if (!record) return undefined;

		if (!record.down) {
			// Alt+Numpad composition delivers its character on the Alt release.
			if (record.vk === VK_MENU && record.uc !== 0) return this.#emitText(record.uc);
			return [];
		}
		if (MODIFIER_VKS.has(record.vk)) return [];
		if (record.vk === 0 || record.vk === VK_PACKET) return this.#emitText(record.uc, record.repeat);
		if (record.uc >= 0xd800 && record.uc <= 0xdfff) return this.#emitText(record.uc);

		this.#pendingHighSurrogate = 0;
		const encoded = encodeKey(record);
		if (encoded === null) return [];
		return Array.from({ length: record.repeat }, () => encoded);
	}

	/**
	 * Replace the key records embedded in bracketed paste `content` with the
	 * text they type, so a pasted line break stays a line break instead of
	 * acting as Enter. Key-downs yield their character (`\r` for Enter);
	 * releases and keys without text yield nothing. Text that merely looks like
	 * a record without ESC is left alone.
	 */
	decodePaste(content: string): string {
		if (!content.includes("\x1b[")) return content;
		this.#pendingHighSurrogate = 0;
		const decoded = content.replace(W32IM_RECORDS, match => {
			const record = parseRecord(match);
			if (!record) return match;
			if (!record.down) return "";
			return this.#emitText(record.uc, record.repeat).join("");
		});
		this.#pendingHighSurrogate = 0;
		return decoded;
	}

	#emitText(codeUnit: number, repeat = 1): string[] {
		if (codeUnit === 0) return [];
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			this.#pendingHighSurrogate = codeUnit;
			return [];
		}
		let text = String.fromCharCode(codeUnit);
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			if (this.#pendingHighSurrogate === 0) return [];
			text = String.fromCharCode(this.#pendingHighSurrogate, codeUnit);
		}
		this.#pendingHighSurrogate = 0;
		return Array.from({ length: repeat }, () => text);
	}
}

const RECORD_AT_START = /^\x1b\[[\d;]*_/;
const RECORD_PREFIX = /^\x1b\[[\d;]*$/;
const MAX_RECORD_LENGTH = 64;

/**
 * Restores paste delimiters that a Windows console host emitted as individual
 * win32-input-mode key records before StdinBuffer searches for the delimiters.
 * Non-matching records remain untouched for normal key and paste decoding.
 */
export class Win32PasteMarkerNormalizer {
	#pending = "";
	#candidate = "";
	#index = 0;
	#marker = "";
	#timer?: NodeJS.Timeout;
	readonly #onInput: (data: string) => void;

	constructor(onInput: (data: string) => void) {
		this.#onInput = onInput;
	}

	process(data: string): void {
		if (!this.#pending && !this.#candidate && !data.includes("\x1b")) {
			this.#onInput(data);
			return;
		}
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending += data;
		let output = "";

		while (this.#pending.length > 0) {
			const escape = this.#pending.indexOf("\x1b");
			if (escape > 0) {
				output += this.#candidate + this.#pending.slice(0, escape);
				this.#candidate = "";
				this.#index = 0;
				this.#pending = this.#pending.slice(escape);
			} else if (escape === -1) {
				output += this.#candidate + this.#pending;
				this.#candidate = "";
				this.#index = 0;
				this.#pending = "";
				break;
			}

			if (this.#pending.length === 1) break;
			if (this.#pending[1] !== "[") {
				output += this.#candidate + this.#pending[0];
				this.#candidate = "";
				this.#index = 0;
				this.#pending = this.#pending.slice(1);
				continue;
			}
			const record = RECORD_AT_START.exec(this.#pending)?.[0];
			if (!record) {
				if (this.#pending.length <= MAX_RECORD_LENGTH && RECORD_PREFIX.test(this.#pending)) break;
				output += this.#candidate + this.#pending[0];
				this.#candidate = "";
				this.#index = 0;
				this.#pending = this.#pending.slice(1);
				continue;
			}

			this.#pending = this.#pending.slice(record.length);
			const key = parseRecord(record);
			if (this.#candidate && key && !key.down) {
				this.#candidate += record;
				continue;
			}
			if (key?.down && key.state === 0 && key.repeat === 1) {
				const expected = this.#index === 0 ? 27 : "[200~".charCodeAt(this.#index - 1);
				if (key.uc === expected || (this.#index === 4 && key.uc === 49)) {
					if (this.#index === 4) this.#marker = String.fromCharCode(key.uc);
					this.#candidate += record;
					if (++this.#index === 6) {
						output += `\x1b[20${this.#marker}~`;
						this.#candidate = "";
						this.#index = 0;
					}
					continue;
				}
			}
			output += this.#candidate;
			this.#candidate = "";
			this.#index = 0;
			if (key?.down && key.state === 0 && key.repeat === 1 && key.uc === 27) {
				this.#candidate = record;
				this.#index = 1;
			} else {
				output += record;
			}
		}

		if (output) this.#onInput(output);
		if (this.#candidate || this.#pending) this.#timer = setTimeout(() => this.flush(), 75);
	}

	/** Release an incomplete marker as its original key records. */
	flush(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const raw = this.#candidate + this.#pending;
		this.#candidate = "";
		this.#pending = "";
		this.#index = 0;
		if (raw) this.#onInput(raw);
	}
}
