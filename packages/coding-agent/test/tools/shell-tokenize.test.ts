import { describe, expect, it } from "bun:test";
import { lexShellCommand, readShellWord } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";

describe("lexShellCommand", () => {
	it("splits words from separators, keeping verbatim spelling beside the quote-removed value", () => {
		const command = `git -C "my repo" log && echo 'a b' 2>&1`;
		const tokens = lexShellCommand(command);
		// Rewriters reassemble commands from `raw`, so the pieces must reproduce the input exactly.
		expect(tokens.map(token => token.raw).join("")).toBe(command);
		expect(tokens.filter(token => token.kind === "word").map(token => token.value)).toEqual([
			"git",
			"-C",
			"my repo",
			"log",
			"echo",
			"a b",
			"2>",
			"1",
		]);
	});
});

describe("readShellWord", () => {
	it("reads a bare whitespace-delimited token", () => {
		expect(readShellWord("bun test extra")).toEqual({ value: "bun", rest: "test extra" });
	});

	it("reads a fully quoted value and preserves internal whitespace", () => {
		expect(readShellWord('"bun test" fix it')).toEqual({ value: "bun test", rest: "fix it" });
		expect(readShellWord("'bun test' fix it")).toEqual({ value: "bun test", rest: "fix it" });
	});

	// Regression: an `indexOf`-based scanner treats an escaped instance of the
	// outer delimiter as the closing quote, silently truncating the value.
	it("keeps an escaped instance of the outer delimiter inside the value", () => {
		expect(readShellWord(`"node -e \\"process.exit(0)\\"" fix it`)).toEqual({
			value: 'node -e "process.exit(0)"',
			rest: "fix it",
		});
		expect(readShellWord(`"test \\"$READY\\" = yes" continue`)).toEqual({
			value: 'test "$READY" = yes',
			rest: "continue",
		});
	});

	// Regression: a scanner that only checks space/tab does not end a quoted
	// value at a newline, so a multiline invocation folds the next line's
	// prompt text into the condition command.
	it("stops on a newline or carriage return, not just space and tab", () => {
		expect(readShellWord("'bun test'\nfix the tests")).toEqual({ value: "bun test", rest: "fix the tests" });
		expect(readShellWord("bun\ntest")).toEqual({ value: "bun", rest: "test" });
		expect(readShellWord("bun\r\ntest")).toEqual({ value: "bun", rest: "test" });
	});

	it("does not un-escape inside single quotes", () => {
		expect(readShellWord(String.raw`'a\"b' rest`)).toEqual({ value: 'a\\"b', rest: "rest" });
	});

	it("reports an unterminated quote", () => {
		expect(readShellWord('"bun test')).toBe("unterminated");
		expect(readShellWord("'bun test")).toBe("unterminated");
	});

	it("returns undefined for empty or all-whitespace input", () => {
		expect(readShellWord("")).toBeUndefined();
		expect(readShellWord("   ")).toBeUndefined();
	});
});
