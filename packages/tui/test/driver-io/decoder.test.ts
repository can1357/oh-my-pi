import { describe, expect, it } from "bun:test";
import type { InputEvent } from "../../src/driver/contract";
import { decodeInput, InputDecoder, type InputDecoderOptions } from "../../src/driver/input/decoder";
import { decodeKey, type KeyDecodeContext } from "../../src/driver/input/keys";
import type { TerminalReply } from "../../src/driver/input/replies";
import { FakeClock } from "./fake-clock";

const legacy: KeyDecodeContext = { kitty: false, backspaceIsCtrl: false };
const kitty: KeyDecodeContext = { kitty: true, backspaceIsCtrl: false };

function id(seq: string, ctx: KeyDecodeContext = legacy): string | undefined {
	return decodeKey(seq, ctx)?.id;
}

describe("decodeKey: legacy encodings", () => {
	it.each([
		["\r", "enter"],
		["\n", "enter"],
		["\t", "tab"],
		["\x7f", "backspace"],
		["\x08", "backspace"],
		["\x00", "ctrl+space"],
		["\x03", "ctrl+c"],
		["\x1c", "ctrl+\\"],
		["\x1f", "ctrl+_"],
		["\x1b", "escape"],
		[" ", "space"],
		["a", "a"],
		["A", "shift+a"],
		["!", "!"],
		["é", "é"],
		["\x1b[Z", "shift+tab"],
		["\x1b[A", "up"],
		["\x1bOA", "up"],
		["\x1b[1;5C", "ctrl+right"],
		["\x1b[1;3A", "alt+up"],
		["\x1b[1;2H", "shift+home"],
		["\x1b[5~", "pageUp"],
		["\x1b[6;5~", "ctrl+pageDown"],
		["\x1b[3~", "delete"],
		["\x1b[2~", "insert"],
		["\x1b[15~", "f5"],
		["\x1b[24~", "f12"],
		["\x1b[13~", "f3"],
		// The legacy modified-Enter form (Shift+Enter in some terminals); bare `CSI 13 ~` stays F3.
		["\x1b[13;2~", "shift+enter"],
		["\x1b[13;5~", "ctrl+enter"],
		["\x1bOP", "f1"],
		["\x1b[[A", "f1"],
		["\x1b[a", "shift+up"],
		["\x1bOa", "ctrl+up"],
		["\x1b[5$", "shift+pageUp"],
		["\x1b[8^", "ctrl+end"],
		["\x1bp", "alt+p"],
		["\x1bP", "alt+shift+p"],
		["\x1b\x7f", "alt+backspace"],
		["\x1b\r", "alt+enter"],
		["\x1b\x01", "ctrl+alt+a"],
		["\x1b.", "alt+."],
		["\x1bB", "alt+left"],
		["\x1bF", "alt+right"],
		["\x1b\x1b[A", "alt+up"],
		["\x1b\x1b[1;5A", "ctrl+alt+up"],
		["\x1b[", "alt+["],
		["\x1bO", "alt+shift+o"],
	])("%j → %s", (seq, expected) => {
		expect(id(seq)).toBe(expected);
	});

	it("keeps ESC+B/F as Alt chords under the kitty protocol", () => {
		expect(id("\x1bB", kitty)).toBe("alt+shift+b");
		expect(id("\x1bf", kitty)).toBe("alt+f");
	});

	it("reads raw 0x08 as Ctrl+Backspace where the terminal sends it for that chord", () => {
		expect(id("\x08", { kitty: false, backspaceIsCtrl: true })).toBe("ctrl+backspace");
		expect(id("\x7f", { kitty: false, backspaceIsCtrl: true })).toBe("backspace");
	});

	it("carries printable text only for unmodified keys", () => {
		expect(decodeKey("A", legacy)).toEqual({
			id: "shift+a",
			kind: "press",
			raw: "A",
			text: "A",
		});
		expect(decodeKey(" ", legacy)?.text).toBe(" ");
		expect(decodeKey("\x1bp", legacy)?.text).toBeUndefined();
		expect(decodeKey("\r", legacy)?.text).toBeUndefined();
	});
});

