import { describe, expect, it } from "bun:test";
import { truncateAgentDescription } from "..";

describe("truncateAgentDescription", () => {
	it("returns short single-paragraph descriptions unchanged", () => {
		const description = "Runs read-only repo searches across the codebase.";
		expect(truncateAgentDescription(description)).toBe(description);
	});

	it("keeps only the first paragraph when front-matter contains multiple blocks", () => {
		const description = [
			"First paragraph summary that explains what the agent does.",
			"",
			"Second paragraph with front-matter metadata that should be dropped.",
			"",
			"Third paragraph that callers never see.",
		].join("\n");
		const out = truncateAgentDescription(description);
		expect(out).toBe("First paragraph summary that explains what the agent does.");
		expect(out).not.toContain("Second paragraph");
		expect(out).not.toContain("Third paragraph");
	});

	it("collapses internal newlines inside the first paragraph into single spaces", () => {
		const description = "Line one of the description.\nLine two continues.\n  Line three wrapped.";
		expect(truncateAgentDescription(description)).toBe(
			"Line one of the description. Line two continues. Line three wrapped.",
		);
	});

	it("caps output at <= 301 chars when no sentence boundary is found before 300", () => {
		const longRunOn = "x".repeat(400);
		const out = truncateAgentDescription(longRunOn);
		expect(out.length).toBeLessThanOrEqual(301);
		expect(out.endsWith("…")).toBe(true);
	});

	it("cuts at the last sentence boundary when one exists at or before char 300", () => {
		const description = `${"a".repeat(50)}. ${"b".repeat(50)}. ${"c".repeat(300)}`;
		const out = truncateAgentDescription(description);
		// Two sentences before the long run; expect the cut after the second period.
		expect(out).toBe(`${"a".repeat(50)}. ${"b".repeat(50)}.`);
		expect(out.length).toBeLessThanOrEqual(301);
		expect(out.endsWith("…")).toBe(false);
	});

	it("falls back to a hard cut at 300 chars when no sentence boundary exists past char 80", () => {
		const description = `${"a".repeat(50)} ${"b".repeat(50)} ${"c".repeat(300)}`;
		const out = truncateAgentDescription(description);
		expect(out.length).toBe(301); // 300 chars + ellipsis
		expect(out.endsWith("…")).toBe(true);
		expect(out.startsWith("a".repeat(50))).toBe(true);
	});

	it("treats 300 chars exactly as under the cap and returns the input untouched", () => {
		const description = `${"x".repeat(300)}`;
		expect(truncateAgentDescription(description)).toBe(description);
	});
});
