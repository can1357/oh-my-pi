import { describe, expect, it } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";

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

	it("does not compare the full accumulated payload when validating append-only growth", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const first = Array.from({ length: 2_000 }, () => "x".repeat(64)).join("\n");
		writeToolRenderer.renderCall({ path: "/tmp/inc.ts", content: first }, options, uiTheme)?.render(120);

		const originalStartsWith = String.prototype.startsWith;
		let wholePrefixComparisons = 0;
		String.prototype.startsWith = function (this: string, searchString: string, position?: number): boolean {
			if (searchString === first) wholePrefixComparisons++;
			return originalStartsWith.call(this, searchString, position);
		};
		try {
			writeToolRenderer
				.renderCall({ path: "/tmp/inc.ts", content: `${first}\nlast` }, options, uiTheme)
				?.render(120);
		} finally {
			String.prototype.startsWith = originalStartsWith;
		}

		expect(wholePrefixComparisons).toBe(0);
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
