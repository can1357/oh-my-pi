import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { isBareMathEnvironment, latexToUnicode, renderMathInText } from "@oh-my-pi/pi-tui/text/latex";

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

function fg(color: string, format: "ansi-16m" | "ansi-256" = "ansi-16m"): string {
	return Bun.color(color, format) ?? "";
}

describe("latexToUnicode ANSI colors", () => {
	it("renders textcolor with CSS, xcolor models, and xcolor mixes", () => {
		expect(latexToUnicode(String.raw`\textcolor{red}{x}`)).toBe(`${fg("#ff0000")}x${FG_RESET}`);
		expect(latexToUnicode(String.raw`\textcolor[HTML]{C5FFD6}{x}`)).toBe(`${fg("#C5FFD6")}x${FG_RESET}`);
		expect(latexToUnicode(String.raw`\textcolor[RGB]{128,64,32}{x}`)).toBe(`${fg("rgb(128, 64, 32)")}x${FG_RESET}`);
		expect(latexToUnicode(String.raw`\textcolor{red!50!blue}{x}`)).toBe(`${fg("rgb(128, 0, 128)")}x${FG_RESET}`);
	});

	it("keeps color declarations scoped to their brace group", () => {
		expect(latexToUnicode(String.raw`{\color{red}x}y`)).toBe(`${fg("#ff0000")}x${FG_RESET}y`);
		expect(latexToUnicode(String.raw`{\color{red}a {\color{blue}b} c} d`)).toBe(
			`${fg("#ff0000")}a ${fg("#0000ff")}b${fg("#ff0000")} c${FG_RESET} d`,
		);
	});

	it("renders colorbox and fcolorbox with foreground and background resets", () => {
		const yellowBackground = fg("#ffff00").replace("\x1b[38;", "\x1b[48;");
		expect(latexToUnicode(String.raw`\colorbox{yellow}{x}`)).toBe(`${yellowBackground}x${BG_RESET}`);
		expect(latexToUnicode(String.raw`\fcolorbox{red}{yellow}{x}`)).toBe(
			`${fg("#ff0000")}[${FG_RESET}${yellowBackground}x${BG_RESET}${fg("#ff0000")}]${FG_RESET}`,
		);
	});

	it("uses 256-color ANSI when truecolor is unavailable", () => {
		expect(latexToUnicode(String.raw`\textcolor{#C5FFD6}{x}`, { trueColor: false })).toBe(
			`${fg("#C5FFD6", "ansi-256")}x${FG_RESET}`,
		);
	});

	it("converts bare color command lines in prose", () => {
		const rendered = renderMathInText(String.raw`\textcolor{red}{alert}`);
		expect(stripVTControlCharacters(rendered)).toBe("alert");
		expect(rendered).toContain(fg("#ff0000"));
	});

	it("keeps synthetic wrappers in the caller style across nested styles", () => {
		expect(latexToUnicode(String.raw`\textbf{\frac{\textit{ab}}{c}}`)).toBe("\x1b[1m(\x1b[3mab\x1b[23m)/c\x1b[22m");
	});

	it("keeps fallback script markers in the caller style across nested colors", () => {
		expect(latexToUnicode(String.raw`\textit{x^{\textcolor{red}{q}}}`)).toBe(
			`\x1b[3mx^(${fg("#ff0000")}q${FG_RESET})\x1b[23m`,
		);
	});

	it("preserves the active color while parsing optional arguments", () => {
		expect(latexToUnicode(String.raw`\color{red}\xrightarrow[n]{x}`)).toBe(`${fg("#ff0000")}→ˣₙ${FG_RESET}`);
	});

	it("restores the active color after an environment body", () => {
		expect(latexToUnicode(String.raw`\begin{pmatrix}\color{red}a\end{pmatrix}b`)).toBe(
			`(${fg("#ff0000")}a${FG_RESET})b`,
		);
	});

	it("resets bold and italic inside textnormal", () => {
		expect(latexToUnicode(String.raw`\textbf{\textit{A\textnormal{B}C}}`)).toBe(
			"\x1b[1m\x1b[3mA\x1b[22m\x1b[23mB\x1b[1m\x1b[3mC\x1b[22m\x1b[23m",
		);
	});

	it("renders text-mode styles with terminal attributes", () => {
		const rendered = latexToUnicode(String.raw`\textcolor{red}{\textbf{strongest}}`);
		expect(stripVTControlCharacters(rendered)).toBe("strongest");
		expect(rendered).toContain(fg("#ff0000"));
		expect(rendered).toContain("\x1b[1m");
		expect(rendered).not.toMatch(/[\u{1d400}-\u{1d7ff}]/u);
	});

	it("maps all supported text styles to terminal attributes", () => {
		for (const [command, on, off] of [
			["textbf", "\x1b[1m", "\x1b[22m"],
			["textit", "\x1b[3m", "\x1b[23m"],
			["textsl", "\x1b[3m", "\x1b[23m"],
			["emph", "\x1b[3m", "\x1b[23m"],
		]) {
			expect(latexToUnicode(`\\${command}{x}`)).toBe(`${on}x${off}`);
		}
	});

	it("reopens nested terminal styles after nested resets", () => {
		const rendered = latexToUnicode(String.raw`\textbf{outer \textbf{inner} outer}`);
		expect(stripVTControlCharacters(rendered)).toBe("outer inner outer");
		expect(rendered).toContain("\x1b[22m\x1b[1m outer");
	});

	it("keeps terminal attributes out of glyph transforms", () => {
		expect(latexToUnicode(String.raw`\hat{\textbf{x}}`)).toBe("\x1b[1mx̂\x1b[22m");
		expect(latexToUnicode(String.raw`\frac{\textbf{a}}{b}`)).toBe("\x1b[1ma\x1b[22m/b");
		expect(latexToUnicode(String.raw`\sqrt{\textbf{x}}`)).toBe("√\x1b[1mx\x1b[22m");
	});

	it("keeps synthetic wrapper glyphs at the caller style", () => {
		expect(latexToUnicode(String.raw`\boxed{\textcolor{red}{x}}`)).toBe(`[${fg("#ff0000")}x${FG_RESET}]`);
		expect(latexToUnicode(String.raw`\pmod{\textbf{x}}`)).toBe("(mod \x1b[1mx\x1b[22m)");
	});

	it("keeps fallback script glyphs at the script-site style", () => {
		expect(latexToUnicode(String.raw`x_{\textit{word}}`)).toBe("x_(\x1b[3mword\x1b[23m)");
		expect(latexToUnicode(String.raw`x^{\textbf{foo!}}`)).toBe("x^(\x1b[1mfoo!\x1b[22m)");
	});

	it("cancels an enclosing terminal style for nested text overrides", () => {
		expect(latexToUnicode(String.raw`\textbf{A\textmd{B}C}`)).toBe("\x1b[1mA\x1b[22mB\x1b[1mC\x1b[22m");
		expect(latexToUnicode(String.raw`\textit{A\textup{B}C}`)).toBe("\x1b[3mA\x1b[23mB\x1b[3mC\x1b[23m");
	});

	it("leaves terminal fallbacks as plain text", () => {
		expect(latexToUnicode(String.raw`\texttt{x}\textsf{y}`)).toBe("xy");
	});
});

