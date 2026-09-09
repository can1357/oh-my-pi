import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { isBareMathEnvironment, latexToUnicode, renderMathInText } from "@oh-my-pi/pi-tui/latex-to-unicode";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

const originalTrueColor = TERMINAL.trueColor;

function setTrueColor(enabled: boolean): void {
	Object.assign(TERMINAL, { trueColor: enabled });
}

function fg(color: string, format: "ansi-16m" | "ansi-256" = "ansi-16m"): string {
	return Bun.color(color, format) ?? "";
}

afterEach(() => {
	setTrueColor(originalTrueColor);
});

describe("latexToUnicode ANSI colors", () => {
	it("renders textcolor with CSS, xcolor models, and xcolor mixes", () => {
		setTrueColor(true);

		expect(latexToUnicode(String.raw`\textcolor{red}{x}`)).toBe(`${fg("#ff0000")}x${FG_RESET}`);
		expect(latexToUnicode(String.raw`\textcolor[HTML]{C5FFD6}{x}`)).toBe(`${fg("#C5FFD6")}x${FG_RESET}`);
		expect(latexToUnicode(String.raw`\textcolor[RGB]{128,64,32}{x}`)).toBe(`${fg("rgb(128, 64, 32)")}x${FG_RESET}`);
		expect(latexToUnicode(String.raw`\textcolor{red!50!blue}{x}`)).toBe(`${fg("rgb(128, 0, 128)")}x${FG_RESET}`);
	});

	it("keeps color declarations scoped to their brace group", () => {
		setTrueColor(true);

		expect(latexToUnicode(String.raw`{\color{red}x}y`)).toBe(`${fg("#ff0000")}x${FG_RESET}y`);
		expect(latexToUnicode(String.raw`{\color{red}a {\color{blue}b} c} d`)).toBe(
			`${fg("#ff0000")}a ${fg("#0000ff")}b${fg("#ff0000")} c${FG_RESET} d`,
		);
	});

	it("renders colorbox and fcolorbox with foreground and background resets", () => {
		setTrueColor(true);
		const yellowBackground = (Bun.color("#ffff00", "ansi-16m") ?? "").replace("\x1b[38;", "\x1b[48;");

		expect(latexToUnicode(String.raw`\colorbox{yellow}{x}`)).toBe(`${yellowBackground}x${BG_RESET}`);
		expect(latexToUnicode(String.raw`\fcolorbox{red}{yellow}{x}`)).toBe(
			`${fg("#ff0000")}[${FG_RESET}${yellowBackground}x${BG_RESET}${fg("#ff0000")}]${FG_RESET}`,
		);
	});

	it("uses 256-color ANSI when truecolor is unavailable", () => {
		setTrueColor(false);

		expect(latexToUnicode(String.raw`\textcolor{#C5FFD6}{x}`)).toBe(`${fg("#C5FFD6", "ansi-256")}x${FG_RESET}`);
	});

	it("converts bare color command lines in prose", () => {
		setTrueColor(true);

		const rendered = renderMathInText(String.raw`\textcolor{red}{alert}`);
		expect(stripVTControlCharacters(rendered)).toBe("alert");
		expect(rendered).toContain(fg("#ff0000"));
	});

	it("renders text-mode styles with terminal attributes", () => {
		setTrueColor(true);
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
		setTrueColor(true);

		expect(latexToUnicode(String.raw`\boxed{\textcolor{red}{x}}`)).toBe(`[${fg("#ff0000")}x${FG_RESET}]`);
		expect(latexToUnicode(String.raw`\pmod{\textbf{x}}`)).toBe("(mod \x1b[1mx\x1b[22m)");
	});

	it("keeps fallback script glyphs at the script-site style", () => {
		expect(latexToUnicode(String.raw`x_{\textit{word}}`)).toBe("x_(\x1b[3mword\x1b[23m)");
		expect(latexToUnicode(String.raw`x^{\textbf{foo!}}`)).toBe("x^(\x1b[1mfoo!\x1b[22m)");
	});

	it("cancels an enclosing terminal style for nested text overrides", () => {
		const bold = latexToUnicode(String.raw`\textbf{A\textmd{B}C}`);
		const italic = latexToUnicode(String.raw`\textit{A\textup{B}C}`);

		expect(stripVTControlCharacters(bold)).toBe("ABC");
		expect(stripVTControlCharacters(italic)).toBe("ABC");
		expect(bold).toBe("\x1b[1mA\x1b[22mB\x1b[1mC\x1b[22m");
		expect(italic).toBe("\x1b[3mA\x1b[23mB\x1b[3mC\x1b[23m");
	});

	it("leaves terminal fallbacks as plain text", () => {
		expect(latexToUnicode(String.raw`\texttt{x}\textsf{y}`)).toBe("xy");
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

describe("latexToUnicode symbol fixes", () => {
	it("maps \\subseteqq/\\supseteqq to their AMS glyphs", () => {
		expect(latexToUnicode("\\subseteqq")).toBe("⫅");
		expect(latexToUnicode("\\supseteqq")).toBe("⫆");
	});

	it("collapses common fractions to vulgar glyphs", () => {
		expect(latexToUnicode("\\frac{1}{2}")).toBe("½");
	});
});

describe("renderMathInText bare-environment handling", () => {
	it("converts a bare math environment without $$ delimiters", () => {
		const out = renderMathInText("\\begin{align}\na &= b + c \\\\\nx &= y\n\\end{align}");
		expect(out).not.toContain("\\begin{align}");
		expect(out).toContain("=");
	});

	it("pulls a preceding plain `lhs =` line into the converted block", () => {
		const out = renderMathInText("f(x) =\n\\begin{cases}\n1 & x > 0 \\\\\n0 & x \\le 0\n\\end{cases}");
		expect(out).not.toContain("\\begin{cases}");
		expect(out).toContain("f(x) =");
		// The lhs line is folded into the single-line math block, not left as its own line.
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
	});
});
