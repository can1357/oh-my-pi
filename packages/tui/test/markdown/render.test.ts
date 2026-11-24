import { describe, expect, it } from "bun:test";
import { cellGrid, firstCellDiff, plainRows } from "../../src/testing/cells";
import { EXTENSION_LINK_ID, type MarkdownOptions, renderMarkdown, takeExtensionLinks } from "../../src/text/markdown";
import { visibleWidth } from "../../src/text/width";
import { loadThemeSync } from "../../src/theme";

const theme = loadThemeSync("dark");

function plain(source: string, width: number, options: Partial<MarkdownOptions> = {}): string[] {
	return plainRows(renderMarkdown(source, width, { theme, ...options }));
}

/** Hyperlink targets per visible cell of each row (null where unlinked). */
function linkTargets(rows: readonly string[]): (string | null)[][] {
	return cellGrid(rows).map(row => row.map(cell => cell.link || null));
}

describe("blocks", () => {
	it("draws nothing for empty and blank sources", () => {
		expect(renderMarkdown("", 40, { theme })).toEqual([]);
		expect(renderMarkdown("  \n\n \n", 40, { theme })).toEqual([]);
	});

	it("separates blocks by exactly one blank row and pads every row to the width", () => {
		const rows = renderMarkdown("# Title\n\n\n\nBody\n\n---\n\n```\ncode\n```", 30, {
			theme,
			paddingX: 2,
			paddingY: 1,
		});
		expect(plainRows(rows)).toEqual([
			"",
			"  Title",
			"",
			"  Body",
			"",
			`  ${"─".repeat(26)}`,
			"",
			"  ```",
			"    code",
			"  ```",
			"",
		]);
		expect(rows.every(row => visibleWidth(row) === 30)).toBe(true);
	});

	it("keeps setext headings and draws rules in the character they were written with", () => {
		expect(plain("Title\n===", 20)).toEqual(["Title"]);
		expect(plain("Title\n---", 20)).toEqual(["Title"]);
		expect(plain("a\n\n─────────────", 12)).toEqual(["a", "", "─".repeat(12)]);
		expect(plain("a\n\n======", 12)).toEqual(["a", "", "=".repeat(12)]);
		expect(plain("a\n\n———", 12)).toEqual(["a", "", "—".repeat(12)]);
	});

	it("caps rules at 80 cells", () => {
		expect(plain("---", 120)).toEqual(["─".repeat(80)]);
	});

	it("keeps the source's line breaks inside paragraphs and drops spaces at hard breaks", () => {
		expect(plain("one\ntwo", 40)).toEqual(["one", "two"]);
		expect(plain("p  \n   b", 40)).toEqual(["p", "b"]);
		expect(plain("p  \n`c` b", 40)).toEqual(["p", "c b"]);
		expect(plain("p  \n**s** b", 40)).toEqual(["p", "s b"]);
	});

	it("breaks words longer than the width", () => {
		expect(plain(`see ${"x".repeat(25)} end`, 10)).toEqual(["see", "xxxxxxxxxx", "xxxxxxxxxx", "xxxxx end"]);
	});

	it("expands tabs to three spaces", () => {
		expect(plain("a\tb", 20)).toEqual(["a   b"]);
	});
});

