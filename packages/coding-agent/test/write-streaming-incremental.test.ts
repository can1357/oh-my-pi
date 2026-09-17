import { afterEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { HighlightStream } from "@oh-my-pi/pi-natives";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const hasLine = (lines: readonly string[], n: number): boolean =>
	new RegExp(`\\bline ${n}\\b`).test(stripAnsi(lines.join("\n")));

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

	it("does not re-tokenize the whole markdown window as streamed content grows", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");
		const lines = Array.from(
			{ length: 40 },
			(_, index) => `- Step ${index + 1}: update \`src/example-${index + 1}.ts\` and verify the result`,
		);

		let rendered: readonly string[] = [];
		for (let count = 1; count <= lines.length; count++) {
			const component = writeToolRenderer.renderCall(
				{ path: "/tmp/plan.md", content: lines.slice(0, count).join("\n") },
				options,
				uiTheme,
			);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			rendered = component.render(120);
		}

		expect(stripAnsi(rendered.join("\n"))).toContain("Step 40");
		expect(highlightSpy).not.toHaveBeenCalled();
	});

	it("resets on same-length prefix replacement above a preserved tail", async () => {
		// A restarted stream can reuse the render state with a replacement that
		// preserves more tail than any bounded suffix guard could validate, so
		// only an exact append check may treat growth as incremental.
		const uiTheme = await getUiTheme();
		const options = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const render = (content: string) => {
			const component = writeToolRenderer.renderCall({ path: "/tmp/restart.ts", content }, options, uiTheme);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			return component.render(120);
		};
		const tail = `${"x".repeat(80)}\n`;
		render(`const original = 1;\n${tail}`);

		const text = stripAnsi(render(`const replaced = 1;\n${tail}const extra = 3;\n`).join("\n"));
		expect(text).toContain("replaced");
		expect(text).not.toContain("original");
		expect(text).toContain("extra");
	});

	it("feeds only newline-terminated chunks to the highlight stream", async () => {
		const uiTheme = await getUiTheme();
		const pushes: string[] = [];
		vi.spyOn(themeModule, "createHighlightStream").mockImplementation(
			() =>
				({
					push: (chunk: string) => {
						pushes.push(chunk);
						return chunk;
					},
				}) as unknown as HighlightStream,
		);
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		let acc = "";
		for (const piece of ["const a = ", "1;\nconst b = ", "2;\nconst c = 3"]) {
			acc += piece;
			const component = writeToolRenderer.renderCall({ path: "/tmp/chunks.ts", content: acc }, options, uiTheme);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			component.render(120);
		}
		expect(pushes).toEqual(["const a = 1;\n", "const b = 2;\n"]);
		const component = writeToolRenderer.renderCall({ path: "/tmp/chunks.ts", content: acc }, options, uiTheme);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("const c = 3");
	});

	it("highlights the trailing line once args are complete", async () => {
		const uiTheme = await getUiTheme();
		const pushes: string[] = [];
		vi.spyOn(themeModule, "createHighlightStream").mockImplementation(
			() =>
				({
					push: (chunk: string) => {
						pushes.push(chunk);
						return `H(${chunk})`;
					},
				}) as unknown as HighlightStream,
		);
		const content = "const solo = 1;";
		const streamingOptions = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const streaming = writeToolRenderer.renderCall({ path: "/tmp/solo.ts", content }, streamingOptions, uiTheme);
		if (!streaming) throw new Error("expected a rendered component for a non-xdev write path");
		const streamingText = stripAnsi(streaming.render(120).join("\n"));
		expect(streamingText).toContain("const solo = 1;");
		expect(streamingText).not.toContain("H(");
		expect(pushes).toEqual([]);

		const settledOptions = { expanded: true, isPartial: true, spinnerFrame: 0, argsComplete: true };
		const settled = writeToolRenderer.renderCall({ path: "/tmp/solo.ts", content }, settledOptions, uiTheme);
		if (!settled) throw new Error("expected a rendered component for a non-xdev write path");
		expect(stripAnsi(settled.render(120).join("\n"))).toContain("H(const solo = 1;)");
		expect(pushes).toEqual(["const solo = 1;"]);
		settled.render(120);
		expect(pushes).toEqual(["const solo = 1;"]);
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

	it("resets cleanly when a restarted stream is longer but not append-only", async () => {
		// A restarted stream can reuse the component render state with a longer
		// replacement buffer; the bounded suffix guard must reset the index.
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const first = "alpha 1\nalpha 2";
		await renderCollapsed(first, options);

		const restarted = `beta ${"x".repeat(100)}\nbeta 2`;
		const rendered = await renderCollapsed(restarted, options);
		const text = stripAnsi(rendered.join("\n"));
		expect(text).not.toContain("earlier line");
		expect(text).toContain("beta");
		expect(text).not.toContain("alpha");
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
