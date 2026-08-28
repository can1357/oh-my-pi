import { afterEach, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { clearRenderCache, Markdown, type MarkdownTheme } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

// A whole-line wrap that survives strip — used to detect which rows the
// renderer attributed to the selected fence.
const OPEN = "\u0001HL\u0001";
const CLOSE = "\u0001HLEND\u0001";
const highlightFn = (text: string): string => `${OPEN}${text}${CLOSE}`;

function highlightTheme(): MarkdownTheme {
	return { ...defaultMarkdownTheme, codeBlockHighlight: highlightFn };
}

// Real ANSI so stripped visible widths are exact (the marker pair above uses
// control bytes that would pollute width measurements).
const BAR = "\x1b[31m│\x1b[39m";
const BG = "\x1b[48;5;240m";
const BG_RESET = "\x1b[49m";
function barTheme(): MarkdownTheme {
	return {
		...defaultMarkdownTheme,
		codeBlockHighlight: text => `${BG}${text}${BG_RESET}`,
		codeBlockHighlightBar: () => BAR,
	};
}

function codeBlock(text: string, lang = ""): string {
	return `\`\`\`${lang}\n${text}\n\`\`\``;
}

function highlightedRows(rows: readonly string[]): string[] {
	return rows.filter(row => row.includes(OPEN));
}

afterEach(() => {
	clearRenderCache();
});

describe("Markdown setHighlightedFence", () => {
	it("wraps only the selected fence's rows", () => {
		const md = new Markdown(
			`${codeBlock("first block", "ts")}\n\n${codeBlock("second block", "py")}`,
			1,
			0,
			highlightTheme(),
		);
		md.setHighlightedFence(1);

		const rows = md.render(60);
		expect(highlightedRows(rows).length).toBeGreaterThan(0);
		expect(highlightedRows(rows).join("\n")).toContain("second block");
		expect(highlightedRows(rows).join("\n")).not.toContain("first block");
	});

	it("highlights the first fence with index 0 and clears on undefined", () => {
		const md = new Markdown(`${codeBlock("only")}`, 1, 0, highlightTheme());
		md.setHighlightedFence(0);
		const rows = md.render(60);
		expect(rows.some(row => row.includes(OPEN) && row.includes("only"))).toBe(true);

		md.setHighlightedFence(undefined);
		expect(md.render(60).join("\n")).not.toContain(OPEN);
	});

	it("keeps highlighted and plain renders distinct across the module cache", () => {
		const source = `${codeBlock("shared body", "js")}`;
		const highlighted = new Markdown(source, 1, 0, highlightTheme());
		const plain = new Markdown(source, 1, 0, highlightTheme());

		// Render plain first so the L2 cache holds the unhighlighted rows, then
		// highlight — the cache key includes the selected fence.
		const plainRows = plain.render(60).join("\n");
		expect(plainRows).not.toContain(OPEN);
		highlighted.setHighlightedFence(0);
		const highlightedRows2 = highlighted.render(60).join("\n");
		expect(highlightedRows2).toContain(OPEN);
		expect(highlightedRows2).not.toBe(plainRows);
	});

	it("counts only column-0 backtick fences (tilde fences are not copy targets)", () => {
		const md = new Markdown(`~~~\ntilde\n~~~\n\n${codeBlock("backtick")}`, 1, 0, highlightTheme());
		// The tilde fence is not a column-0 backtick fence, so index 0 is the
		// backtick block — matching the coding agent's copy-target grammar.
		md.setHighlightedFence(0);

		const rows = md.render(60);
		expect(rows.some(row => row.includes(OPEN) && row.includes("backtick"))).toBe(true);
		expect(rows.some(row => row.includes(OPEN) && row.includes("tilde"))).toBe(false);
	});

	it("keeps highlighted rows at exactly the content width with the bar present", () => {
		// The bar occupies one column; the pad pass must reserve it so the
		// whole-line background wrapper never overflows the terminal width.
		const md = new Markdown(codeBlock("line one\nline two"), 1, 0, barTheme());
		md.setHighlightedFence(0);

		const rows = md.render(20);
		const highlighted = rows.filter(row => Bun.stripANSI(row).includes("│"));
		expect(highlighted.length).toBeGreaterThan(0);
		for (const row of highlighted) {
			expect(visibleWidth(Bun.stripANSI(row))).toBe(20);
		}
	});

	it("adds the accent bar to every wrapped row of a literal highlighted fence", () => {
		// Assistant messages render code with codeBlockIndent = 0; a long line
		// wraps, and each wrapped row must keep the bar (reserving its column
		// from the wrap width).
		const md = new Markdown(codeBlock("abcdefghijklmnopqrstuvwxyz"), 0, 0, barTheme(), undefined, 0);
		md.setHighlightedFence(0);

		const rows = md.render(12);
		const codeRows = rows.map(row => Bun.stripANSI(row)).filter(row => /[a-z]/.test(row));
		// The 26-char line wraps at 11 columns (12 minus the bar): three rows.
		expect(codeRows.length).toBe(3);
		for (const row of codeRows) {
			expect(row.startsWith("│")).toBe(true);
			expect(visibleWidth(row)).toBeLessThanOrEqual(12);
		}
	});

	it("reports the fence row span on an L2 cache hit (second identical instance)", () => {
		const source = `${codeBlock("first")}\n\n${codeBlock("second")}`;
		// The L2 key encodes theme identity; production instances share the
		// cached getMarkdownTheme() object, so share one here too.
		const theme = highlightTheme();
		const first = new Markdown(source, 1, 0, theme);
		first.setHighlightedFence(1);
		const firstRows = first.render(60);
		const firstRange = first.getHighlightedFenceRowRange(60);
		expect(firstRange).toBeDefined();

		// Identical text/width/highlight: the second instance is served the
		// cached rows, so its range must come from the cache entry, not fall
		// back to undefined (which would reveal the whole message).
		const second = new Markdown(source, 1, 0, theme);
		second.setHighlightedFence(1);
		expect(second.render(60)).toBe(firstRows);
		expect(second.getHighlightedFenceRowRange(60)).toEqual(firstRange);
	});
});
