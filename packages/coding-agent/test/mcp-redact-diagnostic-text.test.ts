/**
 * `redactDiagnosticText` removes Bun's trailing fetch hint before an MCP error
 * is shown. It must remove every trailing hint in one pass (so a caller that
 * budgets redacted text loses nothing when the error redacts it again), and
 * it must stay linear on large error text (PR #17799 review, rounds 6 and 7).
 */
import { describe, expect, it } from "bun:test";
import {
	redactCredentials,
	redactDiagnosticText,
	stripTrailingFetchAdvice,
} from "@oh-my-pi/pi-coding-agent/mcp/errors";

const HINT = "For more information, pass `verbose: true` in the second argument to fetch().";

describe("stripTrailingFetchAdvice", () => {
	it("removes one or many trailing hints and the whitespace around them", () => {
		for (const count of [1, 2, 3, 50]) {
			expect(stripTrailingFetchAdvice(`REFUSED\n${`${HINT}\n`.repeat(count)}`)).toBe("REFUSED");
		}
		expect(stripTrailingFetchAdvice(`REFUSED ${HINT.toUpperCase()}  `)).toBe("REFUSED");
		expect(stripTrailingFetchAdvice(`REFUSED ${HINT.slice(0, -1)}`)).toBe("REFUSED");
	});

	it("removes a hint cut off at the end only after complete hints", () => {
		expect(stripTrailingFetchAdvice(`REFUSED\n${HINT}\n${HINT.slice(0, 30)}`)).toBe("REFUSED");
		expect(stripTrailingFetchAdvice(`REFUSED\n${HINT.slice(0, 30)}`)).toBe(`REFUSED\n${HINT.slice(0, 30)}`);
		expect(stripTrailingFetchAdvice("REFUSED for")).toBe("REFUSED for");
	});

	it("keeps text that does not end in a hint, unchanged", () => {
		for (const value of ["REFUSED  ", `${HINT} REFUSED`, `${HINT}!`, "fetch().", ""]) {
			expect(stripTrailingFetchAdvice(value)).toBe(value);
		}
	});

	it("makes redaction idempotent", () => {
		const value = `token=abc api_key=secret Bearer xyz\n${HINT}\n${HINT}`;
		const once = redactDiagnosticText(value);
		expect(redactDiagnosticText(once)).toBe(once);
		expect(once).not.toContain("verbose: true");
	});

	// Round 11: `H + "F" + H` lost its last hint to one pass and the rest to a
	// second, so an error built from once-redacted text dropped the reason the
	// report had budgeted for. Every short mix of hints, cut-off hints and
	// separators must reach its end in one pass.
	it("is idempotent for every short mix of hints and cut-off hints", () => {
		const complete = HINT.slice(0, -1);
		const pieces = [complete, HINT, HINT.toUpperCase(), "F", "f", "For", complete.slice(0, 30), "fetch()", "x", ""];
		const separators = ["", " ", "\n", "."];
		let checked = 0;
		for (const a of pieces) {
			for (const b of pieces) {
				for (const c of pieces) {
					for (const s of separators) {
						for (const t of separators) {
							const value = `REASON ${a}${s}${b}${t}${c}`;
							const once = redactDiagnosticText(value);
							expect(redactDiagnosticText(once), JSON.stringify(value)).toBe(once);
							expect(once.startsWith("REASON"), JSON.stringify(value)).toBe(true);
							checked++;
						}
					}
				}
			}
		}
		expect(checked).toBe(16_000);
		expect(stripTrailingFetchAdvice(`REASON ${complete}F${complete}`)).toBe("REASON");
		expect(stripTrailingFetchAdvice(`REASON ${complete}\nF\n${complete}`)).toBe("REASON");
	});

	// Round 10: the stderr tail redacts every word with its context, so stderr
	// pays this per word. 1 MiB of "noise " cost about 4 s of CPU before; round
	// 11: 1 MiB of "ff " still did, because each word also searched for a hint.
	for (const word of ["noise", "ffff)", "fF".repeat(32)]) {
		it(`costs little per stderr word like ${JSON.stringify(word.slice(0, 8))}`, () => {
			const context = `${word} `.repeat(10);
			const started = process.cpuUsage();
			for (let i = 0; i < 175_000; i++) {
				redactCredentials(context);
				redactCredentials(`${context}${word}`);
			}
			const used = process.cpuUsage(started);
			expect((used.user + used.system) / 1000).toBeLessThan(1_500);
		});
	}

	it("stays linear on megabytes of near-miss hints", () => {
		const nearMiss = `${HINT}\n`.repeat(40_000) + "!";
		const started = performance.now();
		expect(stripTrailingFetchAdvice(nearMiss)).toBe(nearMiss);
		// It compares fixed suffixes only. The previous pattern backtracked
		// through every hint: about a second for input this size.
		expect(performance.now() - started).toBeLessThan(250);
	});
});
