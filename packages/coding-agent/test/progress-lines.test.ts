import { describe, expect, test } from "bun:test";
import { type ProgressLine, ProgressLines } from "../src/async/progress-lines";

describe("ProgressLines", () => {
	test("does not split a surrogate pair at the retained head boundary", () => {
		const reported: ProgressLine[] = [];
		const lines = new ProgressLines(line => reported.push(line));
		const head = "h".repeat(249);
		const tail = "t".repeat(250);

		lines.append(`${head}😀${tail}\n`);

		expect(reported).toMatchObject([{ text: `${head}${tail}`, truncated: true }]);
		expect(reported[0]?.text.isWellFormed()).toBeTrue();
	});

	test("does not split a surrogate pair at the retained tail boundary", () => {
		const reported: ProgressLine[] = [];
		const lines = new ProgressLines(line => reported.push(line));
		const head = "h".repeat(250);
		const tail = "t".repeat(249);

		lines.append(`${head}😀${tail}\n`);

		expect(reported).toMatchObject([{ text: `${head}${tail}`, truncated: true }]);
		expect(reported[0]?.text.isWellFormed()).toBeTrue();
	});
});
