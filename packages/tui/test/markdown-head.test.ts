import { afterEach, describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown, renderMarkdownHead } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

describe("renderMarkdownHead", () => {
	afterEach(() => clearRenderCache());

	// One-row paragraphs at width 120, one blank line apart.
	const paragraphs = (count: number) =>
		Array.from({ length: count }, (_, i) => `Paragraph ${i} holds a single row of prose.`).join("\n\n");

	it("renders only the leading rows of a long document", () => {
		const doc = `${paragraphs(5000)}\n`;
		const head = renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12);
		const full = new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120);

		expect(head.lines.length).toBeGreaterThan(12);
		expect(head.lines.length).toBeLessThan(full.length);
		expect(head.lines).toEqual(full.slice(0, head.lines.length));
		// Every source line renders as one row here, so the rendered rows and the
		// source lines after them make up the whole render.
		expect(head.lines.length + head.linesAfter).toBe(full.length);
	});

	it("cuts the text the renderer lexes after repairing an orphan closing fence", () => {
		// At final render the bare fence after the list is dropped as an orphan
		// (prose before it, a heading and a table after it), so `- b` continues
		// the list. A cut chosen on the unrepaired text would end the list at
		// `- a19` and never show `- b`.
		const items = Array.from({ length: 20 }, (_, i) => `- a${i}`).join("\n");
		const doc = `${items}\n\n\`\`\`\n- b\n\n# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${paragraphs(200)}\n`;

		const head = renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12);
		expect(head.linesAfter).toBeGreaterThan(0);
		const full = new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120);
		expect(head.lines).toEqual(full.slice(0, head.lines.length));
	});

	for (const [name, doc] of [
		["CRLF line endings", `${paragraphs(600)}\n`.replaceAll("\n", "\r\n")],
		["a document under 4 KB", `${paragraphs(80)}\n`],
	] as const) {
		it(`renders the whole document for ${name}`, () => {
			const head = renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12);
			expect(head.linesAfter).toBe(0);
			expect(head.lines).toEqual(new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120));
		});
	}
});
