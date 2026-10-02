import { describe, expect, test } from "bun:test";
import {
	Lexer,
	Marked,
	type Token,
	type TokenizerAndRendererExtension,
	type TokenizerExtension,
	type TokenizerThis,
} from "../src/marked";
import goldens from "./fixtures/marked/goldens.json";

describe("marked compatibility", () => {
	for (const golden of goldens) {
		test(`matches marked tokens and HTML for ${golden.name}`, () => {
			expect([...Lexer.lex(golden.source)]).toEqual(golden.tokens);
			expect(new Marked().parse(golden.source)).toBe(golden.html);
		});
	}

	// Token-shape parity with real marked (verified against marked v15) at the
	// list/blank-line boundary. The TUI streaming lexer freezes prefixes on
	// these shapes, so a list's raw must never absorb a trailing blank run —
	// mid-document OR at end of input — and looseness must not flip with the
	// follower. The tui incremental tests compare this lexer to itself and
	// cannot catch a shape drift.
	const listBoundaryShapes: Array<[string, Array<[string, string] | [string, string, boolean]>]> = [
		[
			"- item\n\n",
			[
				["list", "- item", false],
				["space", "\n\n"],
			],
		],
		[
			"1. a\n2. b\n\n",
			[
				["list", "1. a\n2. b", false],
				["space", "\n\n"],
			],
		],
		[
			"- a\n\n\n",
			[
				["list", "- a", false],
				["space", "\n\n\n"],
			],
		],
		[
			"- [x] done\n\n",
			[
				["list", "- [x] done", false],
				["space", "\n\n"],
			],
		],
		[
			"- item\n\nhello",
			[
				["list", "- item", false],
				["space", "\n\n"],
				["paragraph", "hello"],
			],
		],
		[
			"1. a\n2. b\n\n1) x",
			[
				["list", "1. a\n2. b", false],
				["space", "\n\n"],
				["list", "1) x", false],
			],
		],
		// Same-marker continuation across the blank still merges into one loose list.
		["1. a\n2. b\n\n1. c", [["list", "1. a\n2. b\n\n1. c", true]]],
		// A blank inside an item (indented continuation) stays in the item raw.
		[
			"- a\n\n  b\n\n",
			[
				["list", "- a\n\n  b", true],
				["space", "\n\n"],
			],
		],
	];
	for (const [source, shape] of listBoundaryShapes) {
		test(`keeps the list/blank boundary shape for ${JSON.stringify(source)}`, () => {
			const tokens = [...Lexer.lex(source)].map(token =>
				token.type === "list" ? [token.type, token.raw, token.loose] : [token.type, token.raw],
			);
			expect(tokens).toEqual(shape);
		});
	}

	// Lazy-continuation boundary shapes (behavior cross-checked against marked
	// v18): an indented code block cannot interrupt a paragraph, so an indented
	// line directly attached to paragraph text stays in the paragraph even when
	// a setext/hr lookahead matches downstream — while a whitespace-padded
	// blank line detaches it, so the next indented run still opens indented
	// code. Documented divergences from marked kept as-is: marked dedents the
	// attached line inside `text` via its code-merge path, and it splits a
	// padded blank into a `space` token where this lexer keeps the padded
	// blank inside the paragraph raw.
	const lazyBoundaryShapes: Array<[string, Array<[string, string]>]> = [
		[
			"lead\n   \n    code\n",
			[
				["paragraph", "lead\n   \n"],
				["code", "    code\n"],
			],
		],
		[
			"lead\n    attached\n---\n",
			[
				["paragraph", "lead\n    attached\n"],
				["hr", "---\n"],
			],
		],
		[
			"lead\n     deeper attached\n---\n",
			[
				["paragraph", "lead\n     deeper attached\n"],
				["hr", "---\n"],
			],
		],
		[
			"lead\n   \n     deeper code\n",
			[
				["paragraph", "lead\n   \n"],
				["code", "     deeper code\n"],
			],
		],
	];
	for (const [source, shape] of lazyBoundaryShapes) {
		test(`keeps the lazy-continuation boundary shape for ${JSON.stringify(source)}`, () => {
			expect([...Lexer.lex(source)].map(token => [token.type, token.raw])).toEqual(shape);
		});
	}

	test("runs block and inline tokenizer/renderer extensions", () => {
		const latexBlock: TokenizerAndRendererExtension = {
			name: "latexBlock",
			level: "block",
			start(src) {
				const index = src.indexOf("$$\n");
				return index === -1 ? undefined : index;
			},
			tokenizer(src) {
				const match = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/.exec(src);
				return match ? { type: "latexBlock", raw: match[0], text: match[1] } : undefined;
			},
			renderer(token) {
				return `<math>${token.text}</math>\n`;
			},
		};
		const inlineLatex: TokenizerAndRendererExtension = {
			name: "latex",
			level: "inline",
			start(src) {
				const index = src.indexOf("$");
				return index === -1 ? undefined : index;
			},
			tokenizer(src) {
				const match = /^\$([^\n$]+)\$/.exec(src);
				return match ? { type: "latex", raw: match[0], text: match[1] } : undefined;
			},
			renderer(token) {
				return `<i>${token.text}</i>`;
			},
		};
		const marked = new Marked().use({ extensions: [latexBlock, inlineLatex] });

		expect([...marked.lexer("before $x_i$\n\n$$\ny^2\n$$\n")]).toEqual([
			{
				type: "paragraph",
				raw: "before $x_i$",
				text: "before $x_i$",
				tokens: [
					{ type: "text", raw: "before ", text: "before ", escaped: false },
					{ type: "latex", raw: "$x_i$", text: "x_i" },
				],
			},
			{ type: "space", raw: "\n\n" },
			{ type: "latexBlock", raw: "$$\ny^2\n$$\n", text: "y^2" },
		]);
		expect(marked.parse("before $x_i$\n\n$$\ny^2\n$$\n")).toBe("<p>before <i>x_i</i></p>\n<math>y^2</math>\n");
	});

	const shape = (tokens: readonly Token[]): unknown[] =>
		tokens.map(token =>
			"tokens" in token && token.tokens ? [token.type, token.raw, shape(token.tokens)] : [token.type, token.raw],
		);

	// Plain text ends where the next token could start, and the lexer reuses
	// each such stop until it passes one. Here it walks through the rejected
	// `foo@bar` (no dotted domain) and must still stop at an address using every
	// local-part character class, at a two-space hard break, and at a URL.
	test("plain text stops at bare addresses, URLs and hard breaks after an address-like run that is not a link", () => {
		const source = "see foo@bar and Ab.c+d-e_9@qux.com or  \nhttp://x.y";
		expect([...Lexer.lex(source)]).toEqual([
			{
				type: "paragraph",
				raw: source,
				text: source,
				tokens: [
					{ type: "text", raw: "see foo@bar and ", text: "see foo@bar and ", escaped: false },
					{
						type: "link",
						raw: "Ab.c+d-e_9@qux.com",
						text: "Ab.c+d-e_9@qux.com",
						href: "mailto:Ab.c+d-e_9@qux.com",
						tokens: [{ type: "text", raw: "Ab.c+d-e_9@qux.com", text: "Ab.c+d-e_9@qux.com" }],
					},
					{ type: "text", raw: " or", text: " or", escaped: false },
					{ type: "br", raw: "  \n" },
					{
						type: "link",
						raw: "http://x.y",
						text: "http://x.y",
						href: "http://x.y",
						tokens: [{ type: "text", raw: "http://x.y", text: "http://x.y" }],
					},
				],
			},
		]);
	});

	test("an inline extension's startFrom hint tokenizes like its start hint", () => {
		const dollar = (src: string, from: number) => {
			const index = src.indexOf("$", from);
			return index === -1 ? undefined : index;
		};
		const latex = (hint: Pick<TokenizerExtension, "start" | "startFrom">) =>
			new Marked().use({
				extensions: [
					{
						name: "latex",
						level: "inline",
						...hint,
						tokenizer(src) {
							const match = /^\$(\S[^\n$]*)\$/.exec(src);
							return match ? { type: "latex", raw: match[0], text: match[1] } : undefined;
						},
					},
				],
			});
		// Two spans, then an opener right after a span that the tokenizer
		// rejects. There the lexer asks for a hint at its own position and must
		// drop it, so the span after it stays text.
		const source = "a $x$ b $y$$ 5, then $z$";
		const fromHint = [...latex({ startFrom: dollar }).lexer(source)];
		expect(fromHint).toEqual([...latex({ start: src => dollar(src, 0) }).lexer(source)]);
		expect(fromHint).toEqual([
			{
				type: "paragraph",
				raw: source,
				text: source,
				tokens: [
					{ type: "text", raw: "a ", text: "a ", escaped: false },
					{ type: "latex", raw: "$x$", text: "x" },
					{ type: "text", raw: " b ", text: " b ", escaped: false },
					{ type: "latex", raw: "$y$", text: "y" },
					{ type: "text", raw: "$ 5, then $z$", text: "$ 5, then $z$", escaped: false },
				],
			},
		]);
	});

	// Inside emphasis and a link label the lexer takes the hint's answer for the paragraph, and keeps a candidate only
	// if the hint finds it again in that text. "a*" and "a]" are candidates in the paragraph where the closer follows
	// the "a", and in neither text, which ends before its closer; "[x a* y]" holds one of its own.
	test("an inline extension's startFrom hint tokenizes like its start hint inside emphasis and link labels", () => {
		const beforeCloser = (src: string, from: number) => {
			const pattern = /a[*\]]/g;
			pattern.lastIndex = from;
			return pattern.exec(src)?.index;
		};
		const lexA = (hint: Pick<TokenizerExtension, "start" | "startFrom">, source: string) => {
			const marked = new Marked().use({
				extensions: [
					{
						name: "a",
						level: "inline",
						...hint,
						tokenizer: src => (src.startsWith("a") ? { type: "a", raw: "a" } : undefined),
					},
				],
			});
			const [paragraph] = marked.lexer(source);
			return paragraph && "tokens" in paragraph && paragraph.tokens ? shape(paragraph.tokens) : paragraph;
		};
		const source = "*b a* [c a](u) [x a* y](u) a* d";
		const fromHint = lexA({ startFrom: beforeCloser }, source);
		expect(fromHint).toEqual(lexA({ start: src => beforeCloser(src, 0) }, source));
		expect(fromHint).toEqual([
			["em", "*b a*", [["text", "b a"]]],
			["text", " "],
			["link", "[c a](u)", [["text", "c a"]]],
			["text", " "],
			[
				"link",
				"[x a* y](u)",
				[
					["text", "x "],
					["a", "a"],
					["text", "* y"],
				],
			],
			["text", " "],
			["a", "a"],
			["text", "* d"],
		]);
	});

	// A JavaScript hint can answer anything: only undefined or a number at or past the offset is an answer, and the
	// first text step (at offset 0 here) already checks it.
	test.each([
		["-1", (src: string, from: number) => src.indexOf("§", from)],
		["null", () => null as unknown as undefined],
		["false", () => false as unknown as undefined],
	])("an inline extension whose startFrom reports none as %s fails loudly", (answer, startFrom) => {
		const marked = new Marked().use({
			extensions: [{ name: "none", level: "inline", startFrom, tokenizer: () => undefined }],
		});
		expect(() => marked.lexer("no section sign here")).toThrow(new RegExp(`"none": startFrom returned ${answer}`));
	});

	test("an inline extension registered during a lex gets its own startFrom hint", () => {
		const at = (mark: string) => (src: string, from: number) => {
			const index = src.indexOf(mark, from);
			return index === -1 ? undefined : index;
		};
		const marked = new Marked();
		marked.use({
			extensions: [
				{
					name: "para",
					level: "inline",
					startFrom: at("¶"),
					tokenizer(src) {
						if (!src.startsWith("¶")) return undefined;
						// Registering shifts every extension already in the live registry, so
						// "pct" lands where "sect" and its cached hint (the later "§") were.
						marked.use({
							extensions: [
								{
									name: "pct",
									level: "inline",
									startFrom: at("%%"),
									tokenizer: rest => {
										const match = /^%%\w+%%/.exec(rest);
										return match ? { type: "pct", raw: match[0] } : undefined;
									},
								},
							],
						});
						return { type: "para", raw: "¶" };
					},
				},
				{
					name: "sect",
					level: "inline",
					startFrom: at("§"),
					tokenizer: src => (src.startsWith("§") ? { type: "sect", raw: "§" } : undefined),
				},
			],
		});
		const [paragraph] = marked.lexer("x ¶ %%p%% § y");
		expect(paragraph && "tokens" in paragraph && paragraph.tokens ? shape(paragraph.tokens) : paragraph).toEqual([
			["text", "x "],
			["para", "¶"],
			["text", " "],
			["pct", "%%p%%"],
			["text", " "],
			["sect", "§"],
			["text", " y"],
		]);
	});

	// A tokenizer that scans ahead keeps what it learned for the rest of its source in a WeakMap keyed by the context.
	// Emphasis and link labels share their paragraph's context, whose `end` is where the text being lexed ends.
	test("gives an inline tokenizer one context per inline source, shared with the emphasis and labels inside it", () => {
		const byContext = new Map<TokenizerThis, [string, number | undefined][]>();
		const marked = new Marked().use({
			extensions: [
				{
					name: "spy",
					level: "inline",
					tokenizer(src) {
						const end = this.end ?? -1;
						expect(this.source?.slice(end - src.length, end)).toBe(src);
						byContext.set(this, [...(byContext.get(this) ?? []), [src, this.end]]);
						return undefined;
					},
				},
			],
		});
		marked.lexer("a *b* [c](u)\n\nd");
		expect([...byContext].map(([context, calls]) => [context.source, calls])).toEqual([
			[
				"a *b* [c](u)",
				[
					["a *b* [c](u)", 12],
					["*b* [c](u)", 12],
					["b", 4],
					[" [c](u)", 12],
					["[c](u)", 12],
					["c", 8],
				],
			],
			["d", [["d", 1]]],
		]);
	});

	// Emphasis and link closers come from per-paragraph indexes of delimiters
	// and brackets; these shapes pin where each opener closes.
	test("closes emphasis past nested, unclosed, run-internal and escaped delimiters", () => {
		expect(shape(Lexer.lexInline("*a **b** c* and *d"))).toEqual([
			[
				"em",
				"*a **b** c*",
				[
					["text", "a "],
					["strong", "**b**", [["text", "b"]]],
					["text", " c"],
				],
			],
			["text", " and *d"],
		]);
		expect(shape(Lexer.lexInline("**x *y* z** ****w** \\**v**"))).toEqual([
			[
				"strong",
				"**x *y* z**",
				[
					["text", "x "],
					["em", "*y*", [["text", "y"]]],
					["text", " z"],
				],
			],
			["text", " "],
			["strong", "****", []],
			["text", "w** "],
			["escape", "\\*"],
			["text", "*v**"],
		]);
		// An escaped `\*` inside bold is not its closer.
		expect(shape(Lexer.lexInline("**a \\**b** c**"))).toEqual([
			[
				"strong",
				"**a \\**b**",
				[
					["text", "a "],
					["escape", "\\*"],
					["text", "*b"],
				],
			],
			["text", " c**"],
		]);
	});

	test("closes link labels and destinations past unclosed, escaped and nested brackets", () => {
		expect(shape(Lexer.lexInline("[x [a \\] b](u) [c](v (w)) ![i](j) [k"))).toEqual([
			["text", "[x "],
			[
				"link",
				"[a \\] b](u)",
				[
					["text", "a "],
					["escape", "\\]"],
					["text", " b"],
				],
			],
			["text", " "],
			["link", "[c](v (w))", [["text", "c"]]],
			["text", " "],
			["image", "![i](j)", [["text", "i"]]],
			["text", " [k"],
		]);
	});

	// A link label and the text of emphasis are lexed with the closers of the paragraph they lie in. A closer that
	// paragraph has only past the end of that text closes nothing inside it.
	test("closes nothing inside a link label or emphasis with a closer past its end", () => {
		expect(shape(Lexer.lexInline("*[a*](u) [*b](v)*"))).toEqual([
			["em", "*[a*", [["text", "[a"]]],
			["text", "](u) "],
			["link", "[*b](v)", [["text", "*b"]]],
			["text", "*"],
		]);
		expect(shape(Lexer.lexInline("***[a***](u) [**b](v)**"))).toEqual([
			["em", "***[a***", [["strong", "**[a**", [["text", "[a"]]]]],
			["text", "](u) "],
			["link", "[**b](v)", [["text", "**b"]]],
			["text", "**"],
		]);
		// Inside the italic text, the only `**` after the bold opener begins at its last `*` and ends past it.
		expect(shape(Lexer.lexInline("*a ***a**"))).toEqual([["em", "*a ***a**", [["text", "a ***a*"]]]]);
	});

	// A code span closes at the first run of as many backticks after its opener that no backslash escapes, and the
	// search goes on that many backticks past an escaped one. A URL autolink ends at the first " " or ">" after its
	// scheme, past any "<". Inside emphasis or a link label, a closer past its end closes nothing.
	test("closes code spans and autolinks past escaped runs and other openers, and not past a nested end", () => {
		expect(shape(Lexer.lexInline("``a\\```b`` c\\````d``"))).toEqual([
			["codespan", "``a\\```b``"],
			["text", " c"],
			["escape", "\\`"],
			["text", "`"],
			["codespan", "``d``"],
		]);
		expect(shape(Lexer.lexInline("`a\\``b` c"))).toEqual([
			["codespan", "`a\\``"],
			["text", "b` c"],
		]);
		expect(shape(Lexer.lexInline("*a `b* c`"))).toEqual([
			["em", "*a `b*", [["text", "a `b"]]],
			["text", " c`"],
		]);
		expect(shape(Lexer.lexInline("[a `b](u) c`"))).toEqual([
			["link", "[a `b](u)", [["text", "a `b"]]],
			["text", " c`"],
		]);
		expect(shape(Lexer.lexInline("*<http://a* b> <https://c<http://d> <x@y>"))).toEqual([
			[
				"em",
				"*<http://a*",
				[
					["text", "<"],
					["link", "http://a", [["text", "http://a"]]],
				],
			],
			["text", " b> "],
			["link", "<https://c<http://d>", [["text", "https://c<http://d"]]],
			["text", " "],
			["link", "<x@y>", [["text", "x@y"]]],
		]);
	});

	// The text of emphasis is lexed through `lexer.inlineTokens`, with its paragraph's closers and text stops. An
	// override that returns without lexing it must not leave them to a later lex of an equal string, which lexes that
	// string on its own.
	test("lexes a string on its own after an inlineTokens override skipped emphasis text equal to it", () => {
		const text = "a www.x.y b";
		class SkipOnce extends Lexer {
			skipped = false;
			override inlineTokens(src: string, tokens: Token[] = []): Token[] {
				if (src !== text || this.skipped) return super.inlineTokens(src, tokens);
				this.skipped = true;
				return tokens;
			}
		}
		const lexer = new SkipOnce();
		expect(shape(lexer.inlineTokens(`*${text}* then www.q.r`))).toEqual([
			["em", `*${text}*`, []],
			["text", " then "],
			["link", "www.q.r", [["text", "www.q.r"]]],
		]);
		expect(shape(lexer.inlineTokens(text))).toEqual(shape(Lexer.lexInline(text)));
		expect(shape(Lexer.lexInline(text))).toEqual([
			["text", "a "],
			["link", "www.x.y", [["text", "www.x.y"]]],
			["text", " b"],
		]);
	});

	// An image's text is its label unescaped: also when the label's only escape ends right before its "]", and for an
	// image in another image's label, whose text keeps the inner image's source.
	test("gives an image its label unescaped as its text", () => {
		type Walked = { type: string; raw: string; text?: string; tokens?: Walked[] };
		const images = (tokens: readonly Walked[], out: [string, string | undefined][] = []) => {
			for (const token of tokens) {
				if (token.type === "image") out.push([token.raw, token.text]);
				if (token.tokens) images(token.tokens, out);
			}
			return out;
		};
		const lexImages = (source: string) => images(Lexer.lex(source) as unknown as Walked[]);
		expect(lexImages("![a\\*](u) ![b](v) ![c \\[![d\\_](w)](x)")).toEqual([
			["![a\\*](u)", "a*"],
			["![b](v)", "b"],
			["![c \\[![d\\_](w)](x)", "c [![d_](w)"],
			["![d\\_](w)", "d_"],
		]);
		expect(lexImages("[r]: /r\n\n![e\\!][r] ![f\\\\][r]")).toEqual([
			["![e\\!][r]", "e!"],
			["![f\\\\][r]", "f\\"],
		]);
	});

	// Definition labels never hold "]", so only the reference part decides whether a link resolves: a label holding
	// brackets resolves through a plain reference, and a reference holding "]" resolves to nothing.
	test("resolves reference links whose label or reference holds brackets", () => {
		const [, , paragraph] = Lexer.lex("[a]: /u\n\n[[a]] [x [a]][a] [y][x [a]] [a][] [b]");
		expect(paragraph && "tokens" in paragraph && paragraph.tokens ? shape(paragraph.tokens) : paragraph).toEqual([
			["text", "["],
			["link", "[a]", [["text", "a"]]],
			["text", "] "],
			[
				"link",
				"[x [a]][a]",
				[
					["text", "x "],
					["link", "[a]", [["text", "a"]]],
				],
			],
			["text", " [y][x "],
			["link", "[a]", [["text", "a"]]],
			["text", "] "],
			["link", "[a][]", [["text", "a"]]],
			["text", " [b]"],
		]);
	});

	// Reference labels are user-controlled and index the ref-def map. An
	// `Object.prototype` member (`constructor`, `__proto__`, `toString`, …) must
	// not resolve to a fake definition: the link falls back to literal text and
	// never yields a `href: undefined` token that crashes downstream renderers
	// (issue #10283).
	for (const label of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
		test(`treats reference label ${label} as literal text, not an inherited definition`, () => {
			const tokens = [...Lexer.lex(`[text][${label}]`)];
			const links: unknown[] = [];
			const walk = (list: readonly { type: string; tokens?: unknown[] }[]) => {
				for (const token of list) {
					if (token.type === "link") links.push(token);
					if (Array.isArray(token.tokens)) {
						walk(token.tokens as { type: string; tokens?: unknown[] }[]);
					}
				}
			};
			walk(tokens as { type: string; tokens?: unknown[] }[]);
			expect(links).toEqual([]);
			// No anchor element is produced: the label is not a reference definition.
			expect(new Marked().parse(`[text][${label}]`)).not.toContain("<a ");
		});
	}

	test("keeps an inline extension's rewrite of the text token before it", () => {
		const marked = new Marked().use({
			extensions: [
				{
					name: "shout",
					level: "inline",
					tokenizer(_src, tokens) {
						const last = tokens.at(-1);
						if (last?.type === "text" && "text" in last && typeof last.text === "string") {
							last.raw = last.raw.toUpperCase();
							last.text = last.text.toUpperCase();
						}
						return undefined;
					},
				},
			],
		});
		const [paragraph] = marked.lexer("abc [ def [ ghi");
		expect(paragraph && "tokens" in paragraph && paragraph.tokens ? shape(paragraph.tokens) : paragraph).toEqual([
			["text", "ABC [ DEF [ ghi"],
		]);
	});

	test("closes bold inside a marker run the lexer entered through an extension's short raw", () => {
		const marked = new Marked().use({
			extensions: [
				{
					name: "eatX",
					level: "inline",
					// Consumes "x*" but reports raw "xy", so the lexer resumes one marker into the run.
					tokenizer: src => (src.startsWith("x*") ? { type: "eatX", raw: "xy" } : undefined),
				},
			],
		});
		const [paragraph] = marked.lexer("x*****a b** c");
		expect(paragraph && "tokens" in paragraph && paragraph.tokens ? shape(paragraph.tokens) : paragraph).toEqual([
			["eatX", "xy"],
			["strong", "****", []],
			["text", "a b** c"],
		]);
	});
});

