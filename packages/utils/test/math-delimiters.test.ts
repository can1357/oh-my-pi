import { describe, expect, test } from "bun:test";
import { Marked, type Token } from "../src/marked";
import {
	MathBlockScan,
	mathBlockAt,
	mathBlockCloserIndex,
	mathBlockMayCloseAt,
	mathOpenerAt,
	mathSpanAt,
	mathSpanInContext,
	mathStartIndex,
} from "../src/math-delimiters";

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

describe("MathBlockScan", () => {
	test("finds the blocks mathBlockAt finds at every offset, past unclosed openers", () => {
		// An unclosed `\[` says nothing about a later `$$`, and a `$$` line that
		// opens no block (text after it) says nothing about a later `$$` block.
		const source = "\\[\nno closer for this bracket\n\n$$ x $$ is inline\n\n$$\na = b\n$$\n\n\\[\nstill open\n";
		const scan = new MathBlockScan(source);
		const found: number[] = [];
		for (let from = 0; from < source.length; from++) {
			const block = scan.at(from);
			expect(block).toEqual(mathBlockAt(source.slice(from)));
			if (block !== undefined) found.push(from);
		}
		expect(found).toEqual([source.indexOf("$$\na")]);
	});
});

describe("mathBlockMayCloseAt", () => {
	test("reports a $$ opener that would close once its closer line arrives", () => {
		expect(mathBlockMayCloseAt("$$\nx^2\n")).toBe(true);
	});

	test("reports a \\[ opener that would close once its closer line arrives", () => {
		expect(mathBlockMayCloseAt("\\[\nx^2\n")).toBe(true);
	});

	test("declines a pseudo-pair whose body is whitespace-only", () => {
		// Same blank-body rejection as mathBlockAt: a real closer is already
		// present, but the body between opener and closer is whitespace-only.
		expect(mathBlockMayCloseAt("$$\n \n$$\n")).toBe(false);
	});

	test("reports a block already closed within `source`", () => {
		// Its closer line has ended, so no append can move it.
		expect(mathBlockMayCloseAt("$$\nx\n$$\n")).toBe(true);
	});

	test("treats a closer on the still-growing last line as unconfirmed", () => {
		// The trailing `$$` may yet become `$$ E = mc^2 $$`, which closes
		// nothing, so the block can still close further down.
		expect(mathBlockMayCloseAt("$$\n\n\n$$")).toBe(true);
	});

	test("treats an opener whose own line is still being written as open", () => {
		expect(mathBlockMayCloseAt("Intro.\n\n$$", 8)).toBe(true);
		// Text after the opener on its line makes it no opener line at all.
		expect(mathBlockMayCloseAt("Intro.\n\n$$ E", 8)).toBe(false);
	});
});

describe("mathBlockCloserIndex", () => {
	test("finds the first line holding only the closer of a given opener, the last line unterminated", () => {
		const source = "Intro with $$ inline $$ math.\n  $$  \nmore\n\\]";
		expect(mathBlockCloserIndex(source, 0, "$$")).toBe(source.indexOf("  $$"));
		expect(mathBlockCloserIndex(source, 0, "\\[")).toBe(source.indexOf("\\]"));
		// Past the `$$` line only the unterminated `\]` line is left.
		const more = source.indexOf("more");
		expect(mathBlockCloserIndex(source, more, "$$")).toBeUndefined();
		expect(mathBlockCloserIndex(source, more, "\\[")).toBe(source.indexOf("\\]"));
	});
});

