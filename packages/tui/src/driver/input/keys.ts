/**
 * Key decoding: one complete input sequence → a canonical {@link KeyEvent}.
 *
 * Ids are the keybinding chord format (docs/keybindings.md): modifiers in
 * `ctrl+alt+shift+super` order, then the key name — a lowercase letter, a
 * digit or symbol, or one of `escape enter tab space backspace delete insert
 * clear home end pageUp pageDown up down left right f1…f35`. An uppercase
 * letter is `shift+<letter>` (its `text` keeps the uppercase character);
 * other shifted symbols are the symbol itself (`!`, not `shift+1`).
 *
 * Encodings: legacy bytes, ESC-prefixed Alt chords, SS3, xterm CSI with
 * modifier parameters, rxvt `$`/`^` suffixes, the Linux console, xterm
 * modifyOtherKeys (`CSI 27;mod;cp ~`), and the kitty keyboard protocol
 * (`CSI cp:shifted:base ; mods:event ; text u`) with event types and
 * keypad/functional codepoints.
 */
import type { KeyEvent } from "../../events";

export interface KeyDecodeContext {
	/** The kitty keyboard protocol is active: legacy ESC+B/F cursor aliases are real Alt chords. */
	readonly kitty: boolean;
	/** Raw 0x08 is Ctrl+Backspace (Windows Terminal), see `rawBackspaceIsCtrl`. */
	readonly backspaceIsCtrl: boolean;
}

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const SUPER = 8;
const HYPER = 16;
const META = 32;
const LOCKS = 64 | 128;

/** Canonical chord for a modifier mask and key name. */
export function keyId(mask: number, key: string): string {
	let id = "";
	if (mask & CTRL) id += "ctrl+";
	if (mask & ALT) id += "alt+";
	if (mask & SHIFT) id += "shift+";
	if (mask & SUPER) id += "super+";
	return id + key;
}

function event(id: string, raw: string, kind: KeyEvent["kind"] = "press", text?: string): KeyEvent {
	return text === undefined ? { id, kind, raw } : { id, kind, raw, text };
}

/** A printable character typed without modifiers. */
function printable(ch: string, raw: string, mask = 0, kind: KeyEvent["kind"] = "press"): KeyEvent {
	if (ch === " ") return event(keyId(mask, "space"), raw, kind, mask & ~SHIFT ? undefined : " ");
	const lower = ch.toLowerCase();
	const isUpperLetter = ch !== lower && /^[A-Z]$/.test(ch);
	const key = isUpperLetter ? lower : ch;
	const fullMask = isUpperLetter ? mask | SHIFT : mask;
	return event(keyId(fullMask, key), raw, kind, mask & ~SHIFT ? undefined : ch);
}

function controlByte(code: number, ctx: KeyDecodeContext): string | null {
	switch (code) {
		case 0x1b:
			return "escape";
		case 0x09:
			return "tab";
		case 0x0d:
		case 0x0a:
			return "enter";
		case 0x00:
			return "ctrl+space";
		case 0x7f:
			return "backspace";
		case 0x08:
			return ctx.backspaceIsCtrl ? "ctrl+backspace" : "backspace";
		case 28:
			return "ctrl+\\";
		case 29:
			return "ctrl+]";
		case 30:
			return "ctrl+^";
		case 31:
			return "ctrl+_";
	}
	if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
	return null;
}

function singleChar(seq: string, ctx: KeyDecodeContext): KeyEvent | null {
	const code = seq.codePointAt(0)!;
	if (code < 0x20 || code === 0x7f) {
		const id = controlByte(code, ctx);
		return id ? event(id, seq) : null;
	}
	if (code >= 0x80 && code < 0xa0) return null;
	return printable(seq, seq);
}

