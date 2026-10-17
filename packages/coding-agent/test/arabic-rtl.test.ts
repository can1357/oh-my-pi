import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER, visibleWidth } from "@oh-my-pi/pi-tui";
import { createArabicRowRenderer } from "../examples/extensions/arabic-rtl";

describe.skipIf(process.platform !== "win32")("Windows Arabic display extension", () => {
	test("joins letters and puts an Arabic word in visual order", () => {
		const render = createArabicRowRenderer();
		// Beh initial + teh final in logical order become teh final + beh initial.
		expect(Bun.stripANSI(render("بت"))).toBe("\ufe96\ufe91");
	});

	test("lam-alef keeps both editor cells and the logical cursor boundary", () => {
		const render = createArabicRowRenderer();
		const row = `ل${CURSOR_MARKER}ا`;
		const visual = render(row);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toBe("\ufe8e\ufedf");
		expect(visual.split(CURSOR_MARKER)).toHaveLength(2);
		expect(visibleWidth(visual.slice(0, visual.indexOf(CURSOR_MARKER)))).toBe(1);
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test("diacritics stay attached to their base letter without adding cells", () => {
		const render = createArabicRowRenderer();
		const row = "بَت";
		expect(Bun.stripANSI(render(row))).toBe("\ufe96\ufe91َ");
		expect(visibleWidth(render(row))).toBe(visibleWidth(row));
	});

	test("reordering keeps colors with letters and leaves table cells separate", () => {
		const render = createArabicRowRenderer();
		const row = "│ \x1b[31mب\x1b[32mت\x1b[0m │ path/file.ts 123 │";
		const visual = render(row);
		expect(Bun.stripANSI(visual)).toBe("│ \ufe96\ufe91 │ path/file.ts 123 │");
		expect(visual).toContain("\x1b[32m\ufe96");
		expect(visual).toContain("\x1b[0m\x1b[31m\ufe91");
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});
});