describe("lists", () => {
	it("hangs wrapped rows under the item text", () => {
		expect(plain("- Alpha beta gamma delta epsilon", 16)).toEqual(["- Alpha beta", "  gamma delta", "  epsilon"]);
		expect(plain("10. Alpha beta gamma delta", 16)).toEqual(["10. Alpha beta", "    gamma delta"]);
	});

	it("keeps task checkboxes in the marker and hangs rows under the task text", () => {
		expect(plain("- [x] Ship the fix today\n- [ ] Add a regression test", 20)).toEqual([
			"- [x] Ship the fix",
			"      today",
			"- [ ] Add a",
			"      regression",
			"      test",
		]);
	});

	it("indents nested lists by two cells and numbers ordered lists from their start", () => {
		expect(plain("1. one\n2. two\n   - sub\n     1. deep\n3. three", 40)).toEqual([
			"1. one",
			"2. two",
			"  - sub",
			"    1. deep",
			"3. three",
		]);
		expect(plain("7. seven\n8. eight", 40)).toEqual(["7. seven", "8. eight"]);
	});

	it("keeps numbering across lists split by unindented code blocks", () => {
		const rows = plain("1. First\n\n```ts\n// a\n```\n\n2. Second\n\n```ts\n// b\n```\n\n3. Third", 80);
		expect(rows.filter(row => /^\d+\./.test(row))).toEqual(["1. First", "2. Second", "3. Third"]);
	});

	it("follows a paragraph directly when the list interrupts it without a blank line", () => {
		expect(plain("Plan:\n- **one**\n- `two`\n\nNext", 40)).toEqual(["Plan:", "- one", "- two", "", "Next"]);
		expect(plain("Plan:\n\n- one", 40)).toEqual(["Plan:", "", "- one"]);
	});

	it("stacks a loose item's blocks without blank rows", () => {
		expect(plain("* one\n\n* two\n\n  more", 40)).toEqual(["- one", "- two", "  more"]);
	});

	it("keeps rows within the width when the marker fills the row", () => {
		const rows = plain("123456789. x", 8);
		expect(rows.every(row => visibleWidth(row) <= 8)).toBe(true);
		expect(rows.join("")).toContain("x");
	});

	it("draws a table inside an item under its continuation indent", () => {
		const rows = plain("10. **Keep:**\n\n    | Part | Why |\n    |---|---|\n    | pi | MIT |\n11. Next item", 30);
		expect(rows[0]).toBe("10. Keep:");
		expect(rows[1]).toBe("    ┌──────┬─────┐");
		expect(rows.some(row => row.includes("pi") && row.includes("MIT"))).toBe(true);
		expect(rows.at(-1)).toBe("11. Next item");
	});

	it("shows a list-item table too narrow for its columns as its source", () => {
		const rows = plain("10. Keep:\n\n    | Part | Why |\n    |---|---|\n    | pi | MIT |", 10);
		expect(rows[0]).toBe("10. Keep:");
		expect(rows.slice(1).join("\n")).toContain("MIT");
		expect(rows.every(row => visibleWidth(row) <= 10)).toBe(true);
	});
});

describe("quotes", () => {
	it("borders every wrapped row and separates quoted blocks", () => {
		expect(plain("> one two three four\n>\n> - item", 14)).toEqual(["▏ one two", "▏ three four", "▏", "▏ - item"]);
	});

	it("draws quoted text in the quote style and inline styles inside it", () => {
		const [row] = cellGrid(renderMarkdown("> a **b** c", 20, { theme }));
		const a = row![2]!;
		const b = row![4]!;
		const c = row![6]!;
		expect(a.italic && c.italic).toBe(true);
		expect(a.fg).toBe(c.fg);
		expect(b.bold).toBe(true);
		expect(b.fg).not.toBe(a.fg);
	});
});

describe("tables", () => {
	const table =
		"| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |\n| longer cell text | **bold** | `code` |";

	it("draws natural column widths with alignment and row dividers when the table fits", () => {
		expect(plain(table, 80)).toEqual([
			"┌──────────────────┬────────┬───────┐",
			"│ Left             │ Center │ Right │",
			"├──────────────────┼────────┼───────┤",
			"│ a                │   b    │     c │",
			"├──────────────────┼────────┼───────┤",
			"│ longer cell text │  bold  │  code │",
			"└──────────────────┴────────┴───────┘",
		]);
	});

	it("shrinks columns toward their longest word and wraps cells when the table does not fit", () => {
		const rows = plain(table, 30);
		expect(rows.every(row => visibleWidth(row) <= 30)).toBe(true);
		expect(rows).toContain("│ longer    │  bold  │  code │");
		expect(rows).toContain("│ cell text │        │       │");
	});

	it("falls back to the source when a column cannot get one cell", () => {
		expect(plain("| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |", 9)[0]).toBe("| a | b |");
	});

	it("draws header cells bold and closes cell styles before the border", () => {
		const rows = renderMarkdown("| h |\n|---|\n| `x` |", 20, { theme, colorful: false });
		const grid = cellGrid(rows);
		expect(grid[1]![2]!.bold).toBe(true);
		expect(grid[3]![2]!.fg).not.toBe("");
		expect(grid[3]![4]!.fg).toBe("");
	});
});

