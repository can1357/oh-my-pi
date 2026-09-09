import { describe, expect, it } from "bun:test";
import { coalesceAdjacentSgr } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

const SGR = /\x1b\[([0-9;:]*)m/g;
function sgrSequences(s: string): string[] {
	return s.match(SGR) ?? [];
}
function maxParamTokens(s: string): number {
	let max = 0;
	for (const seq of sgrSequences(s)) {
		const body = seq.slice(2, -1);
		const tokens = body === "" ? 1 : body.split(/[;:]/).length;
		if (tokens > max) max = tokens;
	}
	return max;
}

describe("coalesceAdjacentSgr", () => {
	it("merges byte-adjacent SGR sequences into one CSI", () => {
		// A fg-reset immediately followed by a fg-set: the framing between them is
		// pure overhead — both fold into a single SGR carrying both parameters.
		const input = "a\x1b[39m\x1b[38;2;1;2;3mb";
		const out = coalesceAdjacentSgr(input);
		expect(out).toBe("a\x1b[39;38;2;1;2;3mb");
		expect(sgrSequences(out)).toHaveLength(1);
	});

	it("normalizes an empty-parameter reset (`CSI m`) to `0` when merging", () => {
		const out = coalesceAdjacentSgr("\x1b[m\x1b[1mx");
		expect(out).toBe("\x1b[0;1mx");
	});

	it("does NOT merge SGR separated by visible content", () => {
		// A glyph renders with the intermediate state, so the sequences must stay
		// distinct.
		const input = "\x1b[31mA\x1b[32mB";
		expect(coalesceAdjacentSgr(input)).toBe(input);
	});

	it("leaves non-SGR control sequences untouched", () => {
		// Cursor moves, EL and OSC share the CSI/OSC introducer but are not SGR.
		const input = "\x1b[5;1H\x1b[K\x1b]8;;https://x\x07link\x1b]8;;\x07";
		expect(coalesceAdjacentSgr(input)).toBe(input);
	});

	it("caps each emitted CSI so a long adjacent run never overflows the param buffer", () => {
		// 10 adjacent truecolor sets = 50 parameter tokens; a single unbounded
		// merge would exceed xterm.js's 32-param cap and corrupt the colors.
		let run = "x";
		for (let i = 0; i < 10; i++) run += `\x1b[38;2;${i};${i};${i}m`;
		run += "y";
		const out = coalesceAdjacentSgr(run);
		expect(maxParamTokens(out)).toBeLessThanOrEqual(16);
		// Still strictly fewer sequences than the input (merging happened).
		expect(sgrSequences(out).length).toBeLessThan(10);
	});

	it("renders identically to the original (cross-engine, ghostty VT)", () => {
		// The contract that matters: a coalesced line must paint the exact same
		// glyphs, foreground and background colors as the original.
		const styled =
			"\x1b[38;2;137;180;250mfn\x1b[39m \x1b[38;2;166;227;161mmain\x1b[39m" +
			"\x1b[48;2;24;24;37m()\x1b[49m \x1b[1m\x1b[3m{}\x1b[0m end";
		const coalesced = coalesceAdjacentSgr(styled);
		expect(coalesced).not.toBe(styled); // the line did contain merge-able runs

		const a = new VirtualTerminal(80, 4);
		const b = new VirtualTerminal(80, 4);
		a.write(styled);
		b.write(coalesced);

		expect(b.getViewport()).toEqual(a.getViewport());
		expect(b.getViewportRowForegroundColumns(0)).toEqual(a.getViewportRowForegroundColumns(0));
		expect(b.getViewportRowBackgroundColumns(0)).toEqual(a.getViewportRowBackgroundColumns(0));
	});

	it("does not merge across an incomplete truecolor introducer (missing channel)", () => {
		// `38;2;255;0` is missing its blue channel. Concatenating the next list
		// would let `31` be consumed as that channel (`38;2;255;0;31`) instead of
		// staying a standalone fg-red, changing the rendered color.
		const input = "\x1b[38;2;255;0m\x1b[31mX";
		expect(coalesceAdjacentSgr(input)).toBe(input);
	});

	it("does not merge across an incomplete indexed-color introducer (missing index)", () => {
		// `38;5` (256-color) is missing its palette index; `31` must not be absorbed.
		const input = "\x1b[38;5m\x1b[31mX";
		expect(coalesceAdjacentSgr(input)).toBe(input);
	});

	it("still merges a complete extended color followed by another code", () => {
		// `38;2;255;0;0` consumes exactly r,g,b; a trailing `31` then starts fresh,
		// so concatenation stays behavior-preserving and the merge win is kept.
		const input = "\x1b[38;2;255;0;0m\x1b[31mX";
		expect(coalesceAdjacentSgr(input)).toBe("\x1b[38;2;255;0;0;31mX");
	});

	it("renders malformed extended-color runs identically (no channel absorption)", () => {
		const input = "\x1b[38;2;255;0m\x1b[31mX";
		const out = coalesceAdjacentSgr(input);
		const a = new VirtualTerminal(80, 4);
		const b = new VirtualTerminal(80, 4);
		a.write(input);
		b.write(out);
		expect(b.getViewport()).toEqual(a.getViewport());
		expect(b.getViewportRowForegroundColumns(0)).toEqual(a.getViewportRowForegroundColumns(0));
	});
});
