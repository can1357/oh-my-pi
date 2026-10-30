import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultMarkdownTheme } from "./test-themes.js";

// Four sixteen-cell words squeeze the trailing emoji column down to one cell.
// A two-cell glyph does not wrap at width 1, so without a clamp the rendered
// row is one cell too wide and the generic re-wrap moves its border to a new line.
const source = [
	"| 0123456789abcdef | 0123456789abcdef | 0123456789abcdef | 0123456789abcdef | ✅ |",
	"| --- | --- | --- | --- | --- |",
	"| 0123456789abcdef | 0123456789abcdef | 0123456789abcdef | 0123456789abcdef | ❌ |",
].join("\n");

describe("markdown table with a wide glyph in a one-cell column", () => {
	it("keeps every table row on one line at width 80", () => {
		const width = 80;
		const plain = new Markdown(source, 0, 0, defaultMarkdownTheme)
			.render(width)
			.map(line => stripVTControlCharacters(line).trimEnd());

		// Three border rows, header over two lines, body over two lines.
		expect(plain).toHaveLength(7);
		for (const line of plain) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (line.startsWith("|")) expect(line.match(/\|/g)).toHaveLength(6);
		}
	});
});
