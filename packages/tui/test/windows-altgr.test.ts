import { describe, expect, it } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import {
	type AltGrHost,
	createRightAltLatch,
	type KeyboardLayoutHandle,
	RIGHT_ALT_LATCH_MS,
	readAltGrLayer,
	translateWindowsAltGrSequence,
} from "@oh-my-pi/pi-tui/windows-altgr";

// Hungarian AltGr layer subset, keyed `<base codepoint>:<shift>` as the kitty encoder reports the base key.
const HUNGARIAN_LAYER = new Map([
	["102:0", "["], // f
	["103:0", "]"], // g
	["98:0", "{"], // b
	["110:0", "}"], // n
	["113:0", "\\"], // q
]);

function host(layer: ReadonlyMap<string, string>, rightAltDown: boolean): AltGrHost {
	return { activeLayer: () => layer, isRightAltDown: () => rightAltDown };
}

describe("translateWindowsAltGrSequence", () => {
	it("recovers AltGr text that the console host reported as an Alt or Ctrl+Alt chord", () => {
		const altGr = host(HUNGARIAN_LAYER, true);
		expect(translateWindowsAltGrSequence("\x1b[102;3u", altGr)).toBe("[");
		expect(translateWindowsAltGrSequence("\x1b[103;7u", altGr)).toBe("]");
		expect(translateWindowsAltGrSequence("\x1b[98;3u", altGr)).toBe("{");
		expect(translateWindowsAltGrSequence("\x1b[110;3u", altGr)).toBe("}");
		// Caps/Num Lock bits do not hide the chord.
		expect(translateWindowsAltGrSequence("\x1b[102;131u", altGr)).toBe("[");
		// Hosts that report the base key uppercase (Caps Lock) still hit the lowercased table.
		expect(translateWindowsAltGrSequence("\x1b[70;3u", altGr)).toBe("[");
	});

	it("keeps Left Alt chords as shortcuts when Right Alt is not held", () => {
		expect(translateWindowsAltGrSequence("\x1b[102;3u", host(HUNGARIAN_LAYER, false))).toBeUndefined();
	});

	it("keeps Alt chords as shortcuts on layouts without an AltGr layer", () => {
		expect(translateWindowsAltGrSequence("\x1b[102;3u", host(new Map(), true))).toBeUndefined();
	});

	it("ignores keys, modifiers, and events that never carry AltGr text", () => {
		const altGr = host(HUNGARIAN_LAYER, true);
		expect(translateWindowsAltGrSequence("\x1b[104;3u", altGr)).toBeUndefined(); // h: no AltGr mapping
		expect(translateWindowsAltGrSequence("\x1b[102;5u", altGr)).toBeUndefined(); // Ctrl only
		expect(translateWindowsAltGrSequence("\x1b[102;11u", altGr)).toBeUndefined(); // Super+Alt
		expect(translateWindowsAltGrSequence("\x1b[102;3:3u", altGr)).toBeUndefined(); // release
		expect(translateWindowsAltGrSequence("\x1b[102;4u", altGr)).toBeUndefined(); // Shift layer unmapped here
		expect(translateWindowsAltGrSequence("\x1b[1;3A", altGr)).toBeUndefined(); // Alt+Up
	});
});

describe("createRightAltLatch", () => {
	it("keeps a just-released Right Alt observed through a synchronously dispatched batch", () => {
		let down = true;
		let now = 1000;
		const isRightAltDown = createRightAltLatch(
			() => down,
			() => now,
		);
		expect(isRightAltDown()).toBe(true);
		// Key released while queued repeats from the same stdin read are still being dispatched.
		down = false;
		now += 1;
		expect(isRightAltDown()).toBe(true);
		now += RIGHT_ALT_LATCH_MS;
		expect(isRightAltDown()).toBe(false);
	});

	it("never reports a Right Alt press it has not observed", () => {
		const isRightAltDown = createRightAltLatch(
			() => false,
			() => 0,
		);
		expect(isRightAltDown()).toBe(false);
	});
});

describe.skipIf(process.platform !== "win32")("readAltGrLayer (Windows)", () => {
	const user32 =
		process.platform === "win32"
			? dlopen("user32.dll", { LoadKeyboardLayoutW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr } })
			: undefined;
	const load = (klid: string): KeyboardLayoutHandle => {
		const name = new Uint16Array([...klid].map(c => c.charCodeAt(0)).concat(0));
		const hkl = user32!.symbols.LoadKeyboardLayoutW(ptr(name), 0x80 /* KLF_NOTELLSHELL */);
		if (!hkl) throw new Error(`keyboard layout ${klid} unavailable`);
		return hkl;
	};

	it("maps the Hungarian AltGr layer by base key", () => {
		const layer = readAltGrLayer(load("0000040E"));
		expect(layer.get("102:0")).toBe("[");
		expect(layer.get("103:0")).toBe("]");
		expect(layer.get("98:0")).toBe("{");
		expect(layer.get("110:0")).toBe("}");
	});

	it("reports an empty layer for US English", () => {
		expect(readAltGrLayer(load("00000409")).size).toBe(0);
	});
});
