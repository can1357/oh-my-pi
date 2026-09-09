import { describe, expect, test } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { formatArgsInline } from "../../src/tools/json-tree";

describe("formatArgsInline", () => {
	test("a trailing scalar grows into the available width instead of a fixed cap", () => {
		// Regression: the value used to be hard-capped at 24 columns, so a long
		// note was truncated even when the card had plenty of room (issue: advise
		// preview cut to `note="Your “stric…"`).
		const note = "x".repeat(200);
		const narrow = formatArgsInline({ severity: "concern", note }, 40);
		const wide = formatArgsInline({ severity: "concern", note }, 120);
		expect(Bun.stringWidth(wide)).toBeGreaterThan(Bun.stringWidth(narrow) + 40);
		// Both stay within their budget.
		expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(40);
		expect(Bun.stringWidth(wide)).toBeLessThanOrEqual(120);
	});

	test("every key stays visible even when a leading value is long", () => {
		const out = formatArgsInline({ path: "x".repeat(200), pattern: "needle", limit: 5 }, 80);
		expect(out).toContain("path=");
		expect(out).toContain("pattern=");
		expect(out).toContain("limit=");
		expect(Bun.stringWidth(out)).toBeLessThanOrEqual(80);
	});

	test("short values render fully without truncation markers", () => {
		expect(formatArgsInline({ a: "x", b: 5, c: true }, 80)).toBe('a="x", b=5, c=true');
	});

	test("hidden meta keys are skipped", () => {
		const out = formatArgsInline({ [INTENT_FIELD]: "noise", __partialJson: "{}", path: "src/foo.ts" }, 80);
		expect(out).toBe('path="src/foo.ts"');
	});
});
