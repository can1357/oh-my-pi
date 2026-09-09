import { describe, expect, it } from "bun:test";
import * as prompt from "@oh-my-pi/pi-utils/prompt";

const FULL = { renderPhase: "pre-render", replaceAsciiSymbols: true, normalizeRfc2119: true } as const;

describe("format: ascii symbol replacement", () => {
	it("replaces all seven symbols in one line", () => {
		expect(prompt.format("a -> b <- c <-> d != e <= f >= g ... h", FULL)).toBe("a → b ← c ↔ d ≠ e ≤ f ≥ g … h");
	});

	it("prioritizes <-> over -> and <- on overlapping input", () => {
		// `<=->` must resolve as `<=` + `->`, and `<->` must win over its halves.
		expect(prompt.format("<=-> <-> ->= <-- -->x", FULL)).toBe("≤→ ↔ →= ←- -→x");
	});

	it("consumes ellipsis runs greedily in threes", () => {
		expect(prompt.format("....... ..", FULL)).toBe("……. ..");
		expect(prompt.format("......", FULL)).toBe("……");
		expect(prompt.format("....", FULL)).toBe("….");
	});

	it("skips replacements inside html comments, including multi-line state", () => {
		expect(prompt.format("<!-- a -> b --> c -> d", FULL)).toBe("<!-- a -> b --> c → d");
		expect(prompt.format("<!--\nA -> B\n-->\nC -> D", FULL)).toBe("<!--\nA -> B\n-->\nC → D");
	});

	it("replaces symbols on a line containing --> but no opener", () => {
		expect(prompt.format("x --> y != z", FULL)).toBe("x -→ y ≠ z");
	});

	it("leaves code fences untouched", () => {
		const input = "```\na -> b\n```";
		expect(prompt.format(input, FULL)).toBe(input);
	});
});

describe("format: rfc 2119 normalization", () => {
	it("strips bold and aliases MUST NOT / SHOULD NOT outside inline code", () => {
		expect(prompt.format("You **MUST** act. You **MUST NOT** stall. SHOULD NOT applies.", FULL)).toBe(
			"You MUST act. You NEVER stall. AVOID applies.",
		);
	});

	it("preserves keywords inside inline code spans", () => {
		expect(prompt.format("alias `MUST NOT` means MUST NOT", FULL)).toBe("alias `MUST NOT` means NEVER");
	});

	it("leaves non-keyword bold alone", () => {
		expect(prompt.format("**bold** stays **bold**", FULL)).toBe("**bold** stays **bold**");
	});
});

describe("format: structure", () => {
	it("compacts table rows and separators, preserving indent and alignment", () => {
		expect(prompt.format("| a | b |\n|:--- | --:|\n| c | d |")).toBe("|a|b|\n|:---|---:|\n|c|d|");
		expect(prompt.format("  | a | b |")).toBe("  |a|b|");
	});

	it("collapses runs of 2+ blank lines and trims boundary blanks", () => {
		expect(prompt.format("\n\na\n\n\nb\n \n\t\nc\n\n")).toBe("a\nb\nc");
		expect(prompt.format("a\n\nb")).toBe("a\n\nb");
	});

	it("drops a single blank line before a closing xml tag", () => {
		expect(prompt.format("<tag>\nbody\n\n</tag>")).toBe("<tag>\nbody\n</tag>");
	});

	it("does not treat self-closing or attribute-laden non-tags as block tags", () => {
		// `<a b> c>` is not an opening tag (inner `>`); blank before `</a>` still pops.
		expect(prompt.format('<a attr="x">\nbody\n\n</a>')).toBe('<a attr="x">\nbody\n</a>');
		expect(prompt.format("<self/>\nx")).toBe("<self/>\nx");
	});

	it("keeps blank handling inside code fences verbatim", () => {
		const input = "```\na\n\n\n\nb\n```";
		expect(prompt.format(input)).toBe(input);
	});

	it("pops blanks before handlebars block closers only in pre-render", () => {
		expect(prompt.format("{{#if x}}\nbody\n\n{{/if}}", { renderPhase: "pre-render" })).toBe(
			"{{#if x}}\nbody\n{{/if}}",
		);
		expect(prompt.format("body\n\n{{/if}}", { renderPhase: "post-render" })).toBe("body\n\n{{/if}}");
	});
});

describe("compile cache", () => {
	it("returns the identical compiled function for repeat compiles of the same template", () => {
		const template = "Hello {{name}} {{#if x}}yes{{/if}}";
		expect(prompt.compile(template)).toBe(prompt.compile(template));
	});

	it("renders templates with 3+ closing braces unambiguously", () => {
		expect(prompt.render("{{#if a}}{ {{b}}}{{/if}}", { a: true, b: "v" })).toBe("{ v}");
	});
});

describe("helpers: join", () => {
	it("unescapes \\n and \\t in the separator (Handlebars string literals carry no escapes)", () => {
		// Regression: `{{join files "\n"}}` used to emit the literal two-char `\n`
		// between entries (visible in compaction <read-files> lists).
		expect(prompt.render('{{join files "\\n"}}', { files: ["a.ts", "b.ts"] })).toBe("a.ts\nb.ts");
		expect(prompt.render('{{join files "\\t"}}', { files: ["a.ts", "b.ts"] })).toBe("a.ts\tb.ts");
	});

	it("defaults to comma-space and tolerates non-arrays", () => {
		expect(prompt.render("{{join files}}", { files: ["a", "b"] })).toBe("a, b");
		expect(prompt.render("{{join files}}", { files: "not-an-array" })).toBe("");
	});
});