describe("code fences", () => {
	it("draws fence lines and indents the body", () => {
		expect(plain("```ts\nconst a = 1;\n```", 40)).toEqual(["```ts", "  const a = 1;", "```"]);
	});

	it("highlights known languages and leaves unknown ones plain", () => {
		const known = cellGrid(renderMarkdown("```ts\nconst a = 1;\n```", 40, { theme }));
		const unknown = cellGrid(renderMarkdown("```madeup\nconst a = 1;\n```", 40, { theme }));
		expect(known[1]![2]!.fg).not.toBe("");
		expect(unknown[1]![2]!.fg).toBe("");
	});

	it("draws an unclosed fence as closed", () => {
		expect(plain("```ts\nlet x", 40)).toEqual(["```ts", "  let x", "```"]);
	});

	it("puts literal code rows at column zero through padding and containers", () => {
		expect(plain("```sh\ncat <<'EOF'\nEOF\n```", 80, { paddingX: 1, codeIndent: 0 })).toEqual([
			" ```sh",
			"cat <<'EOF'",
			"EOF",
			" ```",
		]);
		const long = "x".repeat(24);
		for (const source of [
			`- shell:\n\n  \`\`\`sh\n  ${long}\n  EOF\n  \`\`\``,
			`> \`\`\`sh\n> ${long}\n> EOF\n> \`\`\``,
		]) {
			const rows = plain(source, 12, { paddingX: 1, codeIndent: 0 });
			const literal = rows.filter(row => row.includes("x") || row === "EOF");
			expect(literal.join("")).toBe(`${long}EOF`);
			expect(literal.length).toBeGreaterThan(2);
		}
	});

	it("links every wrapped fragment of a URL in code only when hyperlinks are on", () => {
		const url =
			"https://example.com/very/long/path/segment-one/segment-two/segment-three/segment-four?query=value&another=value";
		const source = `\`\`\`\n${url}\n\`\`\``;
		const linked = renderMarkdown(source, 40, { theme, hyperlinks: true });
		const targets = linkTargets(linked);
		const fragments = plainRows(linked).filter((_, i) => targets[i]!.includes(url));
		expect(fragments.length).toBeGreaterThan(2);
		expect(fragments.map(row => row.trim()).join("")).toBe(url);
		const off = renderMarkdown(source, 40, { theme });
		expect(off.join("")).not.toContain("\x1b]8;");
		expect(plainRows(off)).toEqual(plainRows(linked));
	});

	it("leaves unbalanced closing brackets and trailing punctuation out of code links", () => {
		for (const [code, target] of [
			["urls = [https://a.com/x]", "https://a.com/x"],
			["{https://a.com/x}", "https://a.com/x"],
			["(https://a.com/x),", "https://a.com/x"],
			["https://a.com/w[1]", "https://a.com/w[1]"],
		] as const) {
			const targets = linkTargets(renderMarkdown(`\`\`\`\n${code}\n\`\`\``, 80, { theme, hyperlinks: true }))
				.flat()
				.filter(t => t !== null);
			expect(new Set(targets)).toEqual(new Set([target]));
		}
	});

	it("falls back to the fence when a mermaid diagram does not render", () => {
		expect(plain("```mermaid\nnot a diagram {{{\n```", 40)).toEqual(["```mermaid", "  not a diagram {{{", "```"]);
	});
});

