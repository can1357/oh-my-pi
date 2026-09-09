/**
 * Contract tests for `enforceInlineByteCap`, the final-defense inline size
 * guard at the tool-result boundary (bash, browser). Over-cap text keeps a
 * head (~60% of budget) and tail (~25%) cut on line boundaries with an
 * elision marker between; sub-cap text passes through untouched so existing
 * bounded-output paths (bash sink/minimizer) see zero behavior change.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap } from "@oh-my-pi/pi-coding-agent/session/streaming-output";

const MARKER_PATTERN = /\[…\d+B elided…\]/;

/** Build `count` complete lines of the form `line-00001 <pad>`. */
function makeLines(count: number, pad = "x".repeat(40)): string {
	const lines: string[] = [];
	for (let i = 1; i <= count; i++) {
		lines.push(`line-${String(i).padStart(5, "0")} ${pad}`);
	}
	return lines.join("\n");
}

describe("enforceInlineByteCap", () => {
	it("returns sub-cap text unchanged (identity, not just equality)", async () => {
		const text = makeLines(10);
		const result = await enforceInlineByteCap(text, { maxBytes: 4096 });
		expect(result).toBe(text);
	});

	it("returns text exactly at the cap unchanged", async () => {
		const text = "a".repeat(1000);
		expect(Buffer.byteLength(text, "utf-8")).toBe(1000);
		const result = await enforceInlineByteCap(text, { maxBytes: 1000 });
		expect(result).toBe(text);
	});

	it("uses DEFAULT_MAX_BYTES when maxBytes is omitted", async () => {
		const under = "a".repeat(DEFAULT_MAX_BYTES - 1);
		expect(await enforceInlineByteCap(under, {})).toBe(under);

		const over = makeLines(2000); // ~94KB, well over the 50KB default
		expect(Buffer.byteLength(over, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);
		const result = await enforceInlineByteCap(over, {});
		expect(result).not.toBe(over);
		expect(result).toMatch(MARKER_PATTERN);
		expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("elides over-cap text to head + tail on line boundaries within the budget", async () => {
		const maxBytes = 4096;
		const text = makeLines(500); // ~23KB
		const result = await enforceInlineByteCap(text, { maxBytes });

		expect(result).toMatch(MARKER_PATTERN);
		// Stays within the cap plus a sliver of slack for the marker line.
		expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(maxBytes + 256);

		const lines = result.split("\n");
		const markerIdx = lines.findIndex(line => MARKER_PATTERN.test(line));
		expect(markerIdx).toBeGreaterThan(0);
		expect(markerIdx).toBeLessThan(lines.length - 1);

		// Head starts at the very beginning; tail ends at the very end.
		expect(lines[0]).toBe(`line-00001 ${"x".repeat(40)}`);
		expect(lines[lines.length - 1]).toBe(`line-00500 ${"x".repeat(40)}`);

		// Line-boundary cuts: the lines flanking the marker are complete input lines.
		const completeLine = /^line-\d{5} x{40}$/;
		expect(lines[markerIdx - 1]).toMatch(completeLine);
		expect(lines[markerIdx + 1]).toMatch(completeLine);

		// Head should be roughly 60% and tail roughly 25% of the budget.
		const headBytes = Buffer.byteLength(lines.slice(0, markerIdx).join("\n"), "utf-8");
		const tailBytes = Buffer.byteLength(lines.slice(markerIdx + 1).join("\n"), "utf-8");
		expect(headBytes).toBeLessThanOrEqual(Math.floor(maxBytes * 0.6));
		expect(tailBytes).toBeLessThanOrEqual(Math.floor(maxBytes * 0.25));
		expect(headBytes).toBeGreaterThan(tailBytes);
	});

	it("does not corrupt multi-byte UTF-8 near the cut boundaries", async () => {
		// Each line is multi-byte heavy: é (2B), € (3B), 😀 (4B).
		const text = makeLines(800, "é€😀".repeat(12));
		const maxBytes = 4096;
		const result = await enforceInlineByteCap(text, { maxBytes });

		expect(result).toMatch(MARKER_PATTERN);
		// Valid UTF-8 round-trip: encode/decode is lossless and introduces no
		// replacement characters (the input contains none).
		const roundTripped = Buffer.from(result, "utf-8").toString("utf-8");
		expect(roundTripped).toBe(result);
		expect(result.includes("\uFFFD")).toBe(false);

		// Every kept content line is a complete, uncorrupted input line.
		const completeLine = /^line-\d{5} (?:é€😀){12}$/u;
		for (const line of result.split("\n")) {
			if (MARKER_PATTERN.test(line)) continue;
			expect(line).toMatch(completeLine);
		}
	});

	it("appends the artifact footer when saveArtifact yields an id", async () => {
		const text = makeLines(500);
		let saved: string | undefined;
		const result = await enforceInlineByteCap(text, {
			maxBytes: 4096,
			saveArtifact: full => {
				saved = full;
				return Promise.resolve("17");
			},
		});
		// saveArtifact receives the full original text, not the elided version.
		expect(saved).toBe(text);
		expect(result.endsWith("[raw output: artifact://17]")).toBe(true);
		expect(result).toMatch(MARKER_PATTERN);
	});

	it("omits the footer when saveArtifact returns undefined", async () => {
		const text = makeLines(500);
		const result = await enforceInlineByteCap(text, {
			maxBytes: 4096,
			saveArtifact: () => undefined,
		});
		expect(result).not.toContain("[raw output: artifact://");
		expect(result).toMatch(MARKER_PATTERN);
	});

	it("does not invoke saveArtifact for sub-cap text", async () => {
		let called = false;
		const text = "short output";
		const result = await enforceInlineByteCap(text, {
			maxBytes: 4096,
			saveArtifact: () => {
				called = true;
				return "99";
			},
		});
		expect(result).toBe(text);
		expect(called).toBe(false);
	});
});
