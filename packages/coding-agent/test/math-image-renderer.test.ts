import { describe, expect, it, spyOn } from "bun:test";
import { SVG } from "@mathjax/src/mjs/output/svg.js";
import { renderMathImageSvg } from "../src/modes/mathjax-renderer";
import { smokeTestMathImageRenderer } from "../src/modes/math-worker-smoke";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import {
	Markdown,
	ImageBudget,
	withImageRenderContext,
	withMathImageOwner,
	releaseMathImageOwner,
	setMathImageRenderer,
	setMarkdownMathRendering,
} from "@oh-my-pi/pi-tui";
import { getCellDimensions, setCellDimensions, TERMINAL, ImageProtocol } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setKittyGraphics, getKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { registerCodingAgentMathImageRenderer } from "../src/modes/math-image-renderer";

const render = (tex: string, display = true) =>
	renderMathImageSvg({
		tex,
		display,
		inkHex: "#abcdef",
		cellWidthPx: 9,
		cellHeightPx: 18,
		pixelsPerEx: 9,
		maxWidthPx: 720,
	});

describe("scientific math image renderer", () => {
	it("produces one colored standalone representation for scientific package commands", () => {
		for (const tex of [
			"x+y=1",
			String.raw`\frac{1}{2}`,
			String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`,
			String.raw`\begin{cases}x&x>0\\0&x<0\end{cases}`,
			String.raw`\begin{numcases}{f(x)=}x&$x>0$\\0&$x<0$\end{numcases}`,
			String.raw`\begin{empheq}[left=\empheqlbrace]{align}x&=1\\y&=2\end{empheq}`,
			String.raw`\coloneqq\boldsymbol{\alpha}\Braket{x|y}\cancel{x}\color{red}{y}\mathcal{F}\mathbf{A}\Gamma`,
			String.raw`\newcommand{\squareme}[1]{#1^2}\squareme{x}`,
			String.raw`\def\squareme#1{#1^2}\squareme{x}`,
		]) {
			const result = render(tex, tex !== "x+y=1");
			expect(result.widthEx).toBeGreaterThan(0);
			expect(result.heightEx).toBeGreaterThan(0);
			expect(result.svg.match(/<svg\b/g)).toHaveLength(1);
			expect(result.svg).toContain('color="#abcdef"');
			expect(result.svg).toContain("<path");
			expect(result.svg).not.toContain("merror");
		}
	});
	it("keeps nested stretchy delimiter SVGs inside one standalone matrix representation", () => {
		for (const tex of [
			String.raw`\begin{pmatrix}a&b&c\\d&e&f\\g&h&i\end{pmatrix}`,
			String.raw`\left(\frac{\frac{a}{b}}{\frac{c}{d}}\right)`,
			String.raw`\begin{bmatrix}a&b&c\\d&e&f\\g&h&i\end{bmatrix}`,
		]) {
			const result = render(tex);
			expect(result.svg.startsWith("<svg ")).toBe(true);
			expect(result.svg.endsWith("</svg>")).toBe(true);
			if (tex.includes("pmatrix")) expect(result.svg.match(/<svg\b/g)!.length).toBeGreaterThan(1);
			expect(result.svg).toContain("<path");
			expect(result.svg).not.toContain("merror");
		}
	});
	it("rejects invalid, unsupported and bounded expansion input without poisoning later formulas", () => {
		for (const tex of [
			"",
			"x".repeat(20_001),
			String.raw`\unknowncommand{x}`,
			String.raw`\frac{1`,
			String.raw`\require{physics}`,
			String.raw`\def\loop{\loop}\loop`,
			String.raw`\newcommand{\grow}[1]{\grow{#1#1}}\grow{x}`,
			"\\text{🦄}",
		]) {
			expect(() => render(tex)).toThrow();
			expect(render("x+y=1", false).svg).toContain("<path");
		}
	});
	it("does not inherit macro definitions from previous formulas", () => {
		render(String.raw`\newcommand{\formulaonly}{x}\formulaonly`);
		expect(() => render(String.raw`\formulaonly`)).toThrow();
		render(String.raw`\def\formulaonly{x}\formulaonly`);
		expect(() => render(String.raw`\formulaonly`)).toThrow();
	});
	it("rejects nonfinite geometry and colors that could inject SVG resources", () => {
		expect(() =>
			renderMathImageSvg({
				tex: "x",
				display: false,
				inkHex: "url(https://example.com)",
				cellWidthPx: 9,
				cellHeightPx: 18,
				pixelsPerEx: 9,
				maxWidthPx: 720,
			}),
		).toThrow();
		expect(() =>
			renderMathImageSvg({
				tex: "x",
				display: false,
				inkHex: "#ffffff",
				cellWidthPx: 9,
				cellHeightPx: 18,
				pixelsPerEx: Number.NaN,
				maxWidthPx: 720,
			}),
		).toThrow();
	});
	it("rethrows typeset failures rather than returning an error SVG and recovers afterward", () => {
		const failure = new Error("typeset unavailable");
		const typeset = spyOn(SVG.prototype, "typeset").mockImplementation(() => {
			throw failure;
		});
		try {
			expect(() => render("x+y")).toThrow(failure);
		} finally {
			typeset.mockRestore();
		}
		expect(render("x+y").svg).toContain("<path");
	});
	it("rasterizes the production scientific profile into decoded PNGs with visible ink", async () => {
		await smokeTestMathImageRenderer();
	});
});

it("serializes nested cases comparisons as valid XML for native rasterization", async () => {
	const result = render(
		String.raw`\begin{aligned} f(x) &= \begin{cases}x^2,&x\ge0\\-x,&\text{if }x<0\end{cases}\\R(\theta)&=\begin{pmatrix}\cos\theta&-\sin\theta\\\sin\theta&\cos\theta\end{pmatrix}\end{aligned}`,
	);
	const svg = result.svg
		.replace(/width="[^"]+"/, `width="${result.widthEx * 9}"`)
		.replace(/height="[^"]+"/, `height="${result.heightEx * 9}"`);
	const png = await rasterizeSvg(new TextEncoder().encode(svg), 1700, 740, 1);
	expect((await new Bun.Image(png).metadata()).width).toBeGreaterThan(0);
});

it("renders list display, scripted and fraction inline math, and keeps stacked fractions Unicode", async () => {
	const protocol = TERMINAL.imageProtocol;
	const cell = getCellDimensions();
	const graphics = getKittyGraphics();
	initThemeSync();
	const markdown = new Markdown(
		String.raw`Before $e^{i\pi}+1=0$ and $\frac{\pi}{4}$ but $\frac{\frac{a}{b}}{\frac{c}{d}}$.

- When the limit is taken, left:

  $$\lim_{\lambda_c\to\infty} \frac{q+\lambda_c\pi}{Q+\lambda_c} = \pi_{c,h}$$`,
		0,
		0,
		{
			heading: text => text,
			link: text => text,
			linkUrl: text => text,
			code: text => text,
			codeBlock: text => text,
			codeBlockBorder: text => text,
			quote: text => text,
			quoteBorder: text => text,
			hr: text => text,
			listBullet: text => text,
			bold: text => text,
			italic: text => text,
			strikethrough: text => text,
			underline: text => text,
		},
	);
	let completion = Promise.withResolvers<void>();
	const budget = new ImageBudget(8);
	const paint = () => {
		budget.beginPass();
		try {
			return withImageRenderContext({ budget, requestRender: () => completion.resolve() }, () =>
				withMathImageOwner(
					markdown,
					() => completion.resolve(),
					() => markdown.render(140),
				),
			);
		} finally {
			budget.endPass();
		}
	};
	try {
		TERMINAL.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 20, heightPx: 40 });
		setMarkdownMathRendering(true);
		registerCodingAgentMathImageRenderer({ renderMath: true, showImages: true });
		paint();
		while (markdown.mathImagesPending) {
			await completion.promise;
			completion = Promise.withResolvers<void>();
			paint();
		}
		const rows = paint();
		expect(rows[0]).toContain("\u{10eeee}");
		expect(rows[0]).not.toContain("π/4");
		expect(rows[0]).toContain("a/b");
		expect(rows.slice(1).some(row => row.includes("\u{10eeee}"))).toBe(true);
	} finally {
		releaseMathImageOwner(markdown);
		setMathImageRenderer(undefined);
		setMarkdownMathRendering(false);
		TERMINAL.imageProtocol = protocol;
		setCellDimensions(cell);
		setKittyGraphics(graphics);
	}
});
