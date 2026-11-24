import { describe, expect, it } from "bun:test";
import { defaultFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";

function preBlocks(html: string): string[] {
	return parseHtmlForm(html).sections.flatMap(section =>
		section.blocks.flatMap(block => (block.kind === "pre" ? [block.text] : [])),
	);
}

describe("parseHtmlForm leading line breaks", () => {
	it("prefills a textarea without the one line break after its start tag, source or character reference", () => {
		const form = parseHtmlForm(
			"<form><textarea name=a>&#10;line</textarea><textarea name=b>\n&#10;line</textarea><textarea name=c>\n\nline</textarea></form>",
		);
		expect(defaultFormData(form)).toEqual({ a: "line", b: "\nline", c: "\nline" });
	});

	it("drops one line break after <pre>, and the one opening a nested <code> for display", () => {
		expect(preBlocks("<form><pre>\n\ncode</pre><pre><code>\nnested</code></pre></form>")).toEqual([
			"\ncode",
			"nested",
		]);
	});
});
