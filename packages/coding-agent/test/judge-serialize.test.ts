import { describe, expect, it } from "bun:test";
import { packJudgeBatch, serializeJudgeRow } from "@oh-my-pi/pi-coding-agent/tiny/judge-serialize";

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
});
