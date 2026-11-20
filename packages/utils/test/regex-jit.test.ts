import { expect, test } from "bun:test";
import {
	compileKernel,
	FIND,
	load,
	MARK_AHEAD,
	MARK_BACK,
	runKernel,
	type ScanMode,
	stoppedState,
} from "@oh-my-pi/pi-utils/regex/jit";
import { LinearRegExp } from "@oh-my-pi/pi-utils/regex";

test("paired-state skips recover the state before an exceptional ASCII unit", () => {
	const ranges = [
		[0, 31, 33, 34, 36, 63, 65, 90, 92, 95, 97, 126],
		[32, 32],
		[35, 35, 64, 64, 91, 91, 96, 96, 127, 127],
		[128, 65535],
	];
	// Both rows reset to state 0 on ordinary bytes and 1 on spaces. At '@',
	// state 0 reports a match, whereas state 1 exits to the table.
	const kernel = compileKernel(FIND, 2, 4, Int32Array.of(0, 2, 1, -1, 0, 2, -1, 2), ranges)!;
	for (let at = 16; at <= 63; at++) {
		for (const previous of ["a", " "]) {
			const text = `${"a ".repeat(32).slice(0, at - 1)}${previous}@${"a ".repeat(16)}`;
			const layout = load(text, text.length);
			if (layout === -1) throw new Error("Expected the SIMD scan to be eligible");
			const end = runKernel(kernel, layout, FIND, 0, text.length, 0, undefined, 0);
			expect(end).toBe(previous === "a" ? ~at : at);
			if (previous === " ") expect(stoppedState()).toBe(1);
		}
	}
});

test("vector stores preserve both mark directions and clear shared scratch", () => {
	const ranges = [[0, 65535]];
	const modes: ScanMode[] = [MARK_BACK, MARK_AHEAD];
	for (const mode of modes) {
		const marked = compileKernel(mode, 1, 1, Int32Array.of(1), ranges)!;
		const unmarked = compileKernel(mode, 1, 1, Int32Array.of(0), ranges)!;
		for (const text of ["x".repeat(63), "\ud800".repeat(63)]) {
			const layout = load(text, text.length);
			if (layout === -1) throw new Error("Expected the SIMD scan to be eligible");
			const lo = mode === MARK_AHEAD ? 7 : 0;
			const start = mode === MARK_AHEAD ? 0 : text.length - 1;
			const stop = mode === MARK_AHEAD ? text.length : -1;
			const marks = new Uint8Array(text.length - lo + 1);
			const markedFrom = mode === MARK_AHEAD ? 0 : 1;
			const markedTo = markedFrom + text.length - lo;
			const expected = new Uint8Array(marks.length).fill(1, markedFrom, markedTo);
			expect(runKernel(marked, layout, mode, start, stop, 0, marks, lo)).toBe(stop);
			expect(marks).toEqual(expected);
			expect(runKernel(unmarked, layout, mode, start, stop, 0, marks, lo)).toBe(stop);
			expect(marks).toEqual(new Uint8Array(marks.length));
		}
	}
});

test("mixed UTF-16 and ASCII inputs keep native captures and offsets", () => {
	const source = String.raw`(?<=key=)([^;]+)(?=;)`;
	const regex = new LinearRegExp(source, "gd", { jitAfter: 1, window: 64 });
	const native = new RegExp(source, "gd");
	for (const unit of ["x", "é", "🦀", "\ud800"]) {
		const value = unit.repeat(163);
		for (const prefix of ["", "x".repeat(32 * 1024 - 1)]) {
			const input = `${prefix}${value}key=${value};${value}key=${value};`;
			expect([...input.matchAll(regex)]).toEqual([...input.matchAll(native)]);
		}
	}
});

/** Every match with its index, searching from `from`. */
function matches(regex: RegExp, text: string, from: number): string[] {
	const out: string[] = [];
	regex.lastIndex = from;
	for (let match = regex.exec(text); match; match = regex.exec(text)) out.push(`${match.index}:${match[0]}`);
	return out;
}

test("a same-length rewrite of the text the kernels hold is searched as itself", () => {
	// The alternation keeps the pattern on the automata; an eager kernel copies the first text it scans.
	const source = String.raw`(?:key|token)=[a-z]+;`;
	const filler = "lorem ipsum dolor sit amet ".repeat(40);
	const original = `${filler}key=alpha;${filler}token=beta;${filler}key=gamma;${filler}`;
	const rewrites: [string, string][] = [
		// A match disappears, one appears, one changes, and the text only changes far from every match.
		["key=alpha;", "key=ALPHA;"],
		["dolor sit amet token=beta;", "key=new;  amet token=beta;"],
		["token=beta;", "token=bet;;"],
		["amet key=gamma;", "amex key=gamma;"],
		["lorem", "LOREM"],
	];
	const starts = [0, filler.length - 512, filler.length + 5, 2 * filler.length, original.length - 40];
	for (const [before, after] of rewrites) {
		const rewritten = original.replace(before, after);
		expect(rewritten.length).toBe(original.length);
		for (const from of starts) {
			const linear = new LinearRegExp(source, "g", { jitAfter: 0 });
			const native = new RegExp(source, "g");
			expect(matches(linear, original, 0)).toEqual(matches(native, original, 0));
			expect(matches(linear, rewritten, from)).toEqual(matches(native, rewritten, from));
			expect(matches(linear, original, from)).toEqual(matches(native, original, from));
		}
	}
});

test("a transition cache that starts over mid-scan leaves no kernel from the old numbering in use", () => {
	// Counted classes need more states than the cache holds, so it starts over while the text is still uncopied.
	const source = String.raw`[a-f]{1,3}x|[b-g]{2,4}y|[c-h]{3,5}z`;
	let seed = 0x2545f491;
	const random = (): number => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) / 2 ** 32;
	};
	for (let round = 0; round < 40; round++) {
		const letters = Array.from(
			{ length: 300 + Math.floor(random() * 300) },
			() => "abcdefgh"[Math.floor(random() * 8)],
		);
		const text = `${letters.join("")}${"xyz"[round % 3]}`;
		const linear = new LinearRegExp(source, "g", { jitAfter: 1, dfaEntries: 24 + (round % 5) * 16 });
		expect(matches(linear, text, 0)).toEqual(matches(new RegExp(source, "g"), text, 0));
	}
});