function altChord(seq: string, ctx: KeyDecodeContext): KeyEvent | null {
	const rest = seq.slice(1);
	const code = rest.codePointAt(0)!;
	switch (code) {
		case 0x7f:
		case 0x08:
			return event("alt+backspace", seq);
		case 0x0d:
		case 0x0a:
			return event("alt+enter", seq);
		case 0x09:
			return event("alt+tab", seq);
		case 0x20:
			return event("alt+space", seq);
		case 0x00:
			return event("ctrl+alt+space", seq);
	}
	// Historical cursor aliases of legacy terminals; under the kitty protocol ESC+B/F are real chords.
	if (!ctx.kitty && rest === "B") return event("alt+left", seq);
	if (!ctx.kitty && rest === "F") return event("alt+right", seq);
	if (code >= 1 && code <= 26) return event(`ctrl+alt+${String.fromCharCode(code + 96)}`, seq);
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return null;
	return printable(rest, seq, ALT);
}

const SS3_KEYS: Readonly<Record<string, string>> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	E: "clear",
	P: "f1",
	Q: "f2",
	R: "f3",
	S: "f4",
	M: "enter",
	a: "ctrl+up",
	b: "ctrl+down",
	c: "ctrl+right",
	d: "ctrl+left",
	e: "ctrl+clear",
	// Keypad in application mode.
	j: "*",
	k: "+",
	m: "-",
	n: ".",
	o: "/",
	X: "=",
	p: "0",
	q: "1",
	r: "2",
	s: "3",
	t: "4",
	u: "5",
	v: "6",
	w: "7",
	x: "8",
	y: "9",
};

/** `CSI 1;mod <letter>` finals. */
const LETTER_KEYS: Readonly<Record<string, string>> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	E: "clear",
	F: "end",
	H: "home",
	P: "f1",
	Q: "f2",
	R: "f3",
	S: "f4",
};

/** `CSI n ~` numbers. */
const TILDE_KEYS: Readonly<Record<number, string>> = {
	1: "home",
	2: "insert",
	3: "delete",
	4: "end",
	5: "pageUp",
	6: "pageDown",
	7: "home",
	8: "end",
	11: "f1",
	12: "f2",
	13: "f3",
	14: "f4",
	15: "f5",
	17: "f6",
	18: "f7",
	19: "f8",
	20: "f9",
	21: "f10",
	23: "f11",
	24: "f12",
	25: "f13",
	26: "f14",
	28: "f15",
	29: "f16",
	31: "f17",
	32: "f18",
	33: "f19",
	34: "f20",
};

/** Kitty keypad codepoints: the digit/operator they type and the navigation key they are without NumLock text. */
const KEYPAD: Readonly<Record<number, { readonly text?: string; readonly nav?: string }>> = {
	57399: { text: "0", nav: "insert" },
	57400: { text: "1", nav: "end" },
	57401: { text: "2", nav: "down" },
	57402: { text: "3", nav: "pageDown" },
	57403: { text: "4", nav: "left" },
	57404: { text: "5", nav: "clear" },
	57405: { text: "6", nav: "right" },
	57406: { text: "7", nav: "home" },
	57407: { text: "8", nav: "up" },
	57408: { text: "9", nav: "pageUp" },
	57409: { text: ".", nav: "delete" },
	57410: { text: "/" },
	57411: { text: "*" },
	57412: { text: "-" },
	57413: { text: "+" },
	57414: { nav: "enter" },
	57415: { text: "=" },
	57416: { text: "," },
	57417: { nav: "left" },
	57418: { nav: "right" },
	57419: { nav: "up" },
	57420: { nav: "down" },
	57421: { nav: "pageUp" },
	57422: { nav: "pageDown" },
	57423: { nav: "home" },
	57424: { nav: "end" },
	57425: { nav: "insert" },
	57426: { nav: "delete" },
	57427: { nav: "clear" },
};

/** Name of a non-keypad codepoint, or null when it has none (modifier keys, media keys, lock keys). */
function codepointName(cp: number): string | null {
	switch (cp) {
		case 27:
			return "escape";
		case 13:
			return "enter";
		case 9:
			return "tab";
		case 127:
		case 8:
			return "backspace";
		case 32:
			return "space";
	}
	// F13–F35 live in the private use area.
	if (cp >= 57376 && cp <= 57398) return `f${cp - 57376 + 13}`;
	if (cp >= 57344 && cp <= 63743) return null;
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp > 0x10ffff) return null;
	return String.fromCodePoint(cp);
}

