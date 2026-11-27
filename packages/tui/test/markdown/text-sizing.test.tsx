/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, it } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { capabilitiesFromEnv } from "../../src/driver/caps/env";
import { plainRows } from "../../src/testing/cells";
import { stripEscapes } from "../../src/text/ansi";
import { renderMarkdown } from "../../src/text/markdown";
import { textSizedRows } from "../../src/text/osc";
import { visibleWidth } from "../../src/text/width";
import { loadThemeSync } from "../../src/theme";

/**
 * Contract: with `textSizing`, a top-level H1 whose text fits at double width
 * draws as OSC 66 scale-2 spans on one row, followed by one blank row its
 * glyphs extend into, then the usual separator. Off (the default), too wide,
 * nested or carrying an extension link, it draws as before.
 */

const theme = loadThemeSync("dark");
const SPAN = "\x1b]66;s=2;Hello World\x1b\\";

function sized(source: string, width: number, paddingX = 0): string[] {
	return renderMarkdown(source, width, { theme, textSizing: true, paddingX });
}

describe("sized H1 rows", () => {
	it.each([40, 30, 22])("reserves the scaled height at width %i", width => {
		const rows = sized("# Hello World\n\nBody", width);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toContain(SPAN);
		expect(textSizedRows(rows[0]!)).toBe(2);
		expect(visibleWidth(rows[0]!)).toBe(width);
		expect(rows[1]).toBe(" ".repeat(width));
		expect(rows[2]).toBe(" ".repeat(width));
		expect(plainRows(rows)[3]).toBe("Body");
	});

	it("draws normally when the doubled text does not fit", () => {
		const rows = sized("# Hello World\n\nBody", 21);
		expect(rows.some(row => row.includes("\x1b]66;"))).toBe(false);
		expect(rows).toEqual(renderMarkdown("# Hello World\n\nBody", 21, { theme }));
	});

	it("fits the doubled text inside the horizontal padding", () => {
		const rows = sized("# Hello World", 26, 2);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.startsWith("  ")).toBe(true);
		expect(rows[0]).toContain(SPAN);
		expect(visibleWidth(rows[0]!)).toBe(26);
		expect(sized("# Hello World", 25, 2).some(row => row.includes("\x1b]66;"))).toBe(false);
	});

	it("gives every non-ASCII grapheme its own span with its cell count", () => {
		const rows = sized("# 日本 ok", 40);
		expect(rows[0]).toContain("\x1b]66;s=2:w=2;日\x1b\\\x1b]66;s=2:w=2;本\x1b\\\x1b]66;s=2; ok\x1b\\");
		expect(visibleWidth(rows[0]!)).toBe(40);
	});

	it("draws a link's label alone, linked when hyperlinks are on", () => {
		const source = "# A **bold** [link](https://e.com)";
		const linked = renderMarkdown(source, 40, { theme, textSizing: true, hyperlinks: true });
		expect(linked[0]).toContain(
			"\x1b]66;s=2;A bold \x1b\\\x1b]8;;https://e.com\x07\x1b]66;s=2;link\x1b\\\x1b]8;;\x07",
		);
		expect(linked[0]).not.toContain("(https://e.com)");
		expect(visibleWidth(linked[0]!)).toBe(40);

		const unlinked = sized(source, 40);
		expect(unlinked[0]).toContain("\x1b]66;s=2;A bold link\x1b\\");
		expect(unlinked[0]).not.toContain("\x1b]8;");
	});

	it("measures a linked heading by its label: sized at twice the label's width, not one cell less", () => {
		const source = "# A **bold** [link](https://e.com)";
		expect(sized(source, 22)[0]).toContain("\x1b]66;");
		expect(sized(source, 21).some(row => row.includes("\x1b]66;"))).toBe(false);
	});

	it("leaves other headings, nested headings and extension links alone", () => {
		for (const source of ["## Two", "- # In a list", "> # In a quote", "# Open [it](demo:x)"]) {
			const options = { theme, linkSchemes: ["demo"] };
			expect(renderMarkdown(source, 40, { ...options, textSizing: true })).toEqual(
				renderMarkdown(source, 40, options),
			);
		}
	});

	it("is off by default", () => {
		expect(renderMarkdown("# Hello World", 40, { theme }).some(row => row.includes("\x1b]66;"))).toBe(false);
	});

	it("keeps sized and unsized rows apart in the streaming block cache", () => {
		const source = "# Hello World\n\nBody still";
		const plain = renderMarkdown(source, 40, { theme, stream: true });
		const big = renderMarkdown(source, 40, { theme, stream: true, textSizing: true });
		expect(plain[0]).not.toContain("\x1b]66;");
		expect(big[0]).toContain(SPAN);
		expect(big).toHaveLength(plain.length + 1);
	});
});

describe("sized H1 in the md painter", () => {
	it("follows the paint environment", () => {
		const tree = <md text="# Hello World" />;
		const off = renderBlock(tree as never, 40, { env: staticEnvironment(theme) }).rows;
		const on = renderBlock(tree as never, 40, { env: staticEnvironment(theme, { textSizing: true }) }).rows;
		expect(off.some(row => row.includes("\x1b]66;"))).toBe(false);
		expect(on).toEqual(sized("# Hello World", 40));
	});

	it("draws in the terminal renderer only when the terminal supports it and the host allows it", () => {
		const allow = signal(true);
		const frame = (supported: boolean, textSizing?: () => boolean) => {
			const term = createTestTerminal(() => ({ main: <md text="# Hello World" /> }), {
				columns: 40,
				capabilities: { textSizing: supported },
				...(textSizing ? { textSizing } : {}),
			});
			try {
				return term.rows();
			} finally {
				term.dispose();
			}
		};
		const hasSpan = (rows: readonly string[]) => rows.some(row => row.includes("\x1b]66;"));
		expect(hasSpan(frame(true, allow))).toBe(true);
		expect(hasSpan(frame(false, allow))).toBe(false);
		expect(hasSpan(frame(true))).toBe(false);
		allow.set(false);
		expect(hasSpan(frame(true, allow))).toBe(false);
	});

	it("repaints when the host's permission changes", () => {
		const allow = signal(false);
		const term = createTestTerminal(() => ({ main: <md text="# Hello World" /> }), {
			columns: 40,
			capabilities: { textSizing: true },
			textSizing: allow,
		});
		try {
			expect(term.rows().some(row => row.includes("\x1b]66;"))).toBe(false);
			allow.set(true);
			term.render();
			expect(term.rows().some(row => row.includes(SPAN))).toBe(true);
			expect(stripEscapes(term.rows()[1] ?? "").trim()).toBe("");
		} finally {
			term.dispose();
		}
	});
});

describe("textSizing capability", () => {
	it("is Kitty's, and never through a multiplexer", () => {
		const base = { platform: "darwin" as const, wsl: false, tmuxPassthrough: true };
		const context = { ...base, id: "kitty" as const };
		expect(capabilitiesFromEnv({ KITTY_WINDOW_ID: "1" }, context).textSizing).toBe(true);
		expect(capabilitiesFromEnv({ KITTY_WINDOW_ID: "1", TMUX: "/tmp/tmux-1/default,1,0" }, context).textSizing).toBe(
			false,
		);
		expect(capabilitiesFromEnv({}, { ...base, id: "ghostty" }).textSizing).toBe(false);
	});
});
