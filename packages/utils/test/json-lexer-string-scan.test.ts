import { afterEach, describe, expect, it, vi } from "bun:test";
import { JsonLexer, QUOTE } from "@oh-my-pi/pi-utils/json-lexer";
import { parseStreamingJson } from "@oh-my-pi/pi-utils/json-parse";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("JsonLexer string scan", () => {
	it("does not re-search the remaining input once per adjacent escape", () => {
		const escapes = 4096;
		const src = `"${"\\\\".repeat(escapes)}${"x".repeat(64)}"`;
		const indexOf = vi.spyOn(String.prototype, "indexOf");
		const progress = new JsonLexer(src, "strict").string(QUOTE);
		const searches = indexOf.mock.calls.length;
		indexOf.mockRestore();

		expect(searches).toBeLessThan(16);
		expect(progress).toEqual({
			value: `${"\\".repeat(escapes)}${"x".repeat(64)}`,
			complete: true,
			stableLen: escapes + 64,
		});
	});

	it("does not re-search a distant closing quote after every mixed escape", () => {
		const src = `"${`${"a".repeat(64)}\\n`.repeat(4096)}${"x".repeat(64)}"`;
		const indexOf = vi.spyOn(String.prototype, "indexOf");
		const progress = new JsonLexer(src, "strict").string(QUOTE);
		const quoteSearches = indexOf.mock.calls.filter(args => args[0] === '"').length;
		indexOf.mockRestore();

		expect(quoteSearches).toBeLessThan(16);
		expect(progress.value).toBe(JSON.parse(src));
	});

	it("decodes long mixed runs of text and escapes", () => {
		const body = 'C:\\\\Users\\\\me\\\\file \\"quoted\\" \\n line \\u00e9 '.repeat(400);
		const src = `"${body}"`;
		expect(new JsonLexer(src, "strict").string(QUOTE).value).toBe(JSON.parse(src));
	});

	it("keeps a trailing split escape unstable after skipping a long run", () => {
		const prefix = "x".repeat(128);
		expect(new JsonLexer(`"${prefix}\\uD83D`, "incoming").string(QUOTE)).toEqual({
			value: `${prefix}\ud83d`,
			stableLen: prefix.length,
			complete: false,
		});
		expect(parseStreamingJson<{ text: string }>(`{"text":"${prefix}\\uD83D\\uDE00"}`)).toEqual({
			text: `${prefix}😀`,
		});
	});

	it("preserves inner quote recovery and following fields after a long run", () => {
		const prefix = "x".repeat(128);
		expect(
			parseStreamingJson<{ text: string; next: number }>(`{"text":"${prefix}say "hello" again", "next": 1}`),
		).toEqual({
			text: `${prefix}say "hello" again`,
			next: 1,
		});
	});
});
