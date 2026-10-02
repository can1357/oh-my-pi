import { describe, expect, it } from "bun:test";
import {
	fillJudgeBatch,
	packJudgeBatch,
	renderJudgeStateValue,
	serializeJudgeRow,
	sliceJudgeLogits,
} from "@oh-my-pi/pi-coding-agent/tiny/judge-serialize";

// Offline-safe contract tests: no ORT, no network. A char-code stand-in for the
// tokenizer keeps every id hand-computable (ASCII < 1000, so % 1000 is identity).
const encode = (text: string): number[] => [...text].map(c => c.charCodeAt(0) % 1000);
const SPECIAL_IDS = { mask: 4, cls: 2, sep: 1 };

describe("judge-serialize", () => {
	it("maps qtype ids choice→0, score→1, noul→2 (wrong head → model scores with wrong type embedding)", () => {
		const base = { question: "Q", options: ["A", "B"], state: "S" };
		expect(serializeJudgeRow({ ...base, type: "choice" }, encode, SPECIAL_IDS).qtype).toBe(0);
		expect(serializeJudgeRow({ ...base, type: "score" }, encode, SPECIAL_IDS).qtype).toBe(1);
		expect(serializeJudgeRow({ ...base, type: "noul" }, encode, SPECIAL_IDS).qtype).toBe(2);
	});

	it("points each marker at its option's leading mask slot (misaligned markers → gather reads garbage hidden states)", () => {
		const row = serializeJudgeRow(
			{ type: "choice", question: "Q", options: ["A", "B"], state: "S" },
			encode,
			SPECIAL_IDS,
		);
		// Hand-computed: head "choice question: Q" is 18 tokens, so
		// ids = [cls, ...18 head, sep, 4,32,65, 4,32,66, sep, 83, sep].
		expect(row.markers).toEqual([20, 23]);
		expect(row.ids).toEqual([
			2, 99, 104, 111, 105, 99, 101, 32, 113, 117, 101, 115, 116, 105, 111, 110, 58, 32, 81, 1, 4, 32, 65, 4, 32, 66,
			1, 83, 1,
		]);
		for (const marker of row.markers) expect(row.ids[marker]).toBe(SPECIAL_IDS.mask);
	});

	it("caps each option at 48 tokens plus the mask slot (unbounded options overflow the head budget)", () => {
		const row = serializeJudgeRow(
			{ type: "choice", question: "Q", options: ["x".repeat(100), "ok"], state: "S" },
			encode,
			SPECIAL_IDS,
		);
		// " x…x" would be 101 tokens uncapped; cap keeps space + 47 body + mask = 49 ids.
		expect(row.markers[1] - row.markers[0]).toBe(49);
		expect(row.ids.slice(row.markers[0], row.markers[1])).toEqual([SPECIAL_IDS.mask, 32, ...Array(47).fill(120)]);
	});

	it("truncates an overfull state to room instead of throwing (long states must not crash the worker)", () => {
		// Prefix before state: cls(1) + head(18) + sep(1) + options(3+3) + sep(1) = 27 ids,
		// so maxLength 30 leaves room for exactly 2 of the 5 state tokens.
		const row = serializeJudgeRow(
			{ type: "choice", question: "Q", options: ["A", "B"], state: "ABCDE" },
			encode,
			SPECIAL_IDS,
			{ maxLength: 30 },
		);
		expect(row.ids.length).toBe(30);
		expect(row.ids.slice(-3)).toEqual([65, 66, SPECIAL_IDS.sep]);
	});

	it("pads packJudgeBatch length to a multiple of 8 with count = max markers (else ORT session.run shape mismatch)", () => {
		const two = serializeJudgeRow(
			{ type: "choice", question: "Q", options: ["A", "B"], state: "S" },
			encode,
			SPECIAL_IDS,
		);
		const three = serializeJudgeRow(
			{ type: "score", question: "Q", options: ["A", "B", "C"], state: "S" },
			encode,
			SPECIAL_IDS,
		);
		const batch = packJudgeBatch([two, three]);
		const longest = Math.max(two.ids.length, three.ids.length);
		expect(batch.count).toBe(3);
		expect(batch.length).toBe(Math.ceil(longest / 8) * 8);
		expect(batch.length % 8).toBe(0);
		expect(batch.qtypes).toEqual([two.qtype, three.qtype]);
	});

	it("renders non-string states with python separators outside strings (compact JSON shifts training token layout)", () => {
		expect(renderJudgeStateValue("as-is string")).toBe("as-is string");
		// Structural separators gain a space; commas/colons inside values never split.
		expect(renderJudgeStateValue({ b: 2, a: [1, 2] })).toBe('{"b": 2, "a": [1, 2]}');
		expect(renderJudgeStateValue({ msg: "a, b: c" })).toBe('{"msg": "a, b: c"}');
		// Escaped quotes would flip a quote-counting regex lookahead; the scanner tracks backslashes.
		expect(renderJudgeStateValue({ k: 'a"b, c: d', e: "plain" })).toBe('{"k": "a\\"b, c: d", "e": "plain"}');
		expect(renderJudgeStateValue(["a,b", "c:d"])).toBe('["a,b", "c:d"]');
	});

	it("fills batch tensors with ids/attention at row offsets and markers at option offsets (pad slots stay zero)", () => {
		const two = serializeJudgeRow(
			{ type: "choice", question: "Q", options: ["A", "B"], state: "S" },
			encode,
			SPECIAL_IDS,
		);
		const three = serializeJudgeRow(
			{ type: "score", question: "Q", options: ["A", "B", "C"], state: "S" },
			encode,
			SPECIAL_IDS,
		);
		// Hand-computed: two.ids is 29 long (see marker test above: "score" head
		// is one token shorter than "choice"), three.ids is 31, so length pads
		// to 32 and count is 3.
		const batch = packJudgeBatch([two, three]);
		expect(batch).toMatchObject({ length: 32, count: 3 });
		const { ids, attention, positions, mask, qtype } = fillJudgeBatch([two, three], batch);
		expect(ids.length).toBe(2 * 32);
		expect(attention.length).toBe(2 * 32);
		// Row 0 ids land at offset 0; trailing pad slots stay zero with no attention.
		expect(Array.from(ids.slice(0, two.ids.length), Number)).toEqual(two.ids);
		expect(Array.from(ids.slice(two.ids.length, 32), Number)).toEqual(Array(32 - two.ids.length).fill(0));
		expect(Array.from(attention.slice(0, two.ids.length))).toEqual(Array(two.ids.length).fill(1n));
		expect(Array.from(attention.slice(two.ids.length, 32))).toEqual(Array(32 - two.ids.length).fill(0n));
		// Row 1 starts at offset 32; its 31 ids land followed by one zero pad.
		expect(Array.from(ids.slice(32, 32 + three.ids.length), Number)).toEqual(three.ids);
		expect(Number(ids[63])).toBe(0);
		expect(Number(attention[63])).toBe(0);
		// Marker positions land per row; the padded third option slot of row 0 stays zero.
		expect(Array.from(positions.slice(0, 3))).toEqual([BigInt(two.markers[0]!), BigInt(two.markers[1]!), 0n]);
		expect(Array.from(positions.slice(3, 6))).toEqual(three.markers.map(BigInt));
		expect(Array.from(mask.slice(0, 3))).toEqual([1, 1, 0]);
		expect(Array.from(mask.slice(3, 6))).toEqual([1, 1, 1]);
		expect(Array.from(qtype)).toEqual([BigInt(two.qtype), BigInt(three.qtype)]);
	});

	it("slices flat logits back into per-question rows (padded option slots carry no logits)", () => {
		const logits = sliceJudgeLogits(["a", "b"], [2, 3], [0.1, 0.2, 0, 0.3, 0.4, 0.5], 3);
		expect(logits).toEqual({ a: [0.1, 0.2], b: [0.3, 0.4, 0.5] });
		expect(Object.values(logits).map(row => row.length)).toEqual([2, 3]);
	});
});
