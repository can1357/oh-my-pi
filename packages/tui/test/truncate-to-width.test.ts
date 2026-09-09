import { describe, expect, it } from "bun:test";
import { Ellipsis, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui/utils";

describe("truncateToWidth", () => {
	it("keeps output within width for very large unicode input", () => {
		const text = "🙂界".repeat(100_000);
		const truncated = truncateToWidth(text, 40, Ellipsis.Unicode);

		expect(visibleWidth(truncated)).toBeLessThanOrEqual(40);
	});

	it("preserves ANSI styling for kept text", () => {
		const text = `\x1b[31m${"hello ".repeat(1000)}\x1b[0m`;
		const truncated = truncateToWidth(text, 20, Ellipsis.Unicode);

		expect(visibleWidth(truncated)).toBeLessThanOrEqual(20);
		expect(truncated.includes("\x1b[31m")).toBe(true);
	});

	it("handles malformed ANSI escape prefixes without hanging", () => {
		const text = `abc\x1bnot-ansi ${"🙂".repeat(1000)}`;
		// Should complete without hanging — the exact width depends on how the
		// native implementation classifies the malformed escape prefix.
		const truncated = truncateToWidth(text, 20, Ellipsis.Unicode);
		expect(typeof truncated).toBe("string");
	});

	it("returns the original text when it already fits", () => {
		expect(truncateToWidth("a", 2, Ellipsis.Unicode)).toBe("a");
		expect(truncateToWidth("界", 2, Ellipsis.Unicode)).toBe("界");
	});

	it("pads truncated output to requested width", () => {
		const truncated = truncateToWidth("🙂界🙂界🙂界", 8, Ellipsis.Unicode, true);
		expect(visibleWidth(truncated)).toBe(8);
	});

	it("adds a trailing reset when truncating without an ellipsis", () => {
		const truncated = truncateToWidth(`\x1b[31m${"hello".repeat(100)}`, 10, Ellipsis.Omit);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(10);
		expect(truncated.endsWith("\x1b[0m")).toBe(true);
	});
});

describe("visibleWidth", () => {
	it("counts tabs inline and skips ANSI inline", () => {
		expect(visibleWidth("\t\x1b[31m界\x1b[0m")).toBe(5);
	});
});