describe("inline", () => {
	it("shows a link's URL after its text unless the text is the URL", () => {
		expect(plain("[docs](https://e.com/d) and https://e.com/bare and <a@b.co>", 80)).toEqual([
			"docs (https://e.com/d) and https://e.com/bare and a@b.co",
		]);
	});

	it("links text and URL with OSC 8 when hyperlinks are on, mail addresses through mailto", () => {
		const rows = renderMarkdown("[docs](https://e.com/d) <a@b.co>", 80, { theme, hyperlinks: true });
		const cells = cellGrid(rows)[0]!;
		const text = plainRows(rows)[0]!;
		expect(cells[text.indexOf("docs")]!.link).toBe("https://e.com/d");
		expect(cells[text.indexOf("(https")]!.link).toBe("https://e.com/d");
		expect(cells[text.indexOf("a@b")]!.link).toBe("mailto:a@b.co");
		expect(cells[text.indexOf(" (")]!.link).toBe("");
	});

	it("links through a resolved target while showing the written href", () => {
		const rows = renderMarkdown("see [x](./a.ts)", 40, {
			theme,
			hyperlinks: true,
			linkTarget: href => (href === "./a.ts" ? "file:///abs/a.ts" : undefined),
		});
		expect(plainRows(rows)).toEqual(["see x (./a.ts)"]);
		expect(cellGrid(rows)[0]![4]!.link).toBe("file:///abs/a.ts");
	});

	it("balances the OSC 8 target around every wrapped fragment of a long URL", () => {
		const url = "https://example.com/really/long/path/that/will/wrap/on/narrow/width";
		const rows = renderMarkdown(`Visit ${url} for more`, 32, { theme, hyperlinks: true });
		const linked = rows.filter(row => row.includes(`\x1b]8;;${url}\x07`));
		expect(linked.length).toBeGreaterThan(1);
		for (const row of linked) expect(row.match(/\x1b\]8;;\x07/g)).toHaveLength(1);
	});

	it("autolinks only at a word boundary", () => {
		expect(plain("path ~/meta/www.share/blog and x/https://a.com", 80)).toEqual([
			"path ~/meta/www.share/blog and x/https://a.com",
		]);
		const rows = renderMarkdown("path ~/meta/www.share/blog", 80, { theme, hyperlinks: true });
		expect(rows.join("")).not.toContain("\x1b]8;;http");
	});

	it("renders reference links and leaves prototype-key labels as text", () => {
		expect(plain("[a][r] and [b][constructor]\n\n[r]: https://e.com/r", 80)[0]).toBe(
			"a (https://e.com/r) and [b][constructor]",
		);
	});

	it("strikes through only GFM's strict `~~` spans", () => {
		expect(plain("~~gone~~ ~not~ ~~ spaced~~", 40)).toEqual(["gone ~not~ ~~ spaced~~"]);
		expect(cellGrid(renderMarkdown("~~gone~~", 40, { theme }))[0]![0]!.strike).toBe(true);
	});

	it("paints color swatches for hex colors in prose and code, not for issue numbers or words", () => {
		const rows = plain("`#ff8800` #3366cc #abc #123 #each #a1b2c3d4", 80);
		expect(rows).toEqual(["■ #ff8800 ■ #3366cc ■ #abc #123 #each #a1b2c3d4"]);
		const cells = cellGrid(renderMarkdown("#3366cc", 20, { theme }))[0]!;
		expect(cells[0]!.fg).toBe("#3366cc");
		expect(cells[2]!.bg).toBe("#3366cc");
		expect(cells[2]!.fg).toBe("#ffffff");
	});

	it("draws marks wherever their text occurs in prose", () => {
		const rows = renderMarkdown("run @file now", 40, { theme, marks: [{ t: "@file", s: "accent" }] });
		const cells = cellGrid(rows)[0]!;
		expect(cells[4]!.fg).not.toBe("");
		expect(cells[0]!.fg).toBe("");
	});

	it("applies the prose style to every text run and restores it after styled runs", () => {
		const cells = cellGrid(renderMarkdown("a `c` b", 20, { theme, textStyle: "muted em" }))[0]!;
		expect(cells[0]!.italic && cells[4]!.italic).toBe(true);
		expect(cells[0]!.fg).toBe(cells[4]!.fg);
		expect(cells[2]!.italic).toBe(false);
	});
});

describe("html", () => {
	it("shows unknown tags as written and turns <br> into a line break", () => {
		expect(plain("Use <kbd>Ctrl</kbd> and <br> next", 40)).toEqual(["Use <kbd>Ctrl</kbd> and", "next"]);
	});

	it("hides comments and strips span/text tags, decoding entities", () => {
		expect(plain("Before\n\n<!-- -->\n\nAfter", 40)).toEqual(["Before", "", "After"]);
		expect(plain("<span></span><text>▃</text>", 40)).toEqual(["▃"]);
		expect(plain("<span>&lt;▃&gt;</span> &amp; &quot;t&quot; &#128512; &#x1F600;", 40)).toEqual(['<▃> & "t" 😀 😀']);
	});

	it("draws HTML lists, paragraphs, rules and quotes as structure", () => {
		expect(plain("<ol><li>First</li><li>Second</li></ol>", 40)).toEqual(["1. First", "2. Second"]);
		expect(plain("<ul>\n  <li>First</li>\n  <li>Second</li>\n</ul>", 40)).toEqual(["• First", "• Second"]);
		expect(
			plain(
				'<ul><li>Parent<ul><li>Child</li></ul><ol start="3"><li>Ordered</li></ol></li><li>Sibling</li></ul>',
				40,
			),
		).toEqual(["• Parent", "  • Child", "  3. Ordered", "• Sibling"]);
		expect(plain("<p>First.</p><p>Second.</p>", 40)).toEqual(["First.", "Second."]);
		expect(plain("before\n\n<hr>\n\nafter", 10)).toEqual(["before", "", "─".repeat(10), "", "after"]);
		expect(plain("<blockquote>heads up</blockquote>", 40)).toEqual(["▏ heads up"]);
		expect(plain("First<br><br>Second", 40)).toEqual(["First", "", "Second"]);
	});

	it("formats HTML inside table cells", () => {
		const rows = plain("| Result |\n| --- |\n| <ul><li>Pass<br>OK</li></ul> |", 80);
		expect(rows).toEqual(["┌────────┐", "│ Result │", "├────────┤", "│ • Pass │", "│ OK     │", "└────────┘"]);
		expect(plain("| A |\n| --- |\n| x<hr>y |", 20)).toContain("│ y │");
	});

	it("renders inline <code> like a code span", () => {
		expect(renderMarkdown("call <code>a(&amp;b)</code> now", 40, { theme })).toEqual(
			renderMarkdown("call `a(&b)` now", 40, { theme }),
		);
		expect(plain("text <code>dangling", 40)).toEqual(["text dangling"]);
	});
});

