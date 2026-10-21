import { afterEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { PREVIEW_LIMITS, previewWindowRows } from "@oh-my-pi/pi-tui/render/render-utils";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import type { HighlightStream } from "@oh-my-pi/pi-natives";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const hasLine = (lines: readonly string[], n: number): boolean =>
	new RegExp(`\\bline ${n}\\b`).test(stripAnsi(lines.join("\n")));

/** Rows of the framed card: the preview rows plus the block's own marker/streaming rows. */
const cardRows = (lines: readonly string[]): number => lines.filter(line => stripAnsi(line).includes("│")).length;

/**
 * Viewport the suite renders at. `previewWindowRows()` is `rows - 20` with a
 * floor of 6, so 32 rows pins it at the 12 the collapsed streaming window caps
 * at (`PREVIEW_LIMITS.EXPANDED_LINES`).
 */
const VIEWPORT_ROWS = 32;

/**
 * The runner's own `process.stdout.rows` descriptor. Bun exposes `rows` as an
 * own configurable property on a TTY, so pinning the viewport replaces a real
 * descriptor and the teardown has to put that exact descriptor back — deleting
 * it outright would strip the runner's terminal height from every later test
 * file in the same process.
 */
const runnerRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

/** The descriptor the current pin replaced, put back when the pin is undone. */
let pinnedRowsDescriptor: PropertyDescriptor | undefined;
let viewportPinned = false;

/** `previewWindowRows()` reads `process.stdout.rows`; pin it so the budget never follows the test runner's TTY. */
function pinViewportRows(rows: number): void {
	if (!viewportPinned) {
		pinnedRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		viewportPinned = true;
	}
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
}

/** Put the descriptor the pin replaced back. */
function restoreViewportRows(): void {
	if (!viewportPinned) return;
	viewportPinned = false;
	if (pinnedRowsDescriptor) Object.defineProperty(process.stdout, "rows", pinnedRowsDescriptor);
	else Reflect.deleteProperty(process.stdout, "rows");
	pinnedRowsDescriptor = undefined;
}

/** The collapsed streaming window budget at the pinned viewport, as production computes it. */
function streamingBudget(): number {
	return Math.min(PREVIEW_LIMITS.EXPANDED_LINES, previewWindowRows());
}

/**
 * Reference algorithm for the collapsed streaming window: the last `budget`
 * complete lines, plus the partial trailing line when the payload does not end
 * in a newline (it is budgeted in, so its arrival cannot change the row count).
 */
function referenceWindow(content: string): { total: number; start: number; visible: string[] } {
	const normalized = content.replace(/\r/g, "");
	const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
	const total = lines.length;
	const start = Math.max(0, total - streamingBudget());
	return { total, start, visible: lines.slice(start) };
}

describe("write streaming preview incremental line tracking", () => {
	let initialized = false;

	afterEach(() => {
		vi.restoreAllMocks();
		restoreViewportRows();
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

	/** Render the collapsed streaming card at the pinned viewport. */
	async function renderCollapsed(
		content: string,
		options: { expanded: boolean; isPartial: boolean; spinnerFrame: number },
		rows: number = VIEWPORT_ROWS,
	) {
		pinViewportRows(rows);
		const uiTheme = await getUiTheme();
		const component = writeToolRenderer.renderCall({ path: "/tmp/inc.ts", content }, options, uiTheme);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");
		return component.render(120);
	}

	it("renders agent messages and their receipt as a message card", async () => {
		const uiTheme = await getUiTheme();
		const args = { path: "agent://all", content: "Please review the change" };
		const pending = writeToolRenderer.renderCall(args, { expanded: true, isPartial: true }, uiTheme);
		expect(pending?.render(120).join("\n")).toContain("Please review the change");
		const result = writeToolRenderer.renderResult(
			{ content: [{ type: "text", text: "Broadcast delivered to 2 of 2 peer(s)." }] },
			{ expanded: true, isPartial: false },
			uiTheme,
			args,
		);
		const text = Bun.stripANSI(result.render(120).join("\n"));
		expect(text).toMatch(/IRC \S+ all broadcast/);
		expect(text).toContain("Please review the change");
		expect(text).toContain("Broadcast delivered to 2 of 2 peer(s).");
	});

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

	it("holds the collapsed height steady across every partial line of a fast stream", async () => {
		// The regression (#16033): the collapsed block grew one row per token
		// chunk while the payload outran the window, so each line shifted up and
		// down as the block resized. Budgeting the partial tail in keeps the row
		// count constant for the whole stream.
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const allLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		pinViewportRows(VIEWPORT_ROWS);
		const budget = streamingBudget();

		let expected = -1;
		// The first line that overflows the window plus two later cumulative
		// appends: every count above the budget takes the same partial-tail
		// branch, so further rows repeat the same assertion without covering a
		// distinct contract.
		for (const count of [budget + 1, budget + 2, allLines.length]) {
			// Every payload ends mid-line, as a token stream does while the final
			// newline has not arrived.
			const head = allLines.slice(0, count - 1).join("\n");
			const content = `${head}\n${allLines[count - 1]!.slice(0, 4)}`;
			const rendered = await renderCollapsed(content, options);
			const { total, start, visible } = referenceWindow(content);
			expect(total).toBe(count);
			expect(visible).toHaveLength(budget);
			expect(stripAnsi(rendered.join("\n"))).toContain(`… (${start} earlier line${start === 1 ? "" : "s"})`);
			// Card rows only: the window, the "earlier lines" marker, and the
			// trailing "(streaming)" line. The frame borders carry no gutter glyph.
			const rows = cardRows(rendered);
			if (expected < 0) expected = rows;
			expect(rows).toBe(expected);
		}
		expect(expected).toBe(budget + 2);
	});

	it("holds the collapsed height steady when a line's terminating newline lands at the window edge", async () => {
		// The regression (#16033): the unfinished trailing line was rendered as
		// an extra row, so landing its newline grew the block by one row and
		// moved every row on screen. The partial line is budgeted into the
		// window instead, so the newline must not change the height.
		//
		// The three cases are the distinct transitions around the tail window's
		// edge — the last line that still fits, the line that fills it, and the
		// first line that overflows it — and they are ONE cumulative stream:
		// each case's payload continues the previous one's, so the incremental
		// render state is never reset and the height is measured across real
		// streaming transitions instead of across independent renders.
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		pinViewportRows(VIEWPORT_ROWS);
		const budget = streamingBudget();

		for (const count of [budget - 1, budget, budget + 1]) {
			// The stream after `count` lines, the last of them not yet terminated.
			const stream = Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
			const before = await renderCollapsed(stream, options);
			const after = await renderCollapsed(`${stream}\n`, options);
			// Landing the newline must not change the card's height.
			expect(cardRows(after)).toBe(cardRows(before));
			// The window only starts hiding rows once the stream outgrows it.
			expect(stripAnsi(before.join("\n")).includes("earlier line")).toBe(count > budget);
			expect(stripAnsi(after.join("\n")).includes("earlier line")).toBe(count > budget);
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

	it("re-slices the collapsed window when the viewport rows change", async () => {
		// A card's rendered body is memoized. A row-only terminal resize leaves
		// theme, expansion state, language and content untouched, so the memo
		// has to be keyed on the viewport budget too — otherwise the card keeps
		// the old window and the collapsed preview no longer matches the
		// terminal it is drawn in.
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const content = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		pinViewportRows(VIEWPORT_ROWS);
		const component = writeToolRenderer.renderCall({ path: "/tmp/resize.ts", content }, options, uiTheme);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");
		const tall = cardRows(component.render(120));
		// 26 rows leaves a six-row tail window, half the pinned viewport's.
		pinViewportRows(26);
		const short = cardRows(component.render(120));
		expect(short).toBeLessThan(tall);
	});

	it("repaints the first result once the pending preview is tail-anchored", async () => {
		// The pending card is tail-anchored (`… (N earlier lines)`) once its
		// content outgrows the renderer's tail budget. Only then does the first
		// result re-anchor the frame to the head of the file, and only then does
		// the tail already committed to scrollback need a full repaint.
		//
		// The boundary is exact: a write of exactly `budget` lines still fits
		// the window and renders top-anchored, so it must not ask for the
		// scrollback-wiping repaint. A terminating newline closes the last line
		// instead of opening an empty one — the preview drops that row, so the
		// threshold must not count it either.
		const options = { expanded: false, isPartial: false };
		// 26 rows leaves a six-row window: the budget is below the shared
		// preview limit, where the two counts used to disagree.
		pinViewportRows(26);
		const budget = streamingBudget();
		const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
		const repaints = (content: string) =>
			writeToolRenderer.forceFirstResultViewportRepaint({ path: "/tmp/repaint.ts", content }, options);
		expect(repaints(lines(budget))).toBe(false);
		expect(repaints(`${lines(budget)}\n`)).toBe(false);
		expect(repaints(lines(budget + 1))).toBe(true);
		expect(repaints(`${lines(budget + 1)}\n`)).toBe(true);

		// The render agrees with the threshold on both sides of the boundary.
		const streamOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const atBudget = stripAnsi((await renderCollapsed(`${lines(budget)}\n`, streamOptions, 26)).join("\n"));
		expect(atBudget).not.toContain("earlier line");
		const overBudget = stripAnsi((await renderCollapsed(`${lines(budget + 1)}\n`, streamOptions, 26)).join("\n"));
		expect(overBudget).toContain("… (1 earlier line)");
	});

	it("treats a carriage-return tail as the terminator it follows", () => {
		// The preview normalizes carriage returns out before it counts lines, so
		// a newline that is only followed by "\r" still terminates the last line:
		// the payload draws `budget` top-anchored rows, and the threshold has to
		// agree with the render it guards instead of asking for a repaint no
		// tail window needs.
		const options = { expanded: false, isPartial: false };
		pinViewportRows(26);
		const budget = streamingBudget();
		const lines = Array.from({ length: budget }, (_, i) => `line ${i + 1}`).join("\n");
		const repaints = (content: string) =>
			writeToolRenderer.forceFirstResultViewportRepaint({ path: "/tmp/repaint.ts", content }, options);
		expect(repaints(`${lines}\n\r`)).toBe(false);
		expect(repaints(`${lines}\n\r\r`)).toBe(false);
		// One line past the window is a tail window again.
		expect(repaints(`${lines}\nline ${budget + 1}\n\r`)).toBe(true);
	});

	it("keeps the gutter width when the last terminating newline lands", async () => {
		// The dropped terminator opens no row of its own, so it must not count
		// towards the line total either: at the 1000-line crossing it would
		// widen the gutter a token early and wrap the visible rows — changing
		// the card height on the very newline this branch stabilizes.
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		pinViewportRows(VIEWPORT_ROWS);
		// 999 rendered lines keep a three-digit gutter; the terminating newline
		// must not push the count to four.
		const content = Array.from({ length: 999 }, (_, i) => `line ${i + 1}`).join("\n");
		const partial = stripAnsi((await renderCollapsed(content, options)).join("\n"));
		const terminated = stripAnsi((await renderCollapsed(`${content}\n`, options)).join("\n"));
		expect(terminated).toBe(partial);
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
			pinViewportRows(VIEWPORT_ROWS);
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
			pinViewportRows(VIEWPORT_ROWS);
			const component = writeToolRenderer.renderCall({ path: "/tmp/chunks.ts", content: acc }, options, uiTheme);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			component.render(120);
		}
		expect(pushes).toEqual(["const a = 1;\n", "const b = 2;\n"]);
		pinViewportRows(VIEWPORT_ROWS);
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
		// The window is the last `budget` logical lines; the CR is normalized
		// out of the rendered tail only.
		const { start } = referenceWindow(content);
		expect(text).toContain(`… (${start} earlier line${start === 1 ? "" : "s"})`);
		expect(hasLine(rendered, start)).toBe(false);
		expect(hasLine(rendered, start + 1)).toBe(true);
		expect(hasLine(rendered, 20)).toBe(true);
	});

	it("drops the terminating newline's empty row but keeps the window full", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const content = `${Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const rendered = await renderCollapsed(content, options);
		const { total, start } = referenceWindow(content);
		expect(total).toBe(13);
		expect(start).toBe(1);
		const text = stripAnsi(rendered.join("\n"));
		expect(text).toContain("… (1 earlier line)");
		expect(hasLine(rendered, 13)).toBe(true);
		expect(hasLine(rendered, 1)).toBe(false);
		// The terminating newline contributes no row of its own: the window
		// still holds a full budget of complete lines.
		expect(cardRows(rendered)).toBe(streamingBudget() + 2);
	});

	it("renders carriage-return-only content like the previous normalized empty payload", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const empty = await renderCollapsed("", options);
		const carriageReturns = await renderCollapsed("\r\r", options);
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

	it("restores the viewport descriptor the runner provided", () => {
		// A TTY runner exposes `process.stdout.rows` as an own configurable
		// property. The pin replaces that descriptor, so the teardown has to put
		// the runner's own descriptor back: deleting it outright strips the
		// runner's real terminal height, and every later test file in the same
		// process then falls back to the 30-row assumption.
		const runner = { value: 42, writable: true, enumerable: true, configurable: true };
		Object.defineProperty(process.stdout, "rows", runner);
		try {
			pinViewportRows(7);
			expect(process.stdout.rows).toBe(7);
			restoreViewportRows();
			expect(Object.getOwnPropertyDescriptor(process.stdout, "rows")).toEqual(runner);
		} finally {
			// Leave the runner's own descriptor in place for the rest of the suite.
			if (runnerRowsDescriptor) Object.defineProperty(process.stdout, "rows", runnerRowsDescriptor);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});
});
