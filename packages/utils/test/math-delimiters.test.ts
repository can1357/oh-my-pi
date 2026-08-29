import { describe, expect, test } from "bun:test";
import { mathBlockAt, mathOpenerAt, mathSpanAt, mathStartIndex } from "../src/math-delimiters";

describe("math span grammar", () => {
	test("reports opener, display mode, body and end offset for each delimiter form", () => {
		expect(mathSpanAt("$x^2$ tail", 0)).toEqual({ opener: "$", display: false, end: 5, body: "x^2" });
		expect(mathSpanAt("$$x^2$$ tail", 0)).toEqual({ opener: "$$", display: true, end: 7, body: "x^2" });
		expect(mathSpanAt("\\(x^2\\) tail", 0)).toEqual({ opener: "\\(", display: false, end: 7, body: "x^2" });
		expect(mathSpanAt("\\[x^2\\] tail", 0)).toEqual({ opener: "\\[", display: true, end: 7, body: "x^2" });
	});

	test("keeps the body verbatim, including newlines and surrounding spaces", () => {
		// Renderers depend on the untouched body: the TUI stacks `\\` rows verbatim.
		expect(mathSpanAt("$$\na & b \\\\ c & d\n$$", 0)?.body).toBe("\na & b \\\\ c & d\n");
		expect(mathSpanAt("\\( x \\)", 0)?.body).toBe(" x ");
	});

	test("applies the anti-currency rules to `$…$`", () => {
		expect(mathSpanAt("$20 and $30 total", 0)).toBeUndefined(); // closer followed by a digit
		expect(mathSpanAt("$x $", 0)).toBeUndefined(); // closer preceded by a space
		expect(mathSpanAt("$ x$", 0)).toBeUndefined(); // opener followed by a space
		expect(mathSpanAt("$x\ny$", 0)).toBeUndefined(); // spans a newline
		expect(mathSpanAt("$cost = \\$20$", 0)).toEqual({
			opener: "$",
			display: false,
			end: 13,
			body: "cost = \\$20",
		});
	});

	test("rejects an unclosed or empty span so callers can keep it literal", () => {
		expect(mathSpanAt("$unfinished", 0)).toBeUndefined();
		expect(mathSpanAt("\\(unfinished", 0)).toBeUndefined();
		expect(mathSpanAt("\\[unfinished", 0)).toBeUndefined();
		expect(mathSpanAt("$$ $$", 0)).toBeUndefined();
		// `\(…\)` and `\[…\]` are unambiguous, so an empty body is still math.
		expect(mathSpanAt("\\(\\)", 0)?.end).toBe(4);
	});

	test("rejects an opener the source escaped", () => {
		expect(mathSpanAt(String.raw`\$x$`, 1)).toBeUndefined();
		// `\\(` is an escaped backslash followed by a literal paren.
		expect(mathSpanAt(String.raw`\\(x\)`, 1)).toBeUndefined();
		// An even run of backslashes leaves the opener live.
		expect(mathSpanAt(String.raw`\\$x$`, 2)?.body).toBe("x");
		expect(mathSpanAt(String.raw`\\\(x\)`, 2)?.body).toBe("x");
		// A caller that has already consumed the escapes bounds the scan itself.
		expect(mathSpanAt(String.raw`\$x$`, 1, 1)?.body).toBe("x");
	});

	test("skips escaped closers by backslash parity", () => {
		// `\\` is a TeX row break, so that `)` is body text.
		expect(mathSpanAt(String.raw`\(a \\) b\)`, 0)).toEqual({
			opener: "\\(",
			display: false,
			end: 11,
			body: String.raw`a \\) b`,
		});
		expect(mathSpanAt(String.raw`\[a \\] b\]`, 0)?.body).toBe(String.raw`a \\] b`);
		// An escaped dollar cannot close display math.
		expect(mathSpanAt(String.raw`$$a \$$ b$$`, 0)?.body).toBe(String.raw`a \$$ b`);
		expect(mathSpanAt(String.raw`$$\$$`, 0)).toBeUndefined();
		// An even run of backslashes leaves the closer unescaped.
		expect(mathSpanAt(String.raw`\(a\\\)`, 0)?.body).toBe(String.raw`a\\`);
	});

	test("prefers `$$` over `$` and finds no opener elsewhere", () => {
		expect(mathOpenerAt("$$x$$", 0)).toBe("$$");
		expect(mathOpenerAt("$x$", 0)).toBe("$");
		expect(mathOpenerAt("\\[x\\]", 0)).toBe("\\[");
		expect(mathOpenerAt("x$", 0)).toBeUndefined();
		expect(mathOpenerAt("\\frac{1}{2}", 0)).toBeUndefined();
	});

	test("scans forward for candidate offsets without resolving escapes", () => {
		expect(mathStartIndex("no math here")).toBeUndefined();
		expect(mathStartIndex("prose \\(x\\) and $y$")).toBe(6);
		expect(mathStartIndex("prose \\(x\\) and $y$", 7)).toBe(16);
		// The hint is deliberately escape-blind; `mathSpanAt` decides.
		expect(mathStartIndex("cost \\$20")).toBe(6);
	});
});

describe("math block grammar", () => {
	test("captures an own-line display block with up to three leading spaces", () => {
		const source = "  $$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n  $$\nnext";
		expect(mathBlockAt(source)).toEqual({
			raw: "  $$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n  $$\n",
			body: "\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}",
		});
	});

	test("keeps blank lines inside the block instead of ending it", () => {
		expect(mathBlockAt("$$\na\n\nb\n$$\n")?.body).toBe("a\n\nb");
	});

	test("matches an own-line block delimited by CRLF line endings", () => {
		// Direct callers may pass Windows-authored text; marked normalizes first,
		// but the shared grammar must not trip on `\r\n` at the delimiter lines.
		expect(mathBlockAt("$$\r\nx\r\n$$\r\n")).toEqual({ raw: "$$\r\nx\r\n$$\r\n", body: "x" });
		expect(mathBlockAt("\\[\r\nx\r\n\\]\r\n")).toEqual({ raw: "\\[\r\nx\r\n\\]\r\n", body: "x" });
	});

	test("declines a block that is unclosed, empty, or not on its own line", () => {
		expect(mathBlockAt("$$\nunclosed\n")).toBeUndefined();
		expect(mathBlockAt("$$\n \n$$\n")).toBeUndefined();
		expect(mathBlockAt("$$ x^2 $$\n")).toBeUndefined();
		expect(mathBlockAt("    $$\nx\n    $$\n")).toBeUndefined(); // four spaces: indented code
	});
});
