import { describe, expect, it } from "bun:test";
import { buildLineEntriesWithBlockContext, findBlockContextLines } from "../src/utils/block-context";

describe("block context for partial reads", () => {
	it("keeps disjoint selections in order when text has no bracket boundaries", () => {
		const lines = ["first", "second", "third", "fourth", "fifth"];
		expect(
			buildLineEntriesWithBlockContext(lines, [
				{ startLine: 2, endLine: 2 },
				{ startLine: 4, endLine: 4 },
			]),
		).toEqual([
			{ kind: "line", lineNumber: 2, text: "second", context: false },
			{ kind: "ellipsis" },
			{ kind: "line", lineNumber: 4, text: "fourth", context: false },
		]);
	});

	it("finds all lexical bracket pairs while ignoring comments and quoted brackets", () => {
		const lines = ["/* { */", "'['", '"("', "(", "plain", ")", "[", "plain", "]", "{", "plain", "}"];
		expect([...findBlockContextLines(lines, [4, 7, 10])]).toEqual([
			[6, ")"],
			[9, "]"],
			[12, "}"],
		]);
		expect([...findBlockContextLines(lines, [6, 9, 12])]).toEqual([
			[4, "("],
			[7, "["],
			[10, "{"],
		]);
	});

	it("retains native indentation boundaries for Python without brackets", () => {
		const lines = ["if True:", "    value = 1", "    result = value", "outside = 2"];
		const context = findBlockContextLines(lines, [1], { path: "fixture.py" });
		expect(context.get(3)).toBe("    result = value");
		expect(context.has(4)).toBe(false);
	});
});
