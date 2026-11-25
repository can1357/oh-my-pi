import { expect, test } from "bun:test";
import { renderMarkdown } from "../../src/render";

test("renders headings and paragraphs", () => {
	expect(renderMarkdown("# Hi\n\nSome *text*\nhere.")).toBe("<h1>Hi</h1>\n<p>Some <em>text</em> here.</p>");
});

test("renders a list", () => {
	expect(renderMarkdown("- a\n- b")).toBe("<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
});
