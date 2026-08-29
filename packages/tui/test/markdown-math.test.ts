import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown, renderInlineMarkdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

/** Render markdown and return non-empty, ANSI-stripped, right-trimmed lines. */
function renderLines(md: string, width = 100): string[] {
	return new Markdown(md, 0, 0, defaultMarkdownTheme)
		.render(width)
		.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
		.filter(line => line !== "");
}

describe("Markdown math rendering", () => {
	it("converts inline $…$ math inside prose", () => {
		const [line] = renderLines("the area is $A = \\pi r^2$ exactly");
		expect(line).toBe("the area is A = π r² exactly");
	});

	it("converts subscripts/superscripts in inline math without markdown mangling", () => {
		// `x_i^2` survives because intraword `_` is not emphasis and `^` is plain.
		const [line] = renderLines("energy $x_i^2 + y_j^2$ done");
		expect(line).toBe("energy xᵢ² + yⱼ² done");
	});

	it("renders an own-line $$…$$ matrix block as a bracketed grid", () => {
		const lines = renderLines("$$\n\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}\n$$");
		// Two content rows around a centering gap row, in stretched brackets.
		expect(lines.length).toBe(3);
		expect(lines[0].startsWith("⎡")).toBe(true);
		expect(lines[lines.length - 1].endsWith("⎦")).toBe(true);
		expect(lines.join("").replace(/[\s⎡⎤⎢⎥⎣⎦]/g, "")).toBe("abcd");
	});

	it("stacks a \\[…\\] display quadratic formula with a drawn radical", () => {
		const lines = renderLines("\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]");
		const barRow = lines.findIndex(line => line.includes("x ="));
		expect(barRow).toBeGreaterThan(1);
		expect(lines[barRow]).toContain("───");
		expect(lines[barRow - 1]).toContain("-b ± ╲│ b² - 4ac");
		expect(lines[barRow - 2]).toContain("┌");
		expect(lines[barRow + 1]).toContain("2a");
	});

	it("stacks a single-line $$…$$ display fraction in a reply paragraph", () => {
		// Models commonly emit display math on one line; it must still stack.
		const lines = renderLines("Here:\n\n$$\\frac{a+b}{c}$$\n\nDone.");
		const barRow = lines.findIndex(line => line.includes("─"));
		expect(barRow).toBeGreaterThan(0);
		expect(lines[barRow - 1]).toContain("a+b");
		expect(lines[barRow + 1]).toContain("c");
	});

	it("keeps display math inside a list item multi-line", () => {
		const lines = renderLines("- result:\n\n  $$\n  \\begin{bmatrix} a \\\\ b \\end{bmatrix}\n  $$");
		// The matrix rows must land on distinct lines (not flattened to "[a b]").
		const openRow = lines.findIndex(line => line.includes("⎡ a"));
		const closeRow = lines.findIndex(line => line.includes("b ⎦"));
		expect(openRow).toBeGreaterThanOrEqual(0);
		expect(closeRow).toBeGreaterThan(openRow);
	});

	it("leaves math inside an inline code span literal", () => {
		const [line] = renderLines("use `$x^2$` literally and $y^2$ as math");
		expect(line).toBe("use $x^2$ literally and y² as math");
	});

	it("leaves math inside a fenced code block literal", () => {
		const lines = renderLines("```\n$a$ and $b$\n```");
		expect(lines.some(l => l.includes("$a$ and $b$"))).toBe(true);
	});

	it("does not convert currency-style dollars", () => {
		const [line] = renderLines("it costs $5 and $10 total");
		expect(line).toBe("it costs $5 and $10 total");
	});

	it("closes a span at the first unescaped delimiter", () => {
		// `\\` is a TeX row break, so that `)` is body text, not the closer.
		const [paren] = renderLines(String.raw`prose \(x \\) y\) end`);
		expect(paren).toBe("prose x  ) y end");
		// An escaped dollar cannot end display math either.
		const [dollar] = renderLines(String.raw`$$a \$$ b$$`);
		expect(dollar).toBe("a $ b");
	});

	it("renderInlineMarkdown converts inline math", () => {
		const out = stripVTControlCharacters(renderInlineMarkdown("energy $E=mc^2$ here", defaultMarkdownTheme));
		expect(out).toBe("energy E=mc² here");
	});

	it("renderInlineMarkdown handles a top-level display math token", () => {
		// A bare $$…$$ becomes a top-level `math` token; it must not leak raw LaTeX.
		const out = stripVTControlCharacters(renderInlineMarkdown("$$E = mc^2$$", defaultMarkdownTheme));
		expect(out).toBe("E = mc²");
	});

	it("stacks a display $$…$$ fraction across multiple lines", () => {
		const lines = renderLines("$$\n\\frac{a+b}{c}\n$$");
		// numerator / bar / denominator
		const barRow = lines.findIndex(line => line.includes("─"));
		expect(barRow).toBeGreaterThan(0);
		expect(lines[barRow - 1]).toContain("a+b");
		expect(lines[barRow + 1]).toContain("c");
	});

	it("stacks fractions inside a bare \\begin{equation} block (mathEnvBlockExtension)", () => {
		const lines = renderLines("\\begin{equation}\nx = \\frac{a+b}{c}\n\\end{equation}");
		const barRow = lines.findIndex(line => line.includes("─"));
		expect(barRow).toBeGreaterThanOrEqual(0);
		expect(lines[barRow]).toContain("x =");
		expect(lines[barRow - 1]).toContain("a+b");
		expect(lines[barRow + 1]).toContain("c");
	});
});
