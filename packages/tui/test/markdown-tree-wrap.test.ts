import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/utils";
import { Chalk } from "@oh-my-pi/pi-utils/chalk";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 40;

function renderRaw(text: string, width = WIDTH): readonly string[] {
	return new Markdown(text, 0, 0, defaultMarkdownTheme).render(width);
}

/** Rendered rows as plain text, right-padding stripped (rows are padded to full width). */
function renderPlain(text: string, width = WIDTH): string[] {
	return renderRaw(text, width).map(line => stripVTControlCharacters(line).trimEnd());
}

describe("Markdown tree-guide hanging wrap", () => {
	it("hangs an overflowing '├── ' node under the node-text column with double-width Korean text", () => {
		const node = "가나다라 마바사아 자차카타 파하가나 다라마바 사자차카"; // 6 words x 8 cells
		const raw = renderRaw(`├── ${node}`);
		const plain = raw.map(line => stripVTControlCharacters(line).trimEnd());

		expect(plain.length).toBeGreaterThanOrEqual(2);
		expect(plain[0]!.startsWith("├── 가나다라")).toBeTruthy();

		for (const line of plain.slice(1)) {
			// Exactly `│` + 3 spaces: the node text column is cell 4, so the
			// continuation text must begin right there — not a cell earlier or later.
			expect(line.startsWith("│   ")).toBeTruthy();
			expect(line[4]).not.toBe(" ");
		}
		for (const line of raw) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}

		// No glyph may be lost or duplicated by the wrap (spaces are consumed at
		// break points, so compare with spaces removed).
		const rejoined = [plain[0]!.slice("├── ".length), ...plain.slice(1).map(line => line.slice("│   ".length))]
			.join("")
			.replace(/ /g, "");
		expect(rejoined).toBe(node.replace(/ /g, ""));
	});

	it("keeps the outer rail and releases the corner for a nested '│   └── ' node", () => {
		const plain = renderPlain("│   └── delta echo foxtrot golf hotel india juliet");

		expect(plain.length).toBeGreaterThanOrEqual(2);
		expect(plain[0]!.startsWith("│   └── delta")).toBeTruthy();
		for (const line of plain.slice(1)) {
			// `│` stays (outer level still open), `└──` releases to spaces.
			expect(line.startsWith("│       ")).toBeTruthy();
			expect(line[8]).not.toBe(" ");
		}
	});

	it("releases a last-child '└── ' node to pure spaces with no rail on continuations", () => {
		const plain = renderPlain("└── alpha bravo charlie delta echo foxtrot golf hotel");

		expect(plain.length).toBeGreaterThanOrEqual(2);
		expect(plain[0]!.startsWith("└── alpha")).toBeTruthy();
		for (const line of plain.slice(1)) {
			expect(line.startsWith("    ")).toBeTruthy();
			expect(line[4]).not.toBe(" ");
			expect(line.includes("│")).toBeFalsy();
		}
	});

	it("treats the rounded corner '╰── ' like '└── '", () => {
		const plain = renderPlain("╰── alpha bravo charlie delta echo foxtrot golf hotel");

		expect(plain.length).toBeGreaterThanOrEqual(2);
		expect(plain[0]!.startsWith("╰── alpha")).toBeTruthy();
		for (const line of plain.slice(1)) {
			expect(line.startsWith("    ")).toBeTruthy();
			expect(line[4]).not.toBe(" ");
			expect(line.includes("│")).toBeFalsy();
		}
	});

	it("leaves a non-tree paragraph byte-identical to the plain wrap", () => {
		const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
		const plain = renderPlain(text);

		// Differential against the generic wrapper: the tree feature must not
		// have touched this paragraph at all.
		const expected = wrapTextWithAnsi(text, WIDTH).map(line => line.trimEnd());
		expect(plain).toEqual(expected);

		expect(plain.length).toBeGreaterThanOrEqual(2);
		for (const line of plain.slice(1)) {
			expect(line[0]).not.toBe(" ");
			expect(line[0]).not.toBe("│");
		}
	});

	it("does not treat a dash-only '── ' start as a tree", () => {
		const text = "── alpha bravo charlie delta echo foxtrot golf hotel india";
		const plain = renderPlain(text);

		const expected = wrapTextWithAnsi(text, WIDTH).map(line => line.trimEnd());
		expect(plain).toEqual(expected);

		expect(plain.length).toBeGreaterThanOrEqual(2);
		for (const line of plain.slice(1)) {
			// Flush at column 0: no injected hang, no rail.
			expect(line[0]).not.toBe(" ");
			expect(line[0]).not.toBe("│");
		}
	});

	it("renders a fitting tree line-for-line unchanged", () => {
		const plain = renderPlain("├── alpha\n│   └── beta\n└── gamma");

		expect(plain).toEqual(["├── alpha", "│   └── beta", "└── gamma"]);
	});

	it("leaves '├── ' lines inside fenced code blocks to the code frame, not the tree wrap", () => {
		const codeLine = "├── alpha bravo charlie delta echo foxtrot golf hotel india";
		const raw = renderRaw(`\`\`\`\n${codeLine}\n\`\`\``);
		const plain = raw.map(line => stripVTControlCharacters(line).trimEnd());

		// Fences render as a compact frame; the tree glyph is code text here, so
		// the markdown tree-hanging wrap must not claim it.
		expect(plain[0]).toMatch(/^\+-+\+$/);
		expect(plain[plain.length - 1]).toMatch(/^\+-+\+$/);
		expect(plain.some(line => line.includes("```"))).toBe(false);

		const body = plain.slice(1, -1);
		expect(body.length).toBeGreaterThanOrEqual(2);
		for (const line of body) {
			expect(line.startsWith("| ")).toBeTruthy();
			expect(line.endsWith("|")).toBeTruthy();
		}
		// The default ASCII preset keeps the frame gutter ASCII-only and never
		// applies the markdown hanging indent to the code payload.
		expect(body[0]).toContain("| 1 | ├── alpha");
		expect(body[1]).toMatch(/^\|\s+\|\s/);

		// No glyph lost or duplicated by the frame's wrap.
		const text = body
			.map(line => line.replace(/^\|\s*(?:\d+\s+)?\|\s/, "").replace(/\|$/, ""))
			.join("")
			.replace(/ /g, "");
		expect(text).toBe(codeLine.replace(/ /g, ""));

		for (const line of raw) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	it("carries an open bold span onto the continuation row", () => {
		const raw = renderRaw("├── aaaa bbbb **cccc dddd eeee ffff gggg hhhh**");
		const plain = raw.map(line => stripVTControlCharacters(line).trimEnd());

		// Row 0 holds 36 node cells ("aaaa bbbb cccc dddd eeee ffff gggg"),
		// so "hhhh" — inside the bold span — lands on the continuation row.
		expect(plain.length).toBeGreaterThanOrEqual(2);
		expect(plain[1]!.startsWith("│   hhhh")).toBeTruthy();

		const continuation = raw[1]!;
		const boldOpen = continuation.indexOf("\x1b[1m");
		expect(boldOpen).toBeGreaterThanOrEqual(0);
		expect(boldOpen).toBeLessThan(continuation.indexOf("hhhh"));
	});

	it("hangs inside a blockquote, after the quote border", () => {
		const plain = renderPlain("> ├── alpha bravo charlie delta echo foxtrot golf hotel india");

		expect(plain.length).toBeGreaterThanOrEqual(2);
		// Quote border symbol, border gap, then the tree prefix.
		expect(plain[0]!.startsWith("│ ├── alpha")).toBeTruthy();
		const continuations = plain.slice(1).filter(line => line !== ""); // drop trailing spacing rows
		expect(continuations.length).toBeGreaterThanOrEqual(1);
		for (const line of continuations) {
			expect(line.startsWith("│ │   ")).toBeTruthy();
			expect(line[6]).not.toBe(" ");
		}
	});

	describe("detection strictness and carry edge cases", () => {
		const SGR_RE = /\x1b\[[0-9;:]*m/g;

		it("keeps plain wrap for prose starting with a lone '│ ' rail glyph", () => {
			const text = "│ is the Unicode vertical box drawing glyph used for rails in terminal trees";
			const raw = renderRaw(text);

			// Byte-identical to the generic wrapper: no branch+connector pair,
			// so the tree feature must not inject rails or indent.
			expect(raw.map(line => line.trimEnd())).toEqual(wrapTextWithAnsi(text, WIDTH).map(line => line.trimEnd()));

			const plain = renderPlain(text);
			expect(plain.length).toBeGreaterThanOrEqual(2); // the paragraph really overflowed
			for (const line of plain.slice(1)) {
				expect(line[0]).not.toBe(" ");
				expect(line[0]).not.toBe("│");
			}
		});

		it("keeps plain wrap for prose starting with '├ ' without a horizontal connector", () => {
			const text = "├ marks a branch point in a tree diagram and has no horizontal connector here";
			const raw = renderRaw(text);

			expect(raw.map(line => line.trimEnd())).toEqual(wrapTextWithAnsi(text, WIDTH).map(line => line.trimEnd()));

			const plain = renderPlain(text);
			expect(plain.length).toBeGreaterThanOrEqual(2);
			for (const line of plain.slice(1)) {
				expect(line[0]).not.toBe(" ");
				expect(line[0]).not.toBe("│");
			}
		});

		it("falls back to plain wrap when fewer than 8 content cells remain after the prefix", () => {
			const text = "├── alpha bravo charlie delta echo foxtrot golf hotel india";

			// Width 10 leaves 10 - 4 = 6 content cells after the '├── ' prefix:
			// below the minimum, so the hang degenerates and plain wrap wins.
			const raw = renderRaw(text, 10);
			expect(raw.map(line => line.trimEnd())).toEqual(wrapTextWithAnsi(text, 10).map(line => line.trimEnd()));
			const plain = renderPlain(text, 10);
			expect(plain.length).toBeGreaterThanOrEqual(2);
			for (const line of plain.slice(1)) {
				expect(line[0]).not.toBe(" ");
				expect(line[0]).not.toBe("│");
			}

			// Width 12 leaves exactly 8 content cells — the boundary where the
			// hanging wrap applies again.
			const hung = renderPlain(text, 12);
			expect(hung[0]).toBe("├── alpha");
			expect(hung.length).toBeGreaterThanOrEqual(2);
			for (const line of hung.slice(1)) {
				expect(line.startsWith("│   ")).toBeTruthy();
				expect(line[4]).not.toBe(" ");
			}
		});

		it("replays SGR state opened on an earlier line onto a later hung line's continuation rows", () => {
			// With a default text style, the renderer re-opens the default color
			// after `**bold**` (the style prefix) and the soft break leaves that
			// re-open unclosed — a style opened on line 1 that is still active
			// when line 2 hangs. Line 1's bold open/close pair exists nowhere on
			// line 2, so finding it ahead of the continuation text proves the
			// carry was re-played rather than line 2's own codes.
			const chalk = new Chalk({ level: 3 });
			const raw = new Markdown(
				"aaa **bold**\n├── alpha bravo charlie delta echo foxtrot golf hotel india",
				0,
				0,
				defaultMarkdownTheme,
				{ color: text => chalk.red(text) },
			).render(WIDTH);
			const plain = raw.map(line => stripVTControlCharacters(line).trimEnd());

			expect(plain.length).toBe(3);
			expect(plain[1]!.startsWith("├── alpha")).toBeTruthy();
			expect(plain[2]!.startsWith("│   foxtrot")).toBeTruthy();

			// Line 1 genuinely ends with an unclosed style: its last SGR is the
			// default-color re-open, not a close.
			const row0Codes = raw[0]!.trimEnd().match(SGR_RE)!;
			expect(row0Codes[row0Codes.length - 1]).toBe("\x1b[31m");

			// The continuation row starts with a zero-width SGR run that replays
			// line 1's history (the carried bold pair) and nets out to the
			// default color being open ahead of the visible text.
			const continuation = raw[2]!;
			const hangAt = continuation.indexOf("│   ");
			expect(hangAt).toBeGreaterThan(0);
			const replayed = continuation.slice(0, hangAt);
			expect(replayed.replace(SGR_RE, "")).toBe("");
			expect(replayed).toContain("\x1b[1m");
			const replayedCodes = replayed.match(SGR_RE)!;
			expect(replayedCodes[replayedCodes.length - 1]).toBe("\x1b[31m");
		});

		it("re-renders byte-identically after a width round-trip (44 → 80 → 44)", () => {
			const doc = "├── alpha bravo charlie delta echo foxtrot golf\n└── hotel india juliet kilo lima mike november";
			const md = new Markdown(doc, 0, 0, defaultMarkdownTheme);

			const first = [...md.render(44)];
			// Narrow render actually hung — the round-trip below is not vacuous.
			expect(first.map(line => stripVTControlCharacters(line).trimEnd())).toEqual([
				"├── alpha bravo charlie delta echo foxtrot",
				"│   golf",
				"└── hotel india juliet kilo lima mike",
				"    november",
			]);

			// Wide render fits line-for-line: a genuinely different layout.
			const wide = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());
			expect(wide).toEqual([
				"├── alpha bravo charlie delta echo foxtrot golf",
				"└── hotel india juliet kilo lima mike november",
			]);

			expect([...md.render(44)]).toEqual(first);
			expect([...new Markdown(doc, 0, 0, defaultMarkdownTheme).render(44)]).toEqual(first);
		});

		it("does not leak styles opened before a full SGR reset onto later hung rows", () => {
			// Raw ANSI in component input passes through marked byte-exact: line 1
			// opens bold, fully resets, then opens italic. Only the italic — the
			// live style after the reset — may carry onto the hung line.
			const raw = renderRaw(
				"aaa \x1b[1mbold\x1b[0m\x1b[3mrest and filler\n├── alpha bravo charlie delta echo foxtrot golf hotel india",
			);
			const plain = raw.map(line => stripVTControlCharacters(line).trimEnd());

			expect(plain.length).toBe(3);
			expect(plain[1]!.startsWith("├── alpha")).toBeTruthy();
			expect(plain[2]!.startsWith("│   foxtrot")).toBeTruthy();

			for (const row of raw.slice(1)) {
				expect(row).not.toContain("\x1b[1m"); // dead pre-reset style must not re-play
				expect(row).not.toContain("\x1b[0m");
			}
			// The live post-reset style carries onto the hung line and is the
			// entire replayed run ahead of the continuation's hang glyphs.
			expect(raw[1]!.startsWith("\x1b[3m├── ")).toBeTruthy();
			const continuation = raw[2]!;
			const hangAt = continuation.indexOf("│   ");
			expect(hangAt).toBeGreaterThan(0);
			expect(continuation.slice(0, hangAt)).toBe("\x1b[3m");
		});
	});
});