describe("math spans for a marked inline tokenizer", () => {
	const mathMarked = () =>
		new Marked().use({
			extensions: [
				{
					name: "math",
					level: "inline",
					startFrom: mathStartIndex,
					tokenizer(rest) {
						const span = mathSpanInContext(this, rest);
						return span ? { type: "math", raw: rest.slice(0, span.end), text: span.body } : undefined;
					},
				},
			],
		});
	const shape = (tokens: readonly Token[]): unknown[] =>
		tokens.map(token =>
			"tokens" in token && token.tokens ? [token.type, token.raw, shape(token.tokens)] : [token.type, token.raw],
		);
	const lexMath = (source: string) => {
		const [paragraph] = mathMarked().lexer(source);
		return paragraph && "tokens" in paragraph && paragraph.tokens ? shape(paragraph.tokens) : paragraph;
	};

	// One context stands for one inline source. A closer scan there also answers for the openers it passed, so every
	// other offset must still find the span `mathSpanAt` finds in the rest of the source: past a `$` before a digit,
	// and past an escaped `$` that opens nothing, or only a body of whitespace.
	test("finds at every offset of one source the span mathSpanAt finds in the rest of it", () => {
		const sources = [
			"$1*$2*$3 x\n$y$ $4 and $z$",
			"$a $b$ c\\$d$ $\\$ e$",
			"\\(a \\(b \\[c \\[d $$e $$f",
			"\\(a\\) \\(b $$c$$ $$ $$ $$d \\\\(e\\)",
			"$a$1 b$ c",
			"$a\\$ x$ b",
			"$a\\$\u00a0$ b",
		];
		for (const source of sources) {
			const context = { source };
			for (let at = 0; at < source.length; at++) {
				const rest = source.slice(at);
				expect([at, mathSpanInContext(context, rest)]).toEqual([at, mathSpanAt(rest, 0)]);
			}
		}
	});

	// Inside emphasis or a link label the text ends before its closer: a closer past that end closes no span there.
	test("finds math inside emphasis and a link label only up to their end", () => {
		expect(lexMath("*a \\(b* c \\) [d $e](u) f$")).toEqual([
			[
				"em",
				"*a \\(b*",
				[
					["text", "a "],
					["escape", "\\("],
					["text", "b"],
				],
			],
			["text", " c "],
			["escape", "\\)"],
			["text", " "],
			["link", "[d $e](u)", [["text", "d $e"]]],
			["text", " f$"],
		]);
		expect(lexMath("*a $b$ \\(c\\)* [$d$](u)")).toEqual([
			[
				"em",
				"*a $b$ \\(c\\)*",
				[
					["text", "a "],
					["math", "$b$"],
					["text", " "],
					["math", "\\(c\\)"],
				],
			],
			["text", " "],
			["link", "[$d$](u)", [["math", "$d$"]]],
		]);
	});

	// Generous bound: each shape takes a tokenizer that rescans for a closer at every opener several seconds. The
	// engine runs the `\)` search (`indexOf`), so a long word follows those openers: each search runs to the end.
	test.each([
		["$ openers before digits (80 KB)", "$1*".repeat(26_667)],
		["\\( openers before a long word (1.8 MB)", `${"\\(a ".repeat(40_000)}${"a".repeat(1_600_000)}`],
	])("lexes a long paragraph of unclosed %s in under two seconds", (_name, src) => {
		const marked = mathMarked();
		// Compile the lexing paths first, so the bound measures the lexing.
		marked.lexer(src.slice(0, 2_000));
		const start = performance.now();
		marked.lexer(src);
		expect(performance.now() - start).toBeLessThan(2_000);
	});

	// Every nesting level opens a span that closes only past the last level, so a closer scan per level would read to
	// the end of the paragraph. A long word inside the levels makes each such scan long.
	test.each([
		["$", `${"*a b$1 ".repeat(4_000)}${"a".repeat(200_000)}${" b*".repeat(4_000)} x$`],
		["\\(", `${"*a \\(b ".repeat(8_000)}${"a".repeat(6_400_000)}${" b*".repeat(8_000)} \\)`],
	])("lexes nested emphasis whose every level opens a %s span closed past it in under two seconds", (_name, src) => {
		const marked = mathMarked();
		// Compile the lexing paths first, so the bound measures the lexing.
		marked.lexer(src.slice(0, 2_000));
		const start = performance.now();
		marked.lexer(src);
		expect(performance.now() - start).toBeLessThan(2_000);
	});
});