function eventKind(value: number | undefined): KeyEvent["kind"] | null {
	if (value === undefined || value === 1) return "press";
	if (value === 2) return "repeat";
	if (value === 3) return "release";
	return null;
}

function num(text: string | undefined): number | undefined {
	if (text === undefined || text === "") return undefined;
	const value = Number(text);
	return Number.isInteger(value) ? value : undefined;
}

/**
 * A key reported by codepoint (kitty CSI u, modifyOtherKeys). `mods` is the
 * wire value (1 + mask).
 */
function codepointKey(
	raw: string,
	cp: number,
	mods: number,
	kind: KeyEvent["kind"],
	shifted?: number,
	base?: number,
	textCodepoints?: readonly number[],
): KeyEvent | null {
	const fullMask = mods - 1;
	if (fullMask < 0 || fullMask & (HYPER | META)) return null;
	const mask = fullMask & ~LOCKS;
	const keypad = KEYPAD[cp];
	if (keypad) {
		// Digits stay text with or without NumLock; any other modifier selects the navigation key.
		if (keypad.text !== undefined) {
			if (mask === 0) return event(keypad.text, raw, kind, keypad.text);
			if (keypad.nav === undefined) return event(keyId(mask, keypad.text), raw, kind);
		}
		return keypad.nav ? event(keyId(mask, keypad.nav), raw, kind) : null;
	}
	const name = codepointName(cp);
	if (name === null) return null;
	const textOf = (): string | undefined => {
		if (mask & ~SHIFT) return undefined;
		if (textCodepoints?.length) return String.fromCodePoint(...textCodepoints);
		if (name.length > 1 && name !== "space") return undefined;
		if (name === "space") return " ";
		if (mask & SHIFT) return shifted !== undefined ? String.fromCodePoint(shifted) : name.toUpperCase();
		// Caps Lock on a Latin letter.
		if (fullMask & 64 && /^[a-z]$/i.test(name)) return name.toUpperCase();
		return name;
	};
	const text = textOf();
	if (name.length > 1) return event(keyId(mask, name), raw, kind, text);
	// Printable keys: Latin letters and ASCII symbols keep their own codepoint;
	// other layouts (Cyrillic, Greek) bind by their base-layout key.
	let key = name;
	if (mask & ~SHIFT && !(cp < 128) && base !== undefined) key = codepointName(base) ?? name;
	key = key.toLowerCase();
	if (mask === SHIFT && !/^[a-z]$/.test(key)) {
		// A shifted symbol is the symbol it types.
		const typed = text ?? key;
		return event(typed === " " ? "shift+space" : typed, raw, kind, text);
	}
	return event(keyId(mask, key), raw, kind, text);
}

function decodeCsiU(seq: string, params: string): KeyEvent | null {
	const [keyField = "", modField = "", textField = ""] = params.split(";");
	const [cpText, shiftedText, baseText] = keyField.split(":");
	const cp = num(cpText);
	if (cp === undefined) return null;
	const [modText, eventText] = modField.split(":");
	const kind = eventKind(num(eventText));
	if (!kind) return null;
	const textCodepoints = textField ? textField.split(":").map(Number).filter(Number.isInteger) : undefined;
	return codepointKey(seq, cp, num(modText) ?? 1, kind, num(shiftedText), num(baseText), textCodepoints);
}