describe("decodeKey: kitty keyboard protocol and modifyOtherKeys", () => {
	it.each([
		["\x1b[99;5u", "ctrl+c"],
		["\x1b[27u", "escape"],
		["\x1b[13;2u", "shift+enter"],
		["\x1b[13;5u", "ctrl+enter"],
		["\x1b[9;2u", "shift+tab"],
		["\x1b[127;3u", "alt+backspace"],
		["\x1b[127;11u", "alt+super+backspace"],
		["\x1b[32u", "space"],
		["\x1b[32;5u", "ctrl+space"],
		["\x1b[97:65;2u", "shift+a"],
		["\x1b[112;7u", "ctrl+alt+p"],
		["\x1b[112;6u", "ctrl+shift+p"],
		["\x1b[107::118;5u", "ctrl+k"],
		["\x1b[47::91;5u", "ctrl+/"],
		["\x1b[1089::99;5u", "ctrl+c"],
		["\x1b[1057::99;6u", "ctrl+shift+c"],
		["\x1b[49:33;2u", "!"],
		["\x1b[57400u", "1"],
		["\x1b[57400;129u", "1"],
		["\x1b[57400;133u", "ctrl+end"],
		["\x1b[57404u", "5"],
		["\x1b[57410u", "/"],
		["\x1b[57413;5u", "ctrl++"],
		["\x1b[57414u", "enter"],
		["\x1b[57419;3u", "alt+up"],
		["\x1b[57376u", "f13"],
		["\x1b[99;69u", "ctrl+c"],
		["\x1b[3;5~", "ctrl+delete"],
		["\x1b[1;9A", "super+up"],
		["\x1b[27;2;13~", "shift+enter"],
		["\x1b[27;5;105~", "ctrl+i"],
		["\x1b[27;1;32~", "space"],
		["\x1b[27;1;127~", "backspace"],
	])("%j → %s", (seq, expected) => {
		expect(id(seq, kitty)).toBe(expected);
	});

	it("reports press, repeat and release event types", () => {
		expect(decodeKey("\x1b[97u", kitty)?.kind).toBe("press");
		expect(decodeKey("\x1b[97;1:2u", kitty)?.kind).toBe("repeat");
		expect(decodeKey("\x1b[97;1:3u", kitty)?.kind).toBe("release");
		expect(decodeKey("\x1b[3;1:3~", kitty)).toMatchObject({
			id: "delete",
			kind: "release",
		});
		expect(decodeKey("\x1b[1;1:2A", kitty)).toMatchObject({
			id: "up",
			kind: "repeat",
		});
	});

	it("drops chords nothing can bind: hyper, meta, bare modifiers, lock keys", () => {
		expect(decodeKey("\x1b[99;17u", kitty)).toBeNull();
		expect(decodeKey("\x1b[99;33u", kitty)).toBeNull();
		expect(decodeKey("\x1b[57441;2u", kitty)).toBeNull();
		expect(decodeKey("\x1b[57358u", kitty)).toBeNull();
	});

	it("takes text from the text field, and only without non-shift modifiers", () => {
		expect(decodeKey("\x1b[97;1;229u", kitty)?.text).toBe("å");
		expect(decodeKey("\x1b[97;9;229u", kitty)?.text).toBeUndefined();
		expect(decodeKey("\x1b[97:65;2u", kitty)?.text).toBe("A");
		expect(decodeKey("\x1b[97;65u", kitty)?.text).toBe("A");
		expect(decodeKey("\x1b[57404u", kitty)?.text).toBe("5");
		expect(decodeKey("\x1b[57400;133u", kitty)?.text).toBeUndefined();
		expect(decodeKey("\x1b[27;1;127~", kitty)?.text).toBeUndefined();
	});
});

function setup(options: InputDecoderOptions = {}) {
	const clock = new FakeClock();
	const events: InputEvent[] = [];
	const replies: TerminalReply[] = [];
	const decoder = new InputDecoder(
		{
			input: event => events.push(event),
			reply: reply => replies.push(reply),
		},
		{ clock, ...options },
	);
	const bytes = (text: string) => {
		for (const ch of text) decoder.process(ch);
	};
	const keys = () => events.flatMap(event => (event.type === "key" ? [event.key.id] : []));
	return { clock, decoder, events, replies, bytes, keys };
}

