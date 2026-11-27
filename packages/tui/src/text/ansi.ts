/**
 * Escape-sequence tokenizing and SGR state tracking for styled terminal text.
 *
 * Every complete escape sequence is one zero-width token: CSI, OSC (BEL or ST
 * terminated), APC/SOS/PM strings, DCS strings (including tmux passthrough,
 * whose payload doubles every ESC) and two/three-byte escapes. An incomplete
 * sequence is not an escape; its bytes stay ordinary text.
 */

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;

/** Length of the complete escape sequence starting at `at`, or 0 when there is none. */
export function escapeLength(text: string, at: number): number {
	if (text.charCodeAt(at) !== ESC) return 0;
	const kind = text.charCodeAt(at + 1);
	switch (kind) {
		case 0x5b: // CSI: parameters, intermediates, final byte
			return csiLength(text, at);
		case 0x5d: // OSC
		case 0x5f: // APC
		case 0x58: // SOS
		case 0x5e: // PM
			return stringLength(text, at, true);
		case 0x50: // DCS (tmux passthrough doubles the ESCs it wraps)
			return stringLength(text, at, false);
		default: {
			if (Number.isNaN(kind)) return 0;
			let i = at + 1;
			while (i < text.length && isIntermediate(text.charCodeAt(i))) i++;
			const final = text.charCodeAt(i);
			return final >= 0x30 && final <= 0x7e ? i + 1 - at : 0;
		}
	}
}

function isIntermediate(code: number): boolean {
	return code >= 0x20 && code <= 0x2f;
}

function csiLength(text: string, at: number): number {
	let i = at + 2;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code >= 0x30 && code <= 0x3f) i++;
		else break;
	}
	while (i < text.length && isIntermediate(text.charCodeAt(i))) i++;
	const final = text.charCodeAt(i);
	return final >= 0x40 && final <= 0x7e ? i + 1 - at : 0;
}

/** A control string ended by ST (`ESC \`), or BEL when `bel`; a doubled ESC inside is payload. */
function stringLength(text: string, at: number, bel: boolean): number {
	for (let i = at + 2; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (bel && code === BEL) return i + 1 - at;
		if (code !== ESC) continue;
		const next = text.charCodeAt(i + 1);
		if (next === BACKSLASH) return i + 2 - at;
		if (next === ESC && !bel) {
			i++;
			continue;
		}
		return 0;
	}
	return 0;
}

/** One escape sequence or one run of text between escapes. */
export interface Token {
	readonly text: string;
	readonly escape: boolean;
}

/** Split styled text into escape sequences and the text runs between them. */
export function tokens(text: string): Token[] {
	const out: Token[] = [];
	let start = 0;
	for (let i = text.indexOf("\x1b"); i !== -1; i = text.indexOf("\x1b", i)) {
		const length = escapeLength(text, i);
		if (length === 0) {
			i++;
			continue;
		}
		if (i > start) out.push({ text: text.slice(start, i), escape: false });
		out.push({ text: text.slice(i, i + length), escape: true });
		i += length;
		start = i;
	}
	if (start < text.length) out.push({ text: text.slice(start), escape: false });
	return out;
}

/** `text` without any complete escape sequence. */
export function stripEscapes(text: string): string {
	let out = "";
	let start = 0;
	for (let i = text.indexOf("\x1b"); i !== -1; i = text.indexOf("\x1b", i)) {
		const length = escapeLength(text, i);
		if (length === 0) {
			i++;
			continue;
		}
		if (i > start) out += text.slice(start, i);
		i += length;
		start = i;
	}
	return start === 0 ? text : out + text.slice(start);
}

/** Parameters of an SGR sequence (`ESC [ … m`), or undefined for any other token. */
export function sgrParams(sequence: string): string | undefined {
	return sequence.length >= 3 && sequence.startsWith("\x1b[") && sequence.endsWith("m")
		? sequence.slice(2, -1)
		: undefined;
}

/** Attribute SGR codes (bold, faint, italic, underline, blink, inverse, hidden, strike, overline). */
const ATTRIBUTE_CODES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 7, 8, 9, 53]);