describe("inline lexing stays linear on long paragraphs", () => {
	test("a startFrom hint is asked again only after lexing passes its answer", () => {
		const froms: number[] = [];
		const marked = new Marked().use({
			extensions: [
				{
					name: "latex",
					level: "inline",
					startFrom(src, from) {
						froms.push(from);
						const index = src.indexOf("$", from);
						return index === -1 ? undefined : index;
					},
					tokenizer: src => {
						const match = /^\$(\S[^\n$]*)\$/.exec(src);
						return match ? { type: "latex", raw: match[0], text: match[1] } : undefined;
					},
				},
			],
		});
		// Every `_` ends a text step; the hint at the `$` holds across all of them.
		marked.lexer("a_b_c $x$ d_e");
		expect(froms).toEqual([0, 9]);
	});

	// Generous bound: each shape takes quadratic lexing, or lexing that keeps an index per nesting level, several
	// seconds; linear lexing takes well under 300 ms. Where the engine runs the search (`indexOf`), a long word
	// follows the openers, so each opener's search runs to the end of the paragraph.
	test.each([
		["unclosed [ (80 KB)", "[x ".repeat(26_667)],
		["unclosed * (80 KB)", "*x ".repeat(26_667)],
		["unclosed _ (80 KB)", "_x ".repeat(26_667)],
		["address-like word without a dotted domain (80 KB)", `${"a".repeat(80_000)}@host`],
		["snake_case prose (800 KB)", "snake_case ".repeat(72_728)],
		["nested emphasis (32 KB)", `${"*a ".repeat(5_333)}${" b*".repeat(5_333)}`],
		["nested links (20 KB)", `${"[".repeat(4_000)}a${"](u)".repeat(4_000)}`],
		// Every nesting level holds the long word, so a search per level for a URL, an "@" or a hard break reads it
		// once per level.
		[
			"nested emphasis around a long word (3.2 MB)",
			`${"*a ".repeat(5_000)}${"a".repeat(3_200_000)}${" b*".repeat(5_000)}`,
		],
		[
			"nested links around a long word (3.2 MB)",
			`${"[a ".repeat(5_000)}${"a".repeat(3_200_000)}${"](u)".repeat(5_000)}`,
		],
		// An image's text is its label unescaped, which without an escape in the label is the label itself.
		[
			"nested images around a long word (6.4 MB)",
			`${"![".repeat(5_000)}${"a".repeat(6_400_000)}${"](u)".repeat(5_000)}`,
		],
		["nested brackets (80 KB)", `${"[".repeat(40_000)}a${"]".repeat(40_000)}`],
		["nested brackets under a definition (80 KB)", `[a]: /u\n\n${"[".repeat(40_000)}a${"]".repeat(40_000)}`],
		["URL with trailing punctuation (80 KB)", `http://x${".".repeat(80_000)}`],
		["unclosed HTML tags (80 KB)", "<a ".repeat(26_667)],
		["unclosed HTML comments before a long word (1.8 MB)", `</${"<!--".repeat(40_000)}${"a".repeat(1_600_000)}`],
		// At every backtick of an unclosed run the code span rule reads the rest of the run again.
		["an unclosed run of backticks (80 KB)", `x ${"`".repeat(80_000)}`],
		// No later run is as long as an opener, so each opener's closer search reads the rest of the paragraph.
		[
			"code spans opened by runs of decreasing length (320 KB)",
			(() => {
				let src = "x ";
				for (let width = 800; width > 0; width--) src += `${"`".repeat(width)}a `;
				return src;
			})(),
		],
		// Each URL autolink's search for its ">" runs past every "<" after it to the end of the paragraph.
		['URL autolinks without a space or ">" (120 KB)', "<http://a".repeat(13_334)],
	])("lexes a long paragraph of %s in under two seconds", (_name, src) => {
		// Compile the lexing paths first, so the bound measures the lexing.
		Lexer.lex(src.slice(0, 2_000));
		const start = performance.now();
		Lexer.lex(src);
		expect(performance.now() - start).toBeLessThan(2_000);
	});

	// The JIT inlines the hint below into the text step and can run its search of the rest ahead of the extension
	// loop, so a lexer with no extension would search at every text step.
	test("lexes without extensions in linear time once another lexer's start hint is compiled", () => {
		const hinted = new Marked().use({
			extensions: [
				{
					name: "latex",
					level: "inline",
					start(src) {
						const index = src.indexOf("$");
						return index === -1 ? undefined : index;
					},
					tokenizer: () => undefined,
				},
			],
		});
		for (let i = 0; i < 20_000; i++) hinted.lexer("a $x$ b_c d_e f_g");
		const src = `</${"<!--".repeat(80_000)}${"a".repeat(1_600_000)}`;
		const start = performance.now();
		Lexer.lex(src);
		expect(performance.now() - start).toBeLessThan(2_000);
	});
});
