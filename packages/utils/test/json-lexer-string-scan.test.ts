import { afterEach, describe, expect, it, vi } from "bun:test";
import { JsonLexer, QUOTE } from "@oh-my-pi/pi-utils/json-lexer";
import { parseStreamingJson } from "@oh-my-pi/pi-utils/json-parse";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Best-of-5 wall time to lex `units` copies of `unit` as one string, `runs` times. */
function lexCost(unit: string, units: number, runs: number): number {
	const src = `"${unit.repeat(units)}"`;
	let best = Number.POSITIVE_INFINITY;
	for (let trial = 0; trial < 5; trial++) {
		const start = performance.now();
		for (let run = 0; run < runs; run++) new JsonLexer(src, "strict").string(QUOTE);
		best = Math.min(best, performance.now() - start);
	}
	return best;
}

/** `indexOf` calls made while running `fn`, by searched needle. */
function countSearches(fn: () => void): string[] {
	const indexOf = vi.spyOn(String.prototype, "indexOf");
	fn();
	const needles = indexOf.mock.calls.map(args => String(args[0]));
	indexOf.mockRestore();
	return needles;
}

/**
 * Contract: `JsonLexer.string()` scans a string in linear time whatever its
 * escape density, and decodes it exactly. Streaming tool-call arguments are
 * re-lexed on every growth step, so a superlinear scan on escape-heavy
 * payloads (Windows paths, escaped code) or on objects with many sibling
 * strings turns each partial parse into a stall.
 */
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
		let progress: unknown;
		const searches = countSearches(() => {
			progress = new JsonLexer(src, "strict").string(QUOTE);
		});

		expect(searches.length).toBeLessThan(16);
		expect(progress).toEqual({
			value: `${"\\".repeat(escapes)}${"x".repeat(64)}`,
			complete: true,
			stableLen: escapes + 64,
		});
	});

	it("keeps escape-dense strings linear", () => {
		// Equal total work at two sizes: 64 lexes of 2K units vs 8 lexes of 16K.
		// A linear scan costs about the same (ratio ~1); one that re-searches the
		// rest of the input per escape pays ~8x more on the long string (~5.5x
		// measured on the quadratic revision of this scan).
		const unit = "a\\\\";
		const ratio = lexCost(unit, 16_384, 8) / lexCost(unit, 2_048, 64);
		expect(ratio).toBeLessThan(3);

		const progress = new JsonLexer(`"${unit.repeat(4)}"`, "strict").string(QUOTE);
		expect(progress.complete).toBe(true);
		expect(progress.value).toBe("a\\".repeat(4));
	});

	it("does not re-search a distant closing quote after every mixed escape", () => {
		const src = `"${`${"a".repeat(64)}\\n`.repeat(4096)}${"x".repeat(64)}"`;
		let value: unknown;
		const searches = countSearches(() => {
			value = new JsonLexer(src, "strict").string(QUOTE).value;
		});

		expect(searches.filter(needle => needle === '"').length).toBeLessThan(16);
		expect(value).toBe(JSON.parse(src));
	});

	it("shares one backslash search across escape-free sibling strings", () => {
		// Without a backslash, each string's search runs to the end of the
		// document; repeating it per sibling string is quadratic in the object.
		const entries = Array.from({ length: 512 }, (_, k) => [`key${k}`, `value number ${k}`] as const);
		const json = JSON.stringify(Object.fromEntries(entries));
		// Drop the closing `}` so the lexer parses it, not the JSON.parse fast path.
		const partial = json.slice(0, -1);
		let parsed: unknown;
		const searches = countSearches(() => {
			parsed = parseStreamingJson(partial);
		});

		expect(searches.filter(needle => needle === "\\").length).toBeLessThan(4);
		expect(parsed).toEqual(Object.fromEntries(entries));
	});

	it("re-searches backslashes when the cursor moves before the cached range", () => {
		const first = '"a\\nb"';
		const src = `${first} "${"x".repeat(64)}"`;
		const lexer = new JsonLexer(src, "strict", first.length + 1);
		expect(lexer.string(QUOTE).value).toBe("x".repeat(64));

		lexer.pos = 0;
		expect(lexer.string(QUOTE)).toEqual({ value: "a\nb", complete: true, stableLen: 3 });
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
		// No closing `"}`: complete JSON would take the JSON.parse fast path.
		expect(parseStreamingJson<{ text: string }>(`{"text":"${prefix}\\uD83D\\uDE00`)).toEqual({
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