describe("colorful", () => {
	it("paints headings by depth, emphasis, inline code and table headers from the palette", () => {
		const fg = (source: string, colorful: boolean): string =>
			cellGrid(renderMarkdown(source, 40, { theme, colorful }))[0]!.find(cell => cell.ch !== " " && cell.ch !== "│")!
				.fg;
		expect(fg("# h", true)).toBe("#bc3fbc");
		expect(fg("## h", true)).toBe("#e5e510");
		expect(fg("#### h", true)).toBe("#2472c8");
		expect(fg("**b**", true)).toBe("#bc3fbc");
		expect(fg("`c`", true)).toBe("#0dbc79");
		expect(fg("# h", false)).toBe("#febc38");
		expect(fg("**b**", false)).toBe("");
	});
});

describe("cell comparison", () => {
	it("ignores the invisible style of spaces but not their background or decorations", () => {
		expect(firstCellDiff(["a\x1b[32m  \x1b[39mb"], ["a  b"])).toBeNull();
		expect(firstCellDiff(["a\x1b[1;3m  \x1b[22;23mb"], ["a  b"])).toBeNull();
		expect(firstCellDiff(["a\x1b[41m  \x1b[49mb"], ["a  b"])).not.toBeNull();
		expect(firstCellDiff(["a\x1b[4m  \x1b[24mb"], ["a  b"])).not.toBeNull();
		expect(firstCellDiff(["\x1b[32mab"], ["ab"])).not.toBeNull();
	});
});

describe("extension links", () => {
	const linkFg = cellGrid([theme.fg("mdExtensionLink", "x")])[0]![0]!.fg;

	it("draws a registered scheme's label alone, underlined in mdExtensionLink, inside its marker", () => {
		const rows = renderMarkdown("See [the demo](Demo:x/1) and [web](https://e.com).", 80, {
			theme,
			linkSchemes: ["demo"],
		});
		expect(plainRows(rows)[0]!.trimEnd()).toBe("See the demo and web (https://e.com).");
		const cells = cellGrid(rows)[0]!;
		const label = cells.slice(4, 12);
		expect(label.every(cell => cell.underline > 0 && cell.fg === linkFg)).toBe(true);
		expect(cells[3]!.underline).toBe(0);
		expect(cells[12]!.underline).toBe(0);
		const { row, links } = takeExtensionLinks(rows[0]!);
		expect(links).toEqual([{ href: "Demo:x/1", start: 4, end: 12, endsRow: false }]);
		expect(row).not.toContain(EXTENSION_LINK_ID);
		expect(plainRows([row])).toEqual(plainRows(rows));
	});

	it("repeats the marker on every row a wrapped label spans", () => {
		const rows = renderMarkdown("Go [alpha beta gamma](demo:g) now", 12, { theme, linkSchemes: ["demo"] });
		const spans = rows.map(row => takeExtensionLinks(row).links);
		expect(spans.flat().every(span => span.href === "demo:g")).toBe(true);
		expect(spans[0]!.at(-1)!.endsRow).toBe(true);
		expect(spans[1]![0]!.start).toBe(0);
	});

	it("draws other schemes, and every link without registered schemes, as web links", () => {
		expect(plain("[x](demo:x)", 40)[0]!.trimEnd()).toBe("x (demo:x)");
		expect(plain("[x](other:x)", 40, { linkSchemes: ["demo"] })[0]!.trimEnd()).toBe("x (other:x)");
	});
});
