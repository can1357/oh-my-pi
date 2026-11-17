import { describe, expect, it } from "bun:test";
import { splitEmbeds } from "@oh-my-pi/pi-tui/chat/embed-source";
import { figureBox, parseFigureLength } from "@oh-my-pi/pi-tui/chat/figure-size";

describe("splitEmbeds", () => {
	it("lifts lines of img and iframe tags out of the prose around them", () => {
		const segments = splitEmbeds(
			[
				"Before",
				`<img src="shot.png" alt="A &amp; B" width="50%">`,
				"Between",
				`  <IMG SRC='a.png' height=40px/> <iframe src=https://example.com/?a=1&amp;b=2 title="Docs"></iframe>`,
				"After",
			].join("\n"),
		);
		expect(segments).toEqual([
			{ kind: "markdown", text: "Before\n" },
			{
				kind: "embed",
				embed: {
					kind: "img",
					src: "shot.png",
					label: "A & B",
					size: { width: { value: 50, unit: "%" }, height: undefined },
				},
			},
			{ kind: "markdown", text: "Between\n" },
			{
				kind: "embed",
				embed: {
					kind: "img",
					src: "a.png",
					label: "",
					size: { width: undefined, height: { value: 40, unit: "px" } },
				},
			},
			{
				kind: "embed",
				embed: {
					kind: "iframe",
					src: "https://example.com/?a=1&b=2",
					label: "Docs",
					size: { width: undefined, height: undefined },
				},
			},
			{ kind: "markdown", text: "After" },
		]);
	});

	it("leaves tags that are fenced, indented as code, mixed with text or without a src as prose", () => {
		const markdown = [
			"```html",
			`<img src="in-fence.png">`,
			"```",
			`    <img src="indented.png">`,
			`See <img src="inline.png"> here`,
			`<img src="a.png"> trailing words`,
			`<img alt="no source">`,
			`- <img src="in-list.png">`,
		].join("\n");
		expect(splitEmbeds(markdown)).toEqual([{ kind: "markdown", text: markdown }]);
	});

	it("keeps a line still being written as prose until its line break arrives", () => {
		const tag = `<img src="chart.png">`;
		expect(splitEmbeds(`Look:\n${tag}`, { streaming: true })).toEqual([{ kind: "markdown", text: `Look:\n${tag}` }]);
		expect(splitEmbeds(`Look:\n${tag}\n`, { streaming: true }).map(segment => segment.kind)).toEqual([
			"markdown",
			"embed",
		]);
	});
});

describe("parseFigureLength", () => {
	it("reads CSS lengths and rejects what is not a positive length in a known unit", () => {
		expect(parseFigureLength("320")).toEqual({ value: 320, unit: "px" });
		expect(parseFigureLength(" 12.5VW ")).toEqual({ value: 12.5, unit: "vw" });
		expect(parseFigureLength("50%")).toEqual({ value: 50, unit: "%" });
		for (const invalid of ["", "0", "-4", "auto", "1e3", "10pt", "50 %"]) {
			expect(parseFigureLength(invalid)).toBeUndefined();
		}
	});
});

describe("figureBox", () => {
	const room = { columns: 118, rows: 40 };
	const viewport = { columns: 120, rows: 50 };
	const hidpi = { widthPx: 16, heightPx: 36 };
	const box = (width: string | undefined, height: string | undefined, cell = hidpi) =>
		figureBox(
			{
				width: width ? parseFigureLength(width) : undefined,
				height: height ? parseFigureLength(height) : undefined,
			},
			{ room, cell, viewport, natural: { widthPx: 800, heightPx: 320 } },
		);

	it("sizes a stated side in its unit and leaves the other to the room", () => {
		expect(box("50%", undefined)).toEqual({ columns: 59, rows: 40 });
		expect(box("50vw", undefined)).toEqual({ columns: 60, rows: 40 });
		expect(box("30ch", "10em")).toEqual({ columns: 30, rows: 10 });
		expect(box(undefined, "50vh")).toEqual({ columns: 118, rows: 25 });
		// A height's percent is of the viewport: a transcript has no height of its own.
		expect(box(undefined, "50%")).toEqual({ columns: 118, rows: 25 });
	});

	it("takes the same cells for a px length whatever the terminal's pixel density", () => {
		expect(box("400", "160")).toEqual({ columns: 56, rows: 10 });
		expect(box("400", "160", { widthPx: 8, heightPx: 18 })).toEqual({ columns: 56, rows: 10 });
	});

	it("draws an unsized picture at its natural size, and nothing past the room", () => {
		expect(box(undefined, undefined)).toEqual({ columns: 113, rows: 20 });
		expect(box("300vw", "900")).toEqual(room);
	});
});
