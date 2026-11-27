/**
 * win32-input-mode (`CSI ? 9001 h`): the Windows console host reports every
 * key as a record `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _` (virtual key, scan code,
 * Unicode char, key down, control state, repeat count). Records are turned
 * into the byte sequences the key decoder understands, keeping chords the
 * console would otherwise fold (Shift+Enter, Ctrl+Enter, Ctrl+Shift+letter)
 * distinct. Records with no virtual key relay the host terminal's own bytes
 * one character at a time; those bytes are passed through verbatim so the
 * tokenizer reassembles the escape sequences they spell.
 */

const RECORD = /^\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_$/;

const RIGHT_ALT = 0x1;
const LEFT_ALT = 0x2;
const RIGHT_CTRL = 0x4;
const LEFT_CTRL = 0x8;
const SHIFT = 0x10;

const VK_BACK = 8;
const VK_TAB = 9;
const VK_RETURN = 13;
const VK_ESCAPE = 27;
const VK_SPACE = 32;
const VK_PACKET = 231;
/** Modifier and lock keys: their own presses carry no input. */
const MODIFIER_VKS = new Set([16, 17, 18, 20, 91, 92, 93, 144, 145, 160, 161, 162, 163, 164, 165]);

/** Navigation keys: CSI final (`1;mod X`) or tilde number (`n;mod ~`). */
const NAV_KEYS: Readonly<Record<number, { readonly final?: string; readonly tilde?: number }>> = {
	33: { tilde: 5 },
	34: { tilde: 6 },
	35: { final: "F" },
	36: { final: "H" },
	37: { final: "D" },
	38: { final: "A" },
	39: { final: "C" },
	40: { final: "B" },
	45: { tilde: 2 },
	46: { tilde: 3 },
	112: { final: "P" },
	113: { final: "Q" },
	114: { final: "R" },
	115: { final: "S" },
	116: { tilde: 15 },
	117: { tilde: 17 },
	118: { tilde: 18 },
	119: { tilde: 19 },
	120: { tilde: 20 },
	121: { tilde: 21 },
	122: { tilde: 23 },
	123: { tilde: 24 },
};

/** Whether `seq` is one win32-input-mode record. */
export function isWin32Record(seq: string): boolean {
	return RECORD.test(seq);
}

// ConPTY can report line breaks inside a bracketed paste as key record pairs.
const CONPTY_PASTE_CR = "\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_";
const CONPTY_PASTE_LF = "\x1b[17;29;0;1;8;1_\x1b[13;28;10;1;8;1_\x1b[13;28;10;0;8;1_\x1b[17;29;0;0;0;1_";

export function decodeWin32Paste(content: string): string {
	return content.replaceAll(CONPTY_PASTE_CR, "\r").replaceAll(CONPTY_PASTE_LF, "\n");
}

export class Win32RecordDecoder {
	#highSurrogate = "";

	/** The bytes one record stands for (empty for releases, bare modifiers and half a surrogate pair). */
	decode(seq: string): string {
		const match = RECORD.exec(seq);
		if (!match) return seq;
		const [vk, , uc, down, state, repeat] = match.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
			number,
			number,
		];
		const count = Math.min(Math.max(repeat, 1), 0xffff);
		if (!down) {
			// Alt+Numpad composition arrives on the Alt release.
			return vk === 18 && uc ? String.fromCharCode(uc) : "";
		}
		const one = this.#bytes(vk, uc, state);
		return count === 1 || one === "" ? one : one.repeat(count);
	}

	#bytes(vk: number, uc: number, state: number): string {
		if (vk === 0 || vk === VK_PACKET) return this.#char(uc);
		if (MODIFIER_VKS.has(vk) && uc === 0) return "";
		const shift = (state & SHIFT) !== 0;
		const alt = (state & (LEFT_ALT | RIGHT_ALT)) !== 0;
		const ctrl = (state & (LEFT_CTRL | RIGHT_CTRL)) !== 0;
		// AltGr is reported as Right Alt + Left Ctrl; it types the composed character.
		if (ctrl && alt && uc >= 0x20) return this.#char(uc);
		const mods = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
		const nav = NAV_KEYS[vk];
		if (nav) {
			if (nav.final) return mods === 1 ? `\x1b[${nav.final}` : `\x1b[1;${mods}${nav.final}`;
			return mods === 1 ? `\x1b[${nav.tilde}~` : `\x1b[${nav.tilde};${mods}~`;
		}
		switch (vk) {
			case VK_RETURN:
				// A dead key composed onto Enter types its character instead.
				if (uc !== 13 && uc !== 10 && uc >= 0x20) return this.#char(uc);
				return mods === 1 ? "\r" : `\x1b[13;${mods}u`;
			case VK_TAB:
				if (uc !== 9 && uc >= 0x20) return this.#char(uc);
				if (mods === 1) return "\t";
				return mods === 2 ? "\x1b[Z" : `\x1b[9;${mods}u`;
			case VK_BACK:
				if (mods === 1) return "\x7f";
				return mods === 3 ? "\x1b\x7f" : `\x1b[127;${mods}u`;
			case VK_ESCAPE:
				return `\x1b[27${mods === 1 ? "" : `;${mods}`}u`;
			case VK_SPACE:
				if (uc !== 32 && uc >= 0x20) return this.#char(uc);
				if (ctrl) return mods === 5 ? "\x00" : `\x1b[32;${mods}u`;
				return alt ? "\x1b " : " ";
		}
		// Ctrl+letter as CSI u: the C0 byte would fold Ctrl+H/I/J/M into Backspace/Tab/Enter.
		if (ctrl && vk >= 65 && vk <= 90) return `\x1b[${vk + 32};${mods}u`;
		if (uc === 0) return "";
		const text = this.#char(uc);
		if (alt && !ctrl) return `\x1b${text}`;
		return text;
	}

	#char(uc: number): string {
		if (uc >= 0xd800 && uc <= 0xdbff) {
			this.#highSurrogate = String.fromCharCode(uc);
			return "";
		}
		const text = this.#highSurrogate + String.fromCharCode(uc);
		this.#highSurrogate = "";
		return text;
	}
}
