import { expect, test } from "bun:test";
import {
	compileKernel,
	FIND,
	load,
	MARK_AHEAD,
	MARK_BACK,
	runKernel,
	stoppedState,
} from "@oh-my-pi/pi-utils/regex/jit";

// Both the fragmented class and its complement exceed the four-range SIMD limit.
const fragmented = "#7Qe|";
const ranges = [
	[0, 32, 34, 34, 36, 54, 56, 80, 82, 100, 102, 123, 125, 65535],
	[35, 35, 55, 55, 81, 81, 101, 101, 124, 124],
	[33, 33],
];

test("a fragmented ASCII self-loop stops before the first FIND match or unknown transition", () => {
	const kernel = compileKernel(FIND, 1, 3, Int32Array.of(0, 1, -1), ranges)!;
	for (let at = 0; at < 48; at++) {
		for (const unit of `${fragmented}!`) {
			const text = `${"x".repeat(at)}${unit}${"x".repeat(48 - at)}`;
			const layout = load(text, text.length);
			if (layout === -1) throw new Error("Expected the SIMD scan to be eligible");
			const hit = unit !== "!";
			expect(runKernel(kernel, layout, FIND, 0, text.length, 0, undefined, 0)).toBe(hit ? ~at : at);
			if (!hit) expect(stoppedState()).toBe(0);
			expect(runKernel(kernel, layout, FIND, 0, at, 0, undefined, 0)).toBe(at);
			expect(stoppedState()).toBe(0);
		}
	}
});

test("fragmented marked and unmarked self-loops preserve mark offsets and leave exceptions unread", () => {
	const run = `${"x".repeat(20)}${fragmented.repeat(5)}${"x".repeat(21)}`;
	const text = `${run}!${run}`;
	const layout = load(text, text.length);
	if (layout === -1) throw new Error("Expected the SIMD scan to be eligible");
	for (const mode of [MARK_AHEAD, MARK_BACK] as const) {
		const back = mode === MARK_BACK;
		const start = back ? text.length - 1 : 0;
		const stop = back ? -1 : text.length;
		const lo = back ? 0 : 7;
		const marks = new Uint8Array(text.length + 1 - lo);
		for (const markedAction of [1, 0, -1]) {
			const kernel = compileKernel(
				mode,
				1,
				3,
				Int32Array.of(Number(markedAction === 0), Number(markedAction === 1), -1),
				ranges,
			)!;
			const expected = new Uint8Array(marks.length);
			for (let at = start; at !== run.length; at += back ? -1 : 1) {
				const isFragmented = fragmented.includes(text[at]!);
				if (at >= lo && markedAction === Number(isFragmented)) expected[at - lo + Number(back)] = 1;
			}
			expect(runKernel(kernel, layout, mode, start, stop, 0, marks, lo)).toBe(run.length);
			expect(stoppedState()).toBe(0);
			expect(marks).toEqual(expected);
		}
	}
});