/** Attribute-off codes with the attribute code each turns off (22 is handled apart: it ends both 1 and 2). */
const ATTRIBUTE_ON: Readonly<Record<number, number>> = { 23: 3, 24: 4, 25: 5, 27: 7, 28: 8, 29: 9, 55: 53 };

/**
 * The SGR state in effect after a run of styled text: foreground, background,
 * underline color and attributes, each as the SGR parameters that set it.
 */
export class SgrState {
	#fg: string | undefined;
	#bg: string | undefined;
	#underlineColor: string | undefined;
	readonly #attributes = new Set<number>();

	/** Apply every SGR sequence in `text`. */
	feed(text: string): this {
		if (!text.includes("\x1b[")) return this;
		for (const token of tokens(text)) {
			if (!token.escape) continue;
			const params = sgrParams(token.text);
			if (params !== undefined) this.apply(params);
		}
		return this;
	}

	/** Apply the parameters of one SGR sequence. */
	apply(params: string): void {
		const parts = params.split(";");
		for (let i = 0; i < parts.length; i++) {
			const raw = parts[i]!;
			if (raw.includes(":")) {
				const head = Number(raw.slice(0, raw.indexOf(":")));
				if (head === 38) this.#fg = raw;
				else if (head === 48) this.#bg = raw;
				else if (head === 58) this.#underlineColor = raw;
				else if (head === 4) {
					const sub = Number(raw.slice(raw.indexOf(":") + 1));
					if (sub === 0) this.#attributes.delete(4);
					else this.#attributes.add(4);
				}
				continue;
			}
			const code = raw === "" ? 0 : Number(raw);
			if (code === 0) this.reset();
			else if (code === 38 || code === 48 || code === 58) {
				const mode = parts[i + 1];
				const extra = mode === "5" ? 2 : mode === "2" ? 4 : 0;
				if (extra === 0 || i + extra >= parts.length) break;
				const value = parts.slice(i, i + extra + 1).join(";");
				if (code === 38) this.#fg = value;
				else if (code === 48) this.#bg = value;
				else this.#underlineColor = value;
				i += extra;
			} else if (code === 39) this.#fg = undefined;
			else if (code === 49) this.#bg = undefined;
			else if (code === 59) this.#underlineColor = undefined;
			else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.#fg = raw;
			else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.#bg = raw;
			else if (ATTRIBUTE_CODES.has(code)) this.#attributes.add(code);
			else if (code === 21) this.#attributes.delete(4);
			else if (code === 22) {
				this.#attributes.delete(1);
				this.#attributes.delete(2);
			} else if (ATTRIBUTE_ON[code] !== undefined) this.#attributes.delete(ATTRIBUTE_ON[code]);
		}
	}

	reset(): void {
		this.#fg = undefined;
		this.#bg = undefined;
		this.#underlineColor = undefined;
		this.#attributes.clear();
	}

	/** No color or attribute is active. */
	get plain(): boolean {
		return (
			this.#fg === undefined &&
			this.#bg === undefined &&
			this.#underlineColor === undefined &&
			this.#attributes.size === 0
		);
	}

	/** The SGR that sets the active background, or undefined when none is. */
	get background(): string | undefined {
		return this.#bg === undefined ? undefined : `\x1b[${this.#bg}m`;
	}

	/** Whether active SGR styling visibly paints a blank space cell (background, inverse, underline, strike, or overline). */
	get paintsBlank(): boolean {
		return (
			this.#bg !== undefined ||
			this.#attributes.has(4) ||
			this.#attributes.has(7) ||
			this.#attributes.has(9) ||
			this.#attributes.has(53)
		);
	}

	/** One SGR sequence re-establishing the whole state ("" when plain). */
	open(): string {
		const params: string[] = [...this.#attributes].sort((a, b) => a - b).map(String);
		if (this.#fg !== undefined) params.push(this.#fg);
		if (this.#bg !== undefined) params.push(this.#bg);
		if (this.#underlineColor !== undefined) params.push(this.#underlineColor);
		return params.length === 0 ? "" : `\x1b[${params.join(";")}m`;
	}
}