describe("latexToUnicode glyphs", () => {
	it("maps symbols, scripts and fractions", () => {
		expect(latexToUnicode("\\subseteqq")).toBe("⫅");
		expect(latexToUnicode("\\supseteqq")).toBe("⫆");
		expect(latexToUnicode("\\frac{1}{2}")).toBe("½");
		expect(latexToUnicode("E = mc^2")).toBe("E = mc²");
		expect(latexToUnicode("\\alpha + \\beta \\leq \\gamma")).toBe("α + β ≤ γ");
		expect(latexToUnicode("\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}")).toBe("∑ᵢ₌₁ⁿ i = (n(n+1))/2");
		expect(latexToUnicode("\\mathbb{R}^n \\to \\mathbb{R}")).toBe("ℝⁿ → ℝ");
		expect(latexToUnicode("x' + f''(x)")).toBe("x′ + f″(x)");
		expect(latexToUnicode("e^{i\\pi}")).toBe("e^(iπ)");
		expect(latexToUnicode("\\not\\in \\sqrt[3]{x}")).toBe("∉ ∛x");
	});
});

describe("isBareMathEnvironment", () => {
	it("accepts display-math environments (incl. starred variants)", () => {
		for (const env of ["cases", "align", "align*", "pmatrix", "array", "gather", "equation*", "aligned"]) {
			expect(isBareMathEnvironment(env)).toBe(true);
		}
	});

	it("rejects text-mode table/list/float environments", () => {
		for (const env of ["tabular", "tabular*", "itemize", "enumerate", "verbatim", "document", "figure"]) {
			expect(isBareMathEnvironment(env)).toBe(false);
		}
	});
});

describe("renderMathInText", () => {
	it("converts inline and display delimiters", () => {
		expect(renderMathInText("Inline math $E = mc^2$ and $\\alpha + \\beta \\leq \\gamma$ in prose.")).toBe(
			"Inline math E = mc² and α + β ≤ γ in prose.",
		);
		expect(renderMathInText("Also \\(a^2 + b^2 = c^2\\) and $$x_1$$ and \\[y^2\\].")).toBe(
			"Also a² + b² = c² and x₁ and y².",
		);
	});

	it("converts a bare math environment without $$ delimiters", () => {
		const out = renderMathInText("\\begin{align}\na &= b + c \\\\\nx &= y\n\\end{align}");
		expect(out).not.toContain("\\begin{align}");
		expect(out).toContain("=");
	});

	it("pulls a preceding plain `lhs =` line into the converted block", () => {
		const out = renderMathInText("f(x) =\n\\begin{cases}\n1 & x > 0 \\\\\n0 & x \\le 0\n\\end{cases}");
		expect(out).not.toContain("\\begin{cases}");
		expect(out).toContain("f(x) =");
		expect(out).not.toContain("f(x) =\n");
	});

	it("leaves a non-math environment verbatim, shielding its body", () => {
		const verbatim = "\\begin{verbatim}\n\\frac{a}{b}\n\\end{verbatim}";
		expect(renderMathInText(verbatim)).toBe(verbatim);
	});

	it("leaves a bare itemize list verbatim", () => {
		const list = "Here:\n\\begin{itemize}\n\\item first\n\\item second\n\\end{itemize}\nDone.";
		expect(renderMathInText(list)).toBe(list);
	});

	it("does not treat a prose dollar amount as math", () => {
		expect(renderMathInText("I paid \\$5 for it.")).toBe("I paid $5 for it.");
		expect(renderMathInText("Costs $5 and $10 today")).toBe("Costs $5 and $10 today");
	});
});
