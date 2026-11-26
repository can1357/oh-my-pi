/** `tools/html-form`: the span styles `parseHtmlForm` keeps, `<mark>` included. */
import { describe, expect, it } from "bun:test";
import { parseHtmlForm } from "../../src/tools/html-form/parse";

function firstBlock(html: string) {
	return parseHtmlForm(html).sections[0]!.blocks[0];
}

describe("html form mark spans", () => {
	it("keeps a <mark> in a label as a span of its own style", () => {
		expect(firstBlock(`<form><p>Watch <mark>this token</mark> closely</p></form>`)).toEqual({
			kind: "text",
			spans: [{ text: "Watch " }, { text: "this token", style: "mark" }, { text: " closely" }],
			heading: false,
		});
	});

	it("keeps each run's own style when <mark> sits inside <strong>", () => {
		expect(firstBlock(`<form><p>a <strong>b <mark>c</mark></strong> d</p></form>`)).toMatchObject({
			spans: [{ text: "a " }, { text: "b ", style: "strong" }, { text: "c", style: "mark" }, { text: " d" }],
		});
	});

	it("does not merge a <mark> with the <em> next to it", () => {
		expect(firstBlock(`<form><p>a <em>b</em><mark>c</mark> d <mark>e</mark><mark>f</mark></p></form>`)).toMatchObject(
			{
				spans: [
					{ text: "a " },
					{ text: "b", style: "em" },
					{ text: "c", style: "mark" },
					{ text: " d " },
					{ text: "ef", style: "mark" },
				],
			},
		);
	});

	it("keeps a <mark> inside a table cell", () => {
		expect(
			firstBlock(
				`<form><table><tr><th>Finding</th></tr><tr><td>Review <mark>stale</mark> token</td></tr></table></form>`,
			),
		).toEqual({
			kind: "table",
			rows: [[[{ text: "Finding" }]], [[{ text: "Review " }, { text: "stale", style: "mark" }, { text: " token" }]]],
			headerRows: 1,
		});
	});
});
