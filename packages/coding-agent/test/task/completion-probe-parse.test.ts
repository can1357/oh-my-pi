/**
 * The completion probe's reply is model output: a JSON line by contract, but
 * fenced, wrapped in prose, or a bare percentage in practice. Whatever survives
 * parsing becomes the running row's percentage and stage line and the job
 * widget author's watch hint, so a mis-parse shows a wrong bar or a stray
 * label, and a reply that parses to nothing leaves the row unchanged.
 */
import { describe, expect, it } from "bun:test";
import { parseCompletionEstimate } from "@oh-my-pi/pi-coding-agent/task/completion-probe";

describe("parseCompletionEstimate", () => {
	it("reads the contract JSON line", () => {
		expect(
			parseCompletionEstimate(
				'{"pct": 40, "stage": "benchmarking the decoder", "watch": "BENCH lines in bg_2 pipe:1, tok_s higher is better"}',
			),
		).toEqual({
			percent: 40,
			stage: "benchmarking the decoder",
			watch: "BENCH lines in bg_2 pipe:1, tok_s higher is better",
		});
	});

	it("finds the object inside a code fence surrounded by prose, keeping braces inside strings", () => {
		const reply = 'Here is my estimate:\n```json\n{"pct": "65%", "stage": "wiring {tap} into the job"}\n```\nThanks.';
		expect(parseCompletionEstimate(reply)).toEqual({ percent: 65, stage: "wiring {tap} into the job" });
	});

	it("clamps and rounds pct, flattens and caps stage and watch, and drops non-string fields", () => {
		const estimate = parseCompletionEstimate(
			JSON.stringify({ pct: 140.6, stage: `  line one\n\tline two ${"x".repeat(120)}`, watch: 42 }),
		);
		expect(estimate?.percent).toBe(100);
		expect(estimate?.watch).toBeUndefined();
		expect(estimate?.stage?.startsWith("line one line two x")).toBe(true);
		expect(estimate?.stage?.length).toBe(80);
		expect(estimate?.stage?.endsWith("…")).toBe(true);
		expect(parseCompletionEstimate('{"pct": -5}')).toEqual({ percent: 0 });
	});

	it("falls back to a plain percentage, keeping a stage from JSON that lacked a usable pct", () => {
		expect(parseCompletionEstimate("Roughly 70%.")).toEqual({ percent: 70 });
		expect(parseCompletionEstimate('{"pct": "most", "stage": "running tests"} so about 85%')).toEqual({
			percent: 85,
			stage: "running tests",
		});
	});

	it("returns undefined for malformed JSON without any percentage", () => {
		expect(parseCompletionEstimate('{"pct": 40, "stage": "unterminated')).toBeUndefined();
		expect(parseCompletionEstimate('{"stage": "no number"}')).toBeUndefined();
		expect(parseCompletionEstimate("I cannot tell yet.")).toBeUndefined();
	});
});