describe("InputDecoder: every family, byte by byte", () => {
	it("decodes keys", () => {
		const { bytes, keys } = setup();
		bytes("a\x1b[1;5C\x1b[99;5u\x1b[13;2u\x1bOP\x1b[27;5;106~");
		expect(keys()).toEqual(["a", "ctrl+right", "ctrl+c", "shift+enter", "f1", "ctrl+j"]);
	});

	it("decodes kitty event types", () => {
		const { bytes, events } = setup();
		bytes("\x1b[97u\x1b[97;1:2u\x1b[97;1:3u");
		expect(events.map(event => (event.type === "key" ? event.key.kind : event.type))).toEqual([
			"press",
			"repeat",
			"release",
		]);
	});

	it("keeps a raw key sequence on the event", () => {
		const { bytes, events } = setup();
		bytes("\x1b[1;5C");
		expect(events).toEqual([
			{
				type: "key",
				key: { id: "ctrl+right", kind: "press", raw: "\x1b[1;5C" },
			},
		]);
	});

	it("delivers a paste whole", () => {
		const { bytes, events } = setup();
		bytes("\x1b[200~hello\nworld\x1b[201~");
		expect(events).toEqual([{ type: "paste", paste: { text: "hello\nworld" } }]);
	});

	it("marks the key that shares a read with the paste before it", () => {
		const { decoder, events, clock } = setup();
		decoder.process("\x1b[200~line one\nline two\x1b[201~\ra");
		decoder.process("\r");
		clock.advance(100);
		expect(
			events.map(event => (event.type === "key" ? [event.key.id, event.key.afterPaste === true] : event.type)),
		).toEqual(["paste", ["enter", true], ["a", false], ["enter", false]]);
	});

	it("marks the Enter a raw multi-line burst carries", () => {
		const { decoder, events } = setup();
		decoder.process("first\nsecond\nthird\r");
		const last = events.at(-1);
		expect(events[0]?.type).toBe("paste");
		expect(last?.type === "key" && last.key.id === "enter" && last.key.afterPaste).toBe(true);
	});

	it("decodes SGR and X10 mouse reports", () => {
		const { bytes, events } = setup();
		bytes(
			"\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<32;11;5M\x1b[<35;12;6M\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<66;1;1M\x1b[<20;3;4M",
		);
		bytes("\x1b[M !!");
		expect(events.map(event => (event.type === "mouse" ? event.mouse : null))).toEqual([
			{ row: 4, col: 9, button: "left", action: "press", mods: [] },
			{ row: 4, col: 9, button: "left", action: "release", mods: [] },
			{ row: 4, col: 10, button: "left", action: "drag", mods: [] },
			{ row: 5, col: 11, button: "none", action: "move", mods: [] },
			{ row: 0, col: 0, button: "wheel-up", action: "press", mods: [] },
			{ row: 0, col: 0, button: "wheel-down", action: "press", mods: [] },
			{ row: 0, col: 0, button: "wheel-left", action: "press", mods: [] },
			{
				row: 3,
				col: 2,
				button: "left",
				action: "press",
				mods: ["shift", "ctrl"],
			},
			{ row: 0, col: 0, button: "left", action: "press", mods: [] },
		]);
	});

	it("decodes focus in and out", () => {
		const { bytes, events } = setup();
		bytes("\x1b[I\x1b[O");
		expect(events).toEqual([
			{ type: "focus", focused: true },
			{ type: "focus", focused: false },
		]);
	});

	it("surfaces TSP messages (APC and ConPTY OSC) with params and the raw body", () => {
		const { bytes, events } = setup();
		bytes('\x1b_tsp;e;{"ev":"theme","dark":true}\x1b\\');
		bytes('\x1b]877;tsp;r;{"r":"hello","v":1}\x07');
		bytes("\x1b_tsp;b;id=abc;c=1;m=1;QUJD\x1b\\");
		expect(events).toEqual([
			{
				type: "tsp",
				verb: "e",
				params: {},
				body: '{"ev":"theme","dark":true}',
			},
			{ type: "tsp", verb: "r", params: {}, body: '{"r":"hello","v":1}' },
			{
				type: "tsp",
				verb: "b",
				params: { id: "abc", c: "1", m: "1" },
				body: "QUJD",
			},
		]);
	});

	it("drops a malformed TSP reply whose stalled tail starts with a space, preserving the next key", () => {
		const { clock, decoder, keys } = setup();
		decoder.process('\x1b_tsp;;{"ev":"error","msg":"unknown surface');
		clock.advance(200);
		decoder.process(' s:1"}\x1b\\x');
		expect(keys()).toEqual(["x"]);
	});

	it("does not type the spaced tail of a TSP reply after the string watchdog expires", () => {
		const { clock, decoder, keys } = setup();
		decoder.process('\x1b_tsp;e;{"ev":"error","msg":"unknow');
		clock.advance(5000);
		decoder.process('surface s:1"}\x1b\\x');
		expect(keys()).toEqual(["x"]);
	});

	it("routes every probe reply to its owner and never to input", () => {
		const { bytes, events, replies } = setup();
		bytes("\x1b[?62;4;22c");
		bytes("\x1b[>1;4000;29c");
		bytes("\x1b[?5u");
		bytes("\x1b[?2026;2$y");
		bytes("\x1b[?997;2n");
		bytes("\x1b[0n");
		bytes("\x1b[?2;0;800;600S");
		bytes("\x1b[6;18;9t");
		bytes("\x1b[48;40;120;720;1080t");
		bytes("\x1b]11;rgb:1c/1c/1c\x07");
		bytes("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
		bytes("\x1bP>|WezTerm 20240203\x1b\\");
		bytes("\x1b_Gi=31;OK\x1b\\");
		bytes("\x1bP1$r0m\x1b\\");
		bytes("\x1bP1+r544e\r\n=787465726d\x1b\\");
		expect(events).toEqual([]);
		expect(replies).toEqual([
			{ type: "da1", attrs: [62, 4, 22] },
			{ type: "da2", params: [1, 4000, 29] },
			{ type: "kittyKeyboard", flags: 5 },
			{ type: "decrpm", mode: 2026, status: 2, dec: true },
			{ type: "colorScheme", dark: false },
			{ type: "dsr", status: 0 },
			{ type: "graphicsAttribute", item: 2, status: 0, values: [800, 600] },
			{ type: "windowSize", unit: "cell", height: 18, width: 9 },
			{
				type: "inBandResize",
				rows: 40,
				cols: 120,
				heightPx: 720,
				widthPx: 1080,
			},
			{ type: "color", index: 11, rgb: { r: 28, g: 28, b: 28 } },
			{ type: "color", index: 10, rgb: { r: 255, g: 255, b: 255 } },
			{ type: "version", version: "WezTerm 20240203" },
			{ type: "kittyGraphics", id: 31, ok: true, message: "OK" },
			{ type: "other", raw: "\x1bP1$r0m\x1b\\" },
			{ type: "other", raw: "\x1bP1+r544e\r\n=787465726d\x1b\\" },
		]);
	});

	it("reads CSI r;c R as a cursor report only while one is pending", () => {
		const { decoder, bytes, replies, keys } = setup();
		bytes("\x1b[1;5R");
		expect(keys()).toEqual(["ctrl+f3"]);
		decoder.cprPending = true;
		bytes("\x1b[12;40R");
		expect(replies).toEqual([{ type: "cpr", row: 12, col: 40 }]);
	});

	it("swallows a DA1 reply split past every timeout", () => {
		const { decoder, clock, events, replies } = setup();
		decoder.process("\x1b[?62");
		clock.advance(200);
		decoder.process(";52c");
		expect(events).toEqual([]);
		expect(replies).toEqual([{ type: "da1", attrs: [62, 52] }]);
	});

	it("never types an OSC 11 reply that a key interrupts", () => {
		const { decoder, keys, events } = setup();
		decoder.process("\x1b]11;rgb:ff");
		decoder.process("\x1b[A");
		expect(keys()).toEqual(["up"]);
		expect(events).toHaveLength(1);
	});
});

describe("InputDecoder: win32-input-mode records", () => {
	const record = (vk: number, sc: number, uc: number, down: number, state: number, repeat = 1) =>
		`\x1b[${vk};${sc};${uc};${down};${state};${repeat}_`;
	const relay = (text: string) => [...text].map(ch => record(0, 0, ch.charCodeAt(0), 1, 0)).join("");

	function win32() {
		const harness = setup();
		harness.decoder.win32 = true;
		return harness;
	}

	it("keeps Enter chords distinct and drops releases", () => {
		const { decoder, keys, clock } = win32();
		decoder.process(record(13, 28, 13, 1, 0));
		decoder.process(record(13, 28, 13, 0, 0));
		decoder.process(record(13, 28, 13, 1, 16));
		decoder.process(record(13, 28, 10, 1, 8));
		decoder.process(record(74, 36, 10, 1, 8));
		decoder.process(record(16, 42, 0, 1, 16));
		// The chords after the first Enter arrive on the turns after it.
		clock.advance(0);
		expect(keys()).toEqual(["enter", "shift+enter", "ctrl+enter", "ctrl+j"]);
	});

	it("decodes text, Alt and Ctrl chords, navigation and AltGr", () => {
		const { decoder, keys } = win32();
		for (const seq of [
			record(65, 30, 97, 1, 0),
			record(65, 30, 65, 1, 16),
			record(67, 46, 3, 1, 8),
			record(66, 48, 98, 1, 2),
			record(80, 25, 16, 1, 24),
			record(9, 15, 9, 1, 16),
			record(8, 14, 8, 1, 2),
			record(27, 1, 27, 1, 0),
			record(38, 72, 0, 1, 264),
			record(116, 63, 0, 1, 0),
			record(81, 16, 64, 1, 9),
		]) {
			decoder.process(seq);
		}
		expect(keys()).toEqual([
			"a",
			"shift+a",
			"ctrl+c",
			"alt+b",
			"ctrl+shift+p",
			"shift+tab",
			"alt+backspace",
			"escape",
			"ctrl+up",
			"f5",
			"@",
		]);
	});

	it("joins surrogate halves and repeats auto-repeated keys", () => {
		const { decoder, keys } = win32();
		decoder.process(record(231, 0, 0xd83d, 1, 0));
		decoder.process(record(231, 0, 0xde00, 1, 0));
		decoder.process(record(65, 30, 97, 1, 0, 3));
		expect(keys()).toEqual(["😀", "a", "a", "a"]);
	});

	it("reassembles escape sequences relayed one record per byte, across reads", () => {
		const { decoder, keys, events, clock } = win32();
		for (const ch of relay("\x1b[1;3A")) decoder.process(ch);
		decoder.process(relay('\x1b]877;tsp;e;{"a":1}\x07'));
		decoder.process(relay("\x1b"));
		clock.advance(100);
		expect(keys()).toEqual(["alt+up", "escape"]);
		expect(events.filter(event => event.type === "tsp")).toEqual([
			{ type: "tsp", verb: "e", params: {}, body: '{"a":1}' },
		]);
	});

	it("treats record-encoded paste markers as framing", () => {
		const { decoder, events } = win32();
		decoder.process(relay("\x1b[200~a"));
		decoder.process(record(13, 28, 13, 1, 0) + relay("b\x1b[201~"));
		expect(events).toEqual([{ type: "paste", paste: { text: "a\rb" } }]);
	});

	it("still decodes direct terminal replies and keys while records are on", () => {
		const { decoder, replies, keys } = win32();
		decoder.process("\x1b[?1;2c\x1b[A");
		expect(replies).toEqual([{ type: "da1", attrs: [1, 2] }]);
		expect(keys()).toEqual(["up"]);
	});
});

describe("decodeInput", () => {
	it("decodes held bytes at once, a lone escape included", () => {
		expect(decodeInput("a\x1b[A\x1b").map(event => (event.type === "key" ? event.key.id : event.type))).toEqual([
			"a",
			"up",
			"escape",
		]);
		expect(decodeInput("\x1b[200~x\x1b[201~")).toEqual([{ type: "paste", paste: { text: "x" } }]);
		expect(decodeInput("\x1b[99;5u", { kitty: true }).map(event => event.type === "key" && event.key.id)).toEqual([
			"ctrl+c",
		]);
	});
});
