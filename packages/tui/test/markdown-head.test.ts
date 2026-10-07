import { afterEach, describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown, renderMarkdownHead } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

describe("renderMarkdownHead", () => {
	afterEach(() => clearRenderCache());

	// One-row paragraphs at width 120, one blank line apart.
	const paragraphs = (count: number) =>
		Array.from({ length: count }, (_, i) => `Paragraph ${i} holds a single row of prose.`).join("\n\n");

	const elapsed = (render: () => void): number => {
		clearRenderCache();
		const start = Bun.nanoseconds();
		render();
		return Bun.nanoseconds() - start;
	};
	const bestOf3 = (render: () => void): number => Math.min(elapsed(render), elapsed(render), elapsed(render));

	it("renders only the leading rows of a long document", () => {
		const doc = `${paragraphs(5000)}\n`;
		const head = renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12);
		const full = new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120);

		expect(head.truncated).toBe(true);
		expect(head.lines.length).toBeGreaterThan(12);
		expect(head.lines.length).toBeLessThan(full.length);
		expect(head.lines).toEqual(full.slice(0, head.lines.length));
	});

	it("renders the head of a bracket-heavy document faster than the whole document", () => {
		// 30,000 `[` on one line inside a fence, past the first probe window, then
		// a `]:` on a line that opens no bracket: the reference-definition check
		// has to scan past the whole run before the head can be cut, so a scan
		// that restarts at every `[` costs quadratic time here.
		const doc = `${paragraphs(200)}\n\n\`\`\`\n${"[".repeat(30_000)}\n\`\`\`\n\nA note]: no bracket opens it.\n\n${paragraphs(2000)}\n`;
		const head = bestOf3(() => renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12));
		const full = elapsed(() => new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120));
		expect(head).toBeLessThan(full);
		// The head is a cut prefix, not the whole document rendered.
		expect(renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12).truncated).toBe(true);
	});

	it("cuts a document of display-math openers that never close about as fast as one with no openers", () => {
		// Each paragraph opens a `\[` block that no `\]` line closes, so no block
		// forms; deciding that per opener by scanning the rest of the text made
		// the head's cost grow with the whole document. A same-size document with
		// no openers pays the same whole-document passes, so the two heads cost
		// about the same unless the openers rescan.
		const repeats = Math.ceil((1024 * 1024) / 6);
		const openers = "\\[\nx\n\n".repeat(repeats);
		const control = "yy\nx\n\n".repeat(repeats);
		const cut = (text: string) => () => {
			expect(renderMarkdownHead(text, 80, defaultMarkdownTheme, 12).truncated).toBe(true);
		};
		expect(bestOf3(cut(openers))).toBeLessThan(5 * bestOf3(cut(control)));
	});

	it("cuts past a display-math block whose closer is far away faster than the whole document", () => {
		// Every window short of the `\]` 128 KB down stops at the `\[`. Windows
		// that doubled toward the closer re-lexed the block each time.
		const doc = `Intro.\n\n\\[\n${paragraphs(3000)}\n\\]\n\n${paragraphs(3000)}\n`;
		const head = bestOf3(() => renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12));
		const full = elapsed(() => new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120));
		expect(head).toBeLessThan(full);
		expect(renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12).truncated).toBe(true);
	});

	it("cuts the text the renderer lexes after repairing an orphan closing fence", () => {
		// At final render the bare fence after the list is dropped as an orphan
		// (prose before it, a heading and a table after it), so `- b` continues
		// the list. A cut chosen on the unrepaired text would end the list at
		// `- a19` and never show `- b`.
		const items = Array.from({ length: 20 }, (_, i) => `- a${i}`).join("\n");
		const doc = `${items}\n\n\`\`\`\n- b\n\n# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${paragraphs(200)}\n`;

		const head = renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12);
		expect(head.truncated).toBe(true);
		const full = new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120);
		expect(head.lines).toEqual(full.slice(0, head.lines.length));
	});

	it("marks a cut head truncated when only no-break spaces follow the cut", () => {
		// A fence holds no blank line, so the first cut past `Intro.` is right
		// after it. The no-break spaces past the cut are no blank line to marked:
		// a full render gives them a row of their own.
		const code = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join("\n");
		const doc = `Intro.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n\u00a0\u00a0\u00a0`;

		const head = renderMarkdownHead(doc, 80, defaultMarkdownTheme, 12);
		const full = new Markdown(doc, 0, 0, defaultMarkdownTheme).render(80);
		expect(full.length).toBeGreaterThan(head.lines.length);
		expect(head.truncated).toBe(true);
	});

	for (const [name, doc] of [
		["CRLF line endings", `${paragraphs(600)}\n`.replaceAll("\n", "\r\n")],
		["a document under 4 KB", `${paragraphs(80)}\n`],
	] as const) {
		it(`renders the whole document for ${name}`, () => {
			const head = renderMarkdownHead(doc, 120, defaultMarkdownTheme, 12);
			expect(head.truncated).toBe(false);
			expect(head.lines).toEqual(new Markdown(doc, 0, 0, defaultMarkdownTheme).render(120));
		});
	}
});
