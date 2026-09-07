import { afterEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const hasLine = (lines: readonly string[], n: number): boolean =>
	new RegExp(`\\bline ${n}\\b`).test(stripAnsi(lines.join("\n")));

/**
 * Normalizes adjacent duplicate foreground resets (\x1b[39m\x1b[39m -> \x1b[39m) at the
 * gutter boundary, matching the leading-reset convention between one-shot and streaming
 * highlighters without stripping meaningful resets or masking color bleed.
 */
const normalizeRedundantResets = (lines: readonly string[]): string[] =>
	lines.map(line => line.replace(/\x1b\[39m\x1b\[39m/g, "\x1b[39m"));

/** Extracts the rendered code rows between the framed block header and the status/footer rows. */
const extractCodeRows = (lines: readonly string[]): string[] => lines.slice(1, -2);
/**
 * Reference algorithm: the pre-incremental formatter normalized the whole
 * payload, split every line, and sliced the tail window. The incremental
 * collapsed path must produce byte-identical rows for the same content.
 */
function referenceWindow(content: string): { total: number; start: number; visible: string[] } {
	const lines = content.replace(/\r/g, "").split("\n");
	const total = lines.length;
	const start = Math.max(0, total - 12);
	return { total, start, visible: lines.slice(start) };
}

describe("write streaming preview incremental line tracking", () => {
	let initialized = false;
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function getUiTheme() {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		return uiTheme;
	}

	function renderCollapsed(content: string, options: { expanded: boolean; isPartial: boolean; spinnerFrame: number }) {
		return getUiTheme().then(uiTheme => {
			const component = writeToolRenderer.renderCall({ path: "/tmp/inc.ts", content }, options, uiTheme);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			return component.render(120);
		});
	}

	it("tracks an append-only stream through one shared render-state object", async () => {
		// The reveal loop rebuilds via renderCall once per tick with the SAME
		// persistent options object; simulate growth 5 → 12 → 13 → 25 → 40 lines.
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const allLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);

		for (const count of [5, 12, 13, 25, 40]) {
			const content = allLines.slice(0, count).join("\n");
			const rendered = await renderCollapsed(content, options);
			const { total, start } = referenceWindow(content);
			expect(total).toBe(count);
			// Window shows exactly lines start+1..total with correct numbering.
			expect(hasLine(rendered, total)).toBe(true);
			if (start > 0) {
				expect(hasLine(rendered, start)).toBe(false);
				expect(hasLine(rendered, start + 1)).toBe(true);
				expect(stripAnsi(rendered.join("\n"))).toContain(`${start} earlier line`);
			} else {
				expect(hasLine(rendered, 1)).toBe(true);
				expect(stripAnsi(rendered.join("\n"))).not.toContain("earlier line");
			}
		}
	});

	it("matches the split-based reference window across a size battery", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		for (const count of [1, 2, 3, 11, 12, 13, 40, 41]) {
			// Fresh options per size: each tool call gets its own render state.
			const content = Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
			const rendered = stripAnsi((await renderCollapsed(content, options)).join("\n"));
			const { total, start, visible } = referenceWindow(content);
			expect(total).toBe(count);
			for (let i = 0; i < visible.length; i++) {
				const lineNum = start + i + 1;
				expect(rendered).toContain(`${lineNum}`);
				expect(rendered).toContain(visible[i]!);
			}
			if (start > 0) expect(rendered).toContain(`… (${start} earlier line${start === 1 ? "" : "s"})`);
		}
	});
	it("retains multiline syntax highlighting across collapsed scroll boundaries", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const chunks = [
			"/*\n",
			Array.from({ length: 14 }, (_, i) => `comment line ${i + 1}\n`).join(""),
			"const insideComment = 123;\n",
			"*/\n",
			"const outsideComment = 456;\n",
		];

		let acc = "";
		for (let i = 0; i < chunks.length; i++) {
			acc += chunks[i];
			const component = writeToolRenderer.renderCall(
				{ path: "/tmp/multiline.ts", content: acc },
				options,
				uiTheme,
			);
			if (!component) throw new Error("expected rendered component");
			const rendered = component.render(120);
			const fullText = stripAnsi(rendered.join("\n"));

			if (i === 2) {
				// Chunk 3: /* has scrolled offscreen into earlier lines header
				expect(fullText).toContain("earlier line");
				expect(fullText).not.toContain("/*");
				const insideLine = rendered.find(line => line.includes("insideComment"));
				expect(insideLine).toBeDefined();
				expect(insideLine).toContain(uiTheme.getFgAnsi("syntaxComment"));
				expect(insideLine).not.toContain(uiTheme.getFgAnsi("syntaxKeyword"));
				expect(stripAnsi(insideLine!)).toContain("const insideComment = 123;");
			}

			if (i === 4) {
				// Chunk 5: outside multiline comment
				const outsideLine = rendered.find(line => line.includes("outsideComment"));
				expect(outsideLine).toBeDefined();
				expect(outsideLine).toContain(uiTheme.getFgAnsi("syntaxKeyword"));
				expect(outsideLine).not.toContain(uiTheme.getFgAnsi("syntaxComment"));
				expect(stripAnsi(outsideLine!)).toContain("const outsideComment = 456;");
			}
		}
	});

	it("produces identical completed-line highlighting and text integrity across chunk boundaries", async () => {
		const uiTheme = await getUiTheme();
		const splits = [
			"/",
			"* comment\n",
			" * more comment\n*",
			"/\nconst answer = 42;\n",
		];
		const fixture = splits.join("");

		// Path A (One-shot)
		const optionsA = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const compA = writeToolRenderer.renderCall(
			{ path: "/tmp/fixture.ts", content: fixture },
			optionsA,
			uiTheme,
		);
		if (!compA) throw new Error("expected rendered component");
		const renderedA = compA.render(120);

		// Path B (Streamed)
		const optionsB = { expanded: false, isPartial: true, spinnerFrame: 0 };
		let accB = "";
		let renderedB: readonly string[] = [];
		for (let i = 0; i < splits.length; i++) {
			accB += splits[i];
			const compB = writeToolRenderer.renderCall(
				{ path: "/tmp/fixture.ts", content: accB },
				optionsB,
				uiTheme,
			);
			if (!compB) throw new Error("expected rendered component");
			renderedB = compB.render(120);

			if (i === 0) {
				// Partial line after Split 1: "/"
				const text1 = stripAnsi(renderedB.join("\n"));
				expect(text1).toContain("1 /");
				expect(text1).not.toContain("/*");
			}

			if (i === 2) {
				// Partial line after Split 3: trailing "*"
				const text3 = stripAnsi(renderedB.join("\n"));
				expect(text3).toContain("1 /* comment");
				expect(text3).toContain("2  * more comment");
				expect(text3).toContain("3 *");
				expect(text3).not.toContain("3 */");
			}
		}

		// Completed lines after Split 4: extract code rows (lines between header and footer)
		const codeRowsA = normalizeRedundantResets(extractCodeRows(renderedA));
		const codeRowsB = normalizeRedundantResets(extractCodeRows(renderedB));
		expect(codeRowsB).toEqual(codeRowsA);
	});

	it("normalizes CRLF only in the rendered tail, with correct line numbers", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n");
		const rendered = await renderCollapsed(content, options);
		const text = stripAnsi(rendered.join("\n"));
		expect(text).not.toContain("\r");
		// 20 lines → window is lines 9..20.
		expect(text).toContain("… (8 earlier lines)");
		expect(hasLine(rendered, 8)).toBe(false);
		expect(hasLine(rendered, 9)).toBe(true);
		expect(hasLine(rendered, 20)).toBe(true);
	});

	it("counts a trailing newline as a final empty row, matching the reference", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const content = `${Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const rendered = await renderCollapsed(content, options);
		const { total, start } = referenceWindow(content);
		expect(total).toBe(14);
		expect(start).toBe(2);
		const text = stripAnsi(rendered.join("\n"));
		expect(text).toContain("… (2 earlier lines)");
		expect(hasLine(rendered, 13)).toBe(true);
		expect(hasLine(rendered, 2)).toBe(false);
	});

	it("renders carriage-return-only content like the previous normalized empty payload", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const empty = await renderCollapsed("", options);
		const carriageReturns = await renderCollapsed("\r\r", {
			expanded: false,
			isPartial: true,
			spinnerFrame: 0,
		});
		expect(carriageReturns).toEqual(empty);
	});

	it("resets state and purges old source from screen when content is replaced", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const first = "const original = 1;\nconst common = 2;\n";
		const comp1 = writeToolRenderer.renderCall(
			{ path: "/tmp/restart.ts", content: first },
			options,
			uiTheme,
		);
		if (!comp1) throw new Error("expected rendered component");
		comp1.render(120);

		const second = "const restarted = 99;\nconst common = 2;\nconst extra = 3;\n";
		const comp2 = writeToolRenderer.renderCall(
			{ path: "/tmp/restart.ts", content: second },
			options,
			uiTheme,
		);
		if (!comp2) throw new Error("expected rendered component");
		const rendered2 = comp2.render(120);

		const optionsFresh = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const compFresh = writeToolRenderer.renderCall(
			{ path: "/tmp/restart.ts", content: second },
			optionsFresh,
			uiTheme,
		);
		if (!compFresh) throw new Error("expected rendered component");
		const renderedFresh = compFresh.render(120);

		const text2 = stripAnsi(rendered2.join("\n"));
		expect(text2).toContain("const restarted = 99;");
		expect(text2).not.toContain("const original = 1;");

		const codeRows2 = extractCodeRows(rendered2);
		const codeRowsFresh = extractCodeRows(renderedFresh);
		expect(codeRows2).toEqual(codeRowsFresh);
	});

	it("resumes append tracking across a CR boundary without miscounting", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const part1 = "line 1\r\nline 2\r";
		const part2 = "line 1\r\nline 2\r\nline 3\r\nline 4";
		await renderCollapsed(part1, options);
		const rendered = await renderCollapsed(part2, options);
		const { total } = referenceWindow(part2);
		expect(total).toBe(4);
		expect(hasLine(rendered, 4)).toBe(true);
		expect(hasLine(rendered, 1)).toBe(true);
		expect(stripAnsi(rendered.join("\n"))).not.toContain("earlier line");
	});
});
