import { describe, expect, it } from "bun:test";
import { JsonLexer } from "@oh-my-pi/pi-utils/json-lexer";

const QUOTE = 0x22;

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

/**
 * Contract: `JsonLexer.string()` scans a string in linear time whatever its
 * escape density, and decodes it exactly. Streaming tool-call arguments are
 * re-lexed on every growth step, so a superlinear scan on escape-heavy
 * payloads (Windows paths, escaped code) turns each partial parse into a
 * stall.
 */
describe("JsonLexer string scan", () => {
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

	it("decodes long mixed runs of text and escapes like the per-character scan", () => {
		const body = 'C:\\\\Users\\\\me\\\\file \\"quoted\\" \\n line \\u00e9 '.repeat(400);
		const src = `"${body}"`;

		const progress = new JsonLexer(src, "strict").string(QUOTE);

		expect(progress.value).toBe(JSON.parse(src));
	});
});
