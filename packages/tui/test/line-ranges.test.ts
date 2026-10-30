import { describe, expect, it } from "bun:test";
import { parseLineRangeChunk, parseLineRanges, selectorLineRanges } from "../src/tools/line-ranges";

describe("parseLineRanges bare numbers", () => {
	it("reads a lone bare number from that line onward", () => {
		expect(parseLineRanges("50")).toEqual([{ startLine: 50, endLine: undefined }]);
		expect(parseLineRangeChunk("50")).toEqual({ startLine: 50, endLine: undefined });
	});

	it("pins bare numbers in a comma list to single lines", () => {
		expect(parseLineRanges("59,19")).toEqual([
			{ startLine: 19, endLine: 19 },
			{ startLine: 59, endLine: 59 },
		]);
		expect(parseLineRanges("L19,L59")).toEqual([
			{ startLine: 19, endLine: 19 },
			{ startLine: 59, endLine: 59 },
		]);
	});

	it("keeps explicit open-ended chunks open inside a list", () => {
		expect(parseLineRanges("19,59-")).toEqual([
			{ startLine: 19, endLine: 19 },
			{ startLine: 59, endLine: undefined },
		]);
	});

	it("merges a pinned line into an adjacent range", () => {
		expect(parseLineRanges("5-10,11")).toEqual([{ startLine: 5, endLine: 11 }]);
	});

	it("pins a lone bare number compounded with raw to that line", () => {
		expect(selectorLineRanges("17:raw")).toEqual([{ startLine: 17, endLine: 17 }]);
		expect(selectorLineRanges("raw:17")).toEqual([{ startLine: 17, endLine: 17 }]);
		expect(selectorLineRanges("17-:raw")).toEqual([{ startLine: 17, endLine: undefined }]);
		expect(selectorLineRanges("17")).toEqual([{ startLine: 17, endLine: undefined }]);
	});
});
