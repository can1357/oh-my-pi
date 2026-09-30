import { describe, expect, it } from "bun:test";
import { ReferenceCaption } from "../src/components/reference-caption";

const TITLE = "feat(tui): anchor the #N reference popup at the typed token";

function render(title: string | undefined, width: number): string[] {
	const caption = new ReferenceCaption();
	caption.set(title);
	return caption.render(width).map(row => Bun.stripANSI(row));
}

describe("ReferenceCaption", () => {
	it("draws nothing without a title", () => {
		expect(render(undefined, 40)).toEqual([]);
		expect(render("   ", 40)).toEqual([]);
	});

	it("shows a short title on one row under the marker", () => {
		expect(render("Fix resize", 20)).toEqual(["  >Fix resize       "]);
	});

	it("wraps a long title and indents the continuation under the text", () => {
		const rows = render(TITLE, 30);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows[0]!.startsWith("  >feat")).toBe(true);
		for (const row of rows.slice(1)) expect(row.startsWith("    ")).toBe(true);
		// Nothing is lost by wrapping: the words come back in order.
		expect(rows.map(row => row.replace(/^ {2}>?/, "").trim()).join(" ")).toBe(TITLE);
	});

	it("never draws a row wider than the card", () => {
		for (const width of [8, 20, 30, 45]) {
			for (const row of render(TITLE, width)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("removes escape sequences, bells and tabs from a title fetched from elsewhere", () => {
		const rows = render("ok\x1b[31mred\x07\tend", 40).join("\n");
		expect(rows).not.toContain("\x1b");
		expect(rows).not.toContain("\x07");
		expect(rows).not.toContain("\t");
		expect(rows).toContain("okred end");
	});

	it("returns the same rows while nothing changed and new rows when the title does", () => {
		const caption = new ReferenceCaption();
		caption.set("first");
		const a = caption.render(30);
		expect(caption.render(30)).toBe(a);
		expect(caption.set("first")).toBe(false);
		expect(caption.set("second")).toBe(true);
		expect(caption.render(30)).not.toBe(a);
		expect(caption.render(31)).not.toBe(caption.render(30));
	});
});
