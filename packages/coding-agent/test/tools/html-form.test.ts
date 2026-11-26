/** `tools/html-form`: how `parseHtmlForm` styles `<mark>` runs among other inline emphasis. */
import { describe, expect, it } from "bun:test";
import { parseHtmlForm } from "../../src/tools/html-form/parse";

describe("html form mark spans", () => {
	it("gives a <mark> inside <strong> its own style", () => {
		const html = `<form><p>a <strong>b <mark>c</mark></strong> d</p></form>`;
		expect(parseHtmlForm(html).sections[0]!.blocks[0]).toMatchObject({
			spans: [{ text: "a " }, { text: "b ", style: "strong" }, { text: "c", style: "mark" }, { text: " d" }],
		});
	});
});