function decodeCsi(seq: string): KeyEvent | null {
	const body = seq.slice(2);
	if (body.length === 0) return null;
	// Linux console function keys: CSI [ A … CSI [ E.
	if (body[0] === "[") {
		const linux: Readonly<Record<string, string>> = { A: "f1", B: "f2", C: "f3", D: "f4", E: "f5" };
		const name = linux[body.slice(1)] ?? TILDE_KEYS[num(body.slice(1, -1)) ?? -1];
		return name && body.length >= 2 ? event(name, seq) : null;
	}
	const final = body.at(-1)!;
	const params = body.slice(0, -1);
	if (/[^0-9;:]/.test(params)) return null;
	if (final === "u") return decodeCsiU(seq, params);
	const fields = params.split(";");
	if (final === "~") {
		const number = num(fields[0]?.split(":")[0]);
		if (number === undefined) return null;
		if (number === 27) {
			// xterm modifyOtherKeys: CSI 27 ; mod ; codepoint ~
			const mods = num(fields[1]);
			const cp = num(fields[2]);
			return mods === undefined || cp === undefined ? null : codepointKey(seq, cp, mods, "press");
		}
		// `CSI 13 ; mod ~` is a modified Enter (the legacy Shift+Enter some terminals send);
		// bare `CSI 13 ~` stays F3, and no terminal sends modified F3 that way.
		const name = number === 13 && fields[1] !== undefined ? "enter" : TILDE_KEYS[number];
		if (!name) return null;
		const [modText, eventText] = (fields[1] ?? "").split(":");
		const kind = eventKind(num(eventText));
		const mask = (num(modText) ?? 1) - 1;
		if (!kind || mask < 0 || mask & (HYPER | META)) return null;
		return event(keyId(mask & ~LOCKS, name), seq, kind);
	}
	// rxvt: `$` adds Shift, `^` adds Ctrl.
	if (final === "$" || final === "^") {
		const name = TILDE_KEYS[num(params) ?? -1];
		return name ? event(keyId(final === "$" ? SHIFT : CTRL, name), seq) : null;
	}
	if (final === "Z") {
		const mask = (num(fields[1]?.split(":")[0]) ?? 1) - 1;
		return mask < 0 ? null : event(keyId((mask & ~LOCKS) | SHIFT, "tab"), seq);
	}
	if (params === "") {
		// rxvt shifted arrows and clear.
		const rxvt: Readonly<Record<string, string>> = {
			a: "shift+up",
			b: "shift+down",
			c: "shift+right",
			d: "shift+left",
			e: "shift+clear",
		};
		if (rxvt[final]) return event(rxvt[final], seq);
	}
	const letter = LETTER_KEYS[final];
	if (!letter) return null;
	if (fields.length > 2) return null;
	const [modText, eventText] = (fields[1] ?? "").split(":");
	const kind = eventKind(num(eventText));
	const mask = (num(modText) ?? 1) - 1;
	if (!kind || mask < 0 || mask & (HYPER | META)) return null;
	return event(keyId(mask & ~LOCKS, letter), seq, kind);
}

/**
 * Decode one complete input sequence (as the tokenizer delimits it) into a
 * key event, or null when it is not a key (or a key nothing can bind:
 * bare modifiers, hyper/meta chords, media keys).
 */
export function decodeKey(seq: string, ctx: KeyDecodeContext): KeyEvent | null {
	if (seq.length === 0) return null;
	if (seq[0] !== "\x1b") {
		const cp = seq.codePointAt(0)!;
		return String.fromCodePoint(cp).length === seq.length ? singleChar(seq, ctx) : null;
	}
	if (seq.length === 1) return event("escape", seq);
	const second = seq[1]!;
	// A bare introducer flushed on timeout (`ESC [`, `ESC O`) was an Alt chord.
	if (seq.length === 2) return altChord(seq, ctx);
	if (second === "[") return decodeCsi(seq);
	if (second === "O" && seq.length === 3) {
		const name = SS3_KEYS[seq[2]!];
		if (!name) return null;
		return name.length === 1 ? event(name, seq, "press", name) : event(name, seq);
	}
	if (second === "\x1b" && seq.length > 2 && (seq[2] === "[" || seq[2] === "O")) {
		// Meta-prefixed CSI/SS3 (Option-as-Meta): Alt on the inner key.
		const inner = decodeKey(seq.slice(1), ctx);
		if (!inner) return null;
		return event(inner.id.startsWith("ctrl+") ? `ctrl+alt+${inner.id.slice(5)}` : `alt+${inner.id}`, seq, inner.kind);
	}
	const rest = seq.slice(1);
	if (String.fromCodePoint(rest.codePointAt(0)!).length === rest.length) return altChord(seq, ctx);
	return null;
}
