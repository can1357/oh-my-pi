import { afterEach, describe, expect, it, vi } from "bun:test";
import { JsonLexer, QUOTE } from "@oh-my-pi/pi-utils/json-lexer";
import { parseStreamingJson } from "@oh-my-pi/pi-utils/json-parse";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("JsonLexer string scan", () => {
	it.each([
		["`", 0x60],
		["「", 0x300c],
	] as const)("honors a nonstandard %s delimiter after a long run", (delimiter, quote) => {
		const prefix = "prefix: ";
		const value = "abc".repeat(32);
		const lexer = new JsonLexer(`${prefix}${delimiter}${value}${delimiter},next`, "strict", prefix.length);

		expect(lexer.string(quote)).toEqual({ value, complete: true, stableLen: value.length });
		expect(lexer.src.slice(lexer.pos)).toBe(",next");
	});

	it("does not reinterpret a wrapped delimiter as an escape while streaming", () => {
		const value = `${"abc".repeat(32)}\`,next`;
		const lexer = new JsonLexer(`\`${value}`, "incoming");
		expect(lexer.string(0x10060)).toEqual({ value, complete: false, stableLen: value.length });
	});

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

	it("avoids bulk searches for short ordinary runs between escapes", () => {
		const value = `${"a".repeat(31)}\n`.repeat(128);
		const src = JSON.stringify(value);
		const indexOf = vi.spyOn(String.prototype, "indexOf");
		const progress = new JsonLexer(src, "strict").string(QUOTE);
		const searches = indexOf.mock.calls.length;
		indexOf.mockRestore();

		expect(searches).toBeLessThan(16);
		expect(progress.value).toBe(value);
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
