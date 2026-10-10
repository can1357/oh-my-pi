import { beforeAll, beforeEach, describe, expect, afterEach, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getKeybindings, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { AnnotationOverlay, type AnnotationOverlayCallbacks } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type {
	CodeReviewOverlayResult,
	ReviewDiffFile,
	TextReviewOverlayResult,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { sliceByColumn, visibleWidth } from "../src/utils";

const ENTER = "\r";
const TAB = "\t";
const DOWN = "\x1b[B";
const CANCEL = "\x1b";
const SHIFT_ENTER = "\x1b[13;2~";
const CTRL_U = "\x15";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CTRL_E = "\x05";
let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager;

function render(overlay: AnnotationOverlay, width = 90): string {
	return overlay.render(width).map(stripVTControlCharacters).join("\n");
}

interface PhysicalSourceRows {
	cells: string[];
	capacity: number;
}

function diffSourceRows(
	overlay: AnnotationOverlay,
	width: number,
	firstPrefix: string,
	nextPrefix: string,
): PhysicalSourceRows {
	const rows = overlay.render(width).map(stripVTControlCharacters);
	const first = rows.findIndex(row => row.includes(firstPrefix));
	const next = rows.findIndex((row, index) => index > first && row.includes(nextPrefix));
	expect(first).toBeGreaterThanOrEqual(0);
	expect(next).toBeGreaterThan(first);
	const sourceColumn = visibleWidth(rows[first]!.split(firstPrefix)[0]!) + visibleWidth(firstPrefix);
	// The source ends before the scroll indicator and the frame's right inset.
	const capacity = width - sourceColumn - 3;
	return {
		cells: rows.slice(first, next).map(row => sliceByColumn(row, sourceColumn, capacity, true)),
		capacity,
	};
}

function textSourceRows(overlay: AnnotationOverlay, width: number, endMarker: string): PhysicalSourceRows {
	const rows = overlay.render(width).map(stripVTControlCharacters);
	const next = rows.findIndex(row => row.includes(endMarker));
	expect(next).toBeGreaterThan(2);
	const sourceColumn = visibleWidth(rows[next]!.split(endMarker)[0]!);
	const capacity = width - sourceColumn - 3;
	return {
		cells: rows.slice(2, next).map(row => sliceByColumn(row, sourceColumn, capacity, true)),
		capacity,
	};
}

function expectLiteralRows(actual: PhysicalSourceRows, expected: readonly string[]): void {
	expect(actual.cells).toEqual(expected.map(row => row + " ".repeat(actual.capacity - visibleWidth(row))));
}

function expectAsciiSource(actual: PhysicalSourceRows, source: string): void {
	const expected: string[] = [];
	for (let offset = 0; offset < source.length; offset += actual.capacity) {
		expected.push(source.slice(offset, offset + actual.capacity));
	}
	expectLiteralRows(actual, expected.length ? expected : [""]);
}

type DiffOverlayOptions = Omit<AnnotationOverlayCallbacks, "onComplete"> & {
	onComplete?: (result: CodeReviewOverlayResult | undefined) => void;
	rows?: number;
};

function makeDiffOverlay(files: readonly ReviewDiffFile[], options: DiffOverlayOptions = {}): AnnotationOverlay {
	const { onComplete = () => {}, rows = 40, ...callbacks } = options;
	const overlay = new AnnotationOverlay(
		makeTui(rows),
		darkTheme!,
		getKeybindings() as KeybindingsManager,
		files,
		"Reviewing changes",
		{ ...callbacks, onComplete },
	);
	overlay.focused = true;
	return overlay;
}

function makeTextOverlay(
	source: TextReviewSource,
	onComplete: (result: TextReviewOverlayResult | undefined) => void = () => {},
	rows = 40,
): AnnotationOverlay {
	const overlay = new AnnotationOverlay(makeTui(rows), darkTheme!, getKeybindings() as KeybindingsManager, source, {
		onComplete,
	});
	overlay.focused = true;
	return overlay;
}

function makeTui(rows = 40): TUI {
	return {
		terminal: { rows },
		requestRender() {},
		stop() {},
		start() {},
	} as unknown as TUI;
}

function diffFile(path: string, hunkHeader: string, rows: ReviewDiffFile["rows"]): ReviewDiffFile {
	return {
		path,
		oldPath: path,
		newPath: path,
		occurrence: 1,
		rawDiff: [`diff --git a/${path} b/${path}`, hunkHeader, ...rows.map(row => row.raw)].join("\n"),
		rows: [{ kind: "hunk", raw: hunkHeader, hunkHeader }, ...rows],
		linesAdded: rows.filter(row => row.kind === "added").length,
		linesRemoved: rows.filter(row => row.kind === "removed").length,
		isBinary: false,
	};
}

const ONE_LINE_HUNK = "@@ -1 +1 @@";
const oneLineFiles = [
	diffFile("src/value.ts", ONE_LINE_HUNK, [
		{ kind: "removed", raw: "-old", content: "old", oldLine: 1, hunkHeader: ONE_LINE_HUNK },
		{ kind: "added", raw: "+new", content: "new", newLine: 1, hunkHeader: ONE_LINE_HUNK },
	]),
];

describe("AnnotationOverlay", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
	});
	beforeEach(() => {
		if (!darkTheme) throw new Error("dark theme unavailable");
		setThemeInstance(darkTheme);
		previousKeybindings = getKeybindings() as KeybindingsManager;
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "escape",
				"app.editor.external": "ctrl+e",
			}),
		);
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	it("anchors a line note to the frozen source row and deletes it on an empty edit", () => {
		const hunkHeader = "@@ -12,2 +12,2 @@";
		const files = [
			diffFile("src/long.ts", hunkHeader, [
				{ kind: "context", raw: " context", content: "context", oldLine: 12, newLine: 12, hunkHeader },
				{ kind: "removed", raw: "-removed", content: "removed", oldLine: 13, hunkHeader },
				{ kind: "added", raw: "+added", content: "added", newLine: 13, hunkHeader },
			]),
		];
		const overlay = makeDiffOverlay(files);

		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput(DOWN);
		overlay.handleInput("a");
		overlay.handleInput("keep this exact row");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([
			expect.objectContaining({
				scope: "line",
				path: "src/long.ts",
				oldLine: 13,
				rawLine: "-removed",
				note: "keep this exact row",
			}),
		]);
		const annotation = overlay.getAnnotations()[0];
		expect(annotation?.scope).toBe("line");
		if (annotation?.scope === "line") expect(annotation.newLine).toBeUndefined();

		overlay.handleInput("e");
		overlay.handleInput("\x15");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([]);
	});

	it("preserves a saved note when editing is cancelled", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("saved");
		overlay.handleInput(ENTER);
		overlay.handleInput("e");
		overlay.handleInput("\x15");
		overlay.handleInput("discarded");
		overlay.handleInput(CANCEL);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["saved"]);
	});

	it("undoes the latest change instead of dropping the newest note", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("first");
		overlay.handleInput(ENTER);
		overlay.handleInput(DOWN);
		overlay.handleInput("a");
		overlay.handleInput("second");
		overlay.handleInput(ENTER);
		overlay.handleInput("\x1b[A");
		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput("edited");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["edited", "second"]);

		overlay.handleInput("u");
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first", "second"]);

		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["second"]);
		overlay.handleInput("u");
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first", "second"]);
	});

	it("preserves exact text quotes while annotating a selected line", () => {
		const source: TextReviewSource = {
			id: "reply",
			kind: "message",
			label: "Latest assistant reply",
			text: "first\r\n  exact source line  ",
		};
		const completed: Array<TextReviewOverlayResult | undefined> = [];
		const overlay = makeTextOverlay(source, result => completed.push(result));
		render(overlay);
		overlay.handleInput(DOWN);
		overlay.handleInput("a");
		overlay.handleInput("note");
		overlay.handleInput(ENTER);
		expect(overlay.getTextAnnotations()).toEqual([
			{ scope: "line", line: 2, quote: "  exact source line  ", note: "note" },
		]);
		overlay.handleInput(TAB);
		overlay.handleInput(ENTER);
		expect(completed).toEqual([{ action: "paste", annotations: overlay.getTextAnnotations() }]);
	});

	it("chooses duplicate line notes and deletes only the selected note", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("first");
		overlay.handleInput(ENTER);
		overlay.handleInput("a");
		overlay.handleInput("second");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first", "second"]);

		overlay.handleInput("e");
		expect(render(overlay)).toContain("Edit annotation");
		overlay.handleInput(DOWN);
		overlay.handleInput(ENTER);
		overlay.handleInput(CTRL_U);
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first"]);
	});
	it("keeps the selected annotation visible in a short chooser window", () => {
		const overlay = makeDiffOverlay(oneLineFiles, { rows: 12 });
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("first");
		overlay.handleInput(ENTER);
		overlay.handleInput("a");
		overlay.handleInput("second");
		overlay.handleInput(ENTER);

		overlay.handleInput("e");
		const firstWindow = render(overlay).split("\n");
		expect(firstWindow.length).toBeLessThanOrEqual(12);
		expect(firstWindow.join("\n")).toContain("first");
		overlay.handleInput(DOWN);
		const secondWindow = render(overlay).split("\n");
		expect(secondWindow.length).toBeLessThanOrEqual(12);
		expect(secondWindow.join("\n")).toContain("second");
	});

	it("supports multiline notes and treats a blank new draft as a no-op", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([]);

		overlay.handleInput("a");
		overlay.handleInput("first");
		overlay.handleInput(SHIFT_ENTER);
		overlay.handleInput("second");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([expect.objectContaining({ note: "first\nsecond" })]);
	});

	it("deletes an existing text note on blank submit and preserves it on Escape", () => {
		const source: TextReviewSource = {
			id: "reply",
			kind: "message",
			label: "Reply",
			text: "first line\nsecond line",
		};
		const overlay = makeTextOverlay(source);
		render(overlay);
		overlay.handleInput("A");
		overlay.handleInput("whole note");
		overlay.handleInput(ENTER);
		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput("discarded");
		overlay.handleInput(CANCEL);
		expect(overlay.getTextAnnotations()).toEqual([{ scope: "text", note: "whole note" }]);

		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput(ENTER);
		expect(overlay.getTextAnnotations()).toEqual([]);
	});

	it("commits external-editor drafts", async () => {
		const observedDrafts: string[] = [];
		const overlay = new AnnotationOverlay(
			makeTui(),
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			oneLineFiles,
			"PR #1",
			{
				onAnnotationExternalEditor: (draft, commit) => {
					observedDrafts.push(draft);
					commit("external\neditor");
				},
				onComplete: () => {},
			},
		);
		overlay.focused = true;
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("draft");
		overlay.handleInput(CTRL_E);
		await Bun.sleep(0);
		expect(observedDrafts).toEqual(["draft"]);
		expect(render(overlay)).toContain("external");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([expect.objectContaining({ note: "external\neditor" })]);
	});

	it("returns undefined on cancel without a review result", () => {
		const completed: Array<CodeReviewOverlayResult | undefined> = [];
		const overlay = makeDiffOverlay(oneLineFiles, {
			onComplete: result => completed.push(result),
		});
		overlay.handleInput(CANCEL);
		expect(completed).toEqual([undefined]);
	});
	it("selects the last and first rows of a diff that fits without scrolling", () => {
		for (const [toEnd, toStart] of [
			["G", "g"],
			[PAGE_DOWN, PAGE_UP],
		]) {
			const overlay = makeDiffOverlay(oneLineFiles);
			render(overlay, 100);
			overlay.handleInput(TAB);
			overlay.handleInput(toEnd);
			render(overlay, 100);
			overlay.handleInput("a");
			overlay.handleInput("end");
			overlay.handleInput(ENTER);
			overlay.handleInput(toStart);
			render(overlay, 100);
			overlay.handleInput("a");
			overlay.handleInput("start");
			overlay.handleInput(ENTER);
			expect(overlay.getAnnotations()).toEqual([
				expect.objectContaining({ rawLine: "+new", note: "end" }),
				expect.objectContaining({ rawLine: "-old", note: "start" }),
			]);
		}
	});
	describe("diff row wrapping", () => {
		it("keeps forty indentation cells and a long identifier on the numbered row at 60 and 80 columns", () => {
			const content = " ".repeat(40) + "LONG_IDENTIFIER_".repeat(8);
			const overlay = makeDiffOverlay(
				[
					diffFile("src/indent.ts", ONE_LINE_HUNK, [
						{ kind: "added", raw: `+${content}`, content, newLine: 17, hunkHeader: ONE_LINE_HUNK },
						{ kind: "added", raw: "+END", content: "END", newLine: 18, hunkHeader: ONE_LINE_HUNK },
					]),
				],
				{ rows: 40 },
			);
			for (const width of [60, 80, 60]) {
				const physical = diffSourceRows(overlay, width, "+  17 ", "+  18 ");
				expectAsciiSource(physical, content);
				expect(physical.cells[0]).toStartWith(" ".repeat(40) + "LO");
			}
		});

		it("preserves expanded tabs and internal and trailing spaces in all diff row kinds", () => {
			const trailing = " ".repeat(20);
			const content = "\t\t" + " ".repeat(34) + "identifier".repeat(8) + "\t  tail" + trailing;
			const display = " ".repeat(40) + "identifier".repeat(8) + "     tail" + trailing;
			for (const kind of ["added", "removed", "context"] as const) {
				const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
				const overlay = makeDiffOverlay(
					[
						diffFile("src/spaces.ts", ONE_LINE_HUNK, [
							{ kind, raw: `${marker}${content}`, content, oldLine: 17, newLine: 17, hunkHeader: ONE_LINE_HUNK },
							{ kind: "added", raw: "+END", content: "END", newLine: 18, hunkHeader: ONE_LINE_HUNK },
						]),
					],
					{ rows: 40 },
				);
				expectAsciiSource(diffSourceRows(overlay, 60, `${marker}  17 `, "+  18 "), display);
			}
		});

		it("moves wide and ZWJ graphemes intact across cell boundaries without losing combining marks", () => {
			const probe = makeDiffOverlay(
				[
					diffFile("src/graphemes.ts", ONE_LINE_HUNK, [
						{ kind: "added", raw: "+probe", content: "probe", newLine: 17, hunkHeader: ONE_LINE_HUNK },
						{ kind: "added", raw: "+END", content: "END", newLine: 18, hunkHeader: ONE_LINE_HUNK },
					]),
				],
				{ rows: 40 },
			);
			const diffCapacity = diffSourceRows(probe, 60, "+  17 ", "+  18 ").capacity;
			const textProbe = makeTextOverlay(
				{ id: "probe", kind: "prompt", label: "Source", text: "probe\nTEXT_END" },
				undefined,
				40,
			);
			const textCapacity = textSourceRows(textProbe, 60, "TEXT_END").capacity;
			for (const mode of ["diff", "text"] as const) {
				const capacity = mode === "diff" ? diffCapacity : textCapacity;
				const first = "A".repeat(capacity - 1);
				const second = "界" + "e\u0301".repeat(capacity - 3);
				const last = "👩‍💻 Z";
				const content = first + second + last;
				const overlay =
					mode === "diff"
						? makeDiffOverlay(
								[
									diffFile("src/graphemes.ts", ONE_LINE_HUNK, [
										{ kind: "added", raw: `+${content}`, content, newLine: 17, hunkHeader: ONE_LINE_HUNK },
										{ kind: "added", raw: "+END", content: "END", newLine: 18, hunkHeader: ONE_LINE_HUNK },
									]),
								],
								{ rows: 40 },
							)
						: makeTextOverlay(
								{ id: "graphemes", kind: "prompt", label: "Source", text: `${content}\nTEXT_END` },
								undefined,
								40,
							);
				const actual =
					mode === "diff"
						? diffSourceRows(overlay, 60, "+  17 ", "+  18 ")
						: textSourceRows(overlay, 60, "TEXT_END");
				expectLiteralRows(actual, [first, second, last]);
			}
		});

		it("retains whitespace-only hard rows and exactly one row for an empty logical line", () => {
			const spaces = " ".repeat(100);
			const diff = makeDiffOverlay(
				[
					diffFile("src/blank.ts", ONE_LINE_HUNK, [
						{ kind: "added", raw: `+${spaces}`, content: spaces, newLine: 17, hunkHeader: ONE_LINE_HUNK },
						{ kind: "added", raw: "+", content: "", newLine: 18, hunkHeader: ONE_LINE_HUNK },
						{ kind: "added", raw: "+END", content: "END", newLine: 19, hunkHeader: ONE_LINE_HUNK },
					]),
				],
				{ rows: 40 },
			);
			expectAsciiSource(diffSourceRows(diff, 60, "+  17 ", "+  18 "), spaces);
			expectLiteralRows(diffSourceRows(diff, 60, "+  18 ", "+  19 "), [""]);
			const text = makeTextOverlay(
				{ id: "blank", kind: "prompt", label: "Source", text: `${spaces}\n\nTEXT_END` },
				undefined,
				40,
			);
			const actual = textSourceRows(text, 60, "TEXT_END");
			expectLiteralRows(actual, [spaces.slice(0, actual.capacity), spaces.slice(actual.capacity), ""]);
		});

		it("shows text-source whitespace literally while preserving the original quoted line", () => {
			const trailing = " ".repeat(60);
			const quote = "\t\t" + " ".repeat(34) + "longIdentifier".repeat(8) + "\t  tail" + trailing;
			const display = " ".repeat(40) + "longIdentifier".repeat(8) + "     tail" + trailing;
			const overlay = makeTextOverlay(
				{ id: "literal", kind: "prompt", label: "Source", text: `${quote}\nTEXT_END` },
				undefined,
				40,
			);
			for (const width of [60, 80]) expectAsciiSource(textSourceRows(overlay, width, "TEXT_END"), display);
			overlay.handleInput("a");
			overlay.handleInput("literal-note");
			overlay.handleInput(ENTER);
			expect(overlay.getTextAnnotations()).toEqual([{ scope: "line", line: 1, quote, note: "literal-note" }]);
		});

		it("anchors a note to its logical source row after a wrapped row and resize", () => {
			const firstContent = "\t" + " ".repeat(37) + "FIRST_IDENTIFIER_".repeat(8) + "界e\u0301👩‍💻";
			const targetContent = "\tconst target = TARGET_LOGICAL_ROW;  ";
			const overlay = makeDiffOverlay(
				[
					diffFile("src/anchor.ts", ONE_LINE_HUNK, [
						{
							kind: "added",
							raw: `+${firstContent}`,
							content: firstContent,
							newLine: 10,
							hunkHeader: ONE_LINE_HUNK,
						},
						{
							kind: "added",
							raw: `+${targetContent}`,
							content: targetContent,
							newLine: 11,
							hunkHeader: ONE_LINE_HUNK,
						},
					]),
				],
				{ rows: 40 },
			);
			render(overlay, 60);
			render(overlay, 80);
			render(overlay, 60);
			overlay.handleInput(DOWN);
			render(overlay, 60);
			overlay.handleInput("a");
			overlay.handleInput("logical-row-note");
			overlay.handleInput(ENTER);

			expect(overlay.getAnnotations()).toEqual([
				expect.objectContaining({
					scope: "line",
					newLine: 11,
					hunkHeader: ONE_LINE_HUNK,
					rawLine: `+${targetContent}`,
					note: "logical-row-note",
				}),
			]);
			const output = render(overlay, 60);
			expect(output.indexOf("logical-row-note")).toBeGreaterThan(output.indexOf("+  10 "));
			expect(output.indexOf("logical-row-note")).toBeLessThan(output.indexOf("+  11 "));
		});

		it("pages through one oversized wrapped source row and keeps its raw annotation anchor", () => {
			const rawLine = `+START_MARKER ${"segment ".repeat(100)}TAIL_MARKER`;
			const overlay = makeDiffOverlay(
				[
					diffFile("src/long.ts", ONE_LINE_HUNK, [
						{ kind: "added", raw: rawLine, content: rawLine.slice(1), newLine: 27, hunkHeader: ONE_LINE_HUNK },
					]),
				],
				{ rows: 14 },
			);
			render(overlay, 72);
			overlay.handleInput(TAB);
			expect(render(overlay, 72)).toContain("START_MARKER");
			expect(render(overlay, 72)).not.toContain("TAIL_MARKER");

			for (let page = 0; page < 8; page++) overlay.handleInput(PAGE_DOWN);
			expect(render(overlay, 72)).toContain("TAIL_MARKER");
			overlay.handleInput("g");
			expect(render(overlay, 72)).toContain("START_MARKER");
			for (let page = 0; page < 8; page++) overlay.handleInput(PAGE_DOWN);
			expect(render(overlay, 72)).toContain("TAIL_MARKER");
			for (let page = 0; page < 8; page++) overlay.handleInput(PAGE_UP);
			expect(render(overlay, 72)).toContain("START_MARKER");
			overlay.handleInput("G");
			expect(render(overlay, 72)).toContain("TAIL_MARKER");

			overlay.handleInput("a");
			overlay.handleInput("note");
			overlay.handleInput(ENTER);
			expect(overlay.getAnnotations()).toEqual([
				expect.objectContaining({
					scope: "line",
					path: "src/long.ts",
					newLine: 27,
					rawLine,
					note: "note",
				}),
			]);
		});

		it("keeps the end-selected diff row anchored while the annotation editor shrinks the viewport", () => {
			const firstContent = `FIRST_WRAP_HEAD ${"segment ".repeat(100)}`;
			const lastRaw = "+FINAL_LOGICAL_ROW";
			const overlay = makeDiffOverlay(
				[
					diffFile("src/last.ts", ONE_LINE_HUNK, [
						{
							kind: "added",
							raw: `+${firstContent}`,
							content: firstContent,
							newLine: 1,
							hunkHeader: ONE_LINE_HUNK,
						},
						{
							kind: "added",
							raw: lastRaw,
							content: "FINAL_LOGICAL_ROW",
							newLine: 2,
							hunkHeader: ONE_LINE_HUNK,
						},
					]),
				],
				{ rows: 14 },
			);
			render(overlay, 72);
			overlay.handleInput(TAB);
			overlay.handleInput("G");
			expect(render(overlay, 72)).toContain("FINAL_LOGICAL_ROW");
			overlay.handleInput("a");
			render(overlay, 72);
			overlay.handleInput("anchor-check");
			overlay.handleInput(ENTER);
			expect(overlay.getAnnotations()).toEqual([
				expect.objectContaining({
					scope: "line",
					path: "src/last.ts",
					newLine: 2,
					rawLine: lastRaw,
					note: "anchor-check",
				}),
			]);
		});

		it("keeps the highlighted source row and annotation anchor aligned after viewport reflow", () => {
			const firstContent = `FIRST_ROW_MARKER ${"wrap ".repeat(16)}`;
			const firstRaw = `+${firstContent}`;
			const lastRaw = "+LAST_ROW_MARKER";
			const overlay = makeDiffOverlay(
				[
					diffFile("src/reflow.ts", ONE_LINE_HUNK, [
						{
							kind: "added",
							raw: firstRaw,
							content: firstContent,
							newLine: 1,
							hunkHeader: ONE_LINE_HUNK,
						},
						{
							kind: "added",
							raw: lastRaw,
							content: "LAST_ROW_MARKER",
							newLine: 2,
							hunkHeader: ONE_LINE_HUNK,
						},
					]),
				],
				{ rows: 14 },
			);
			render(overlay, 42);
			overlay.handleInput("G");
			render(overlay, 42);

			const wide = render(overlay, 180);
			const selectedRow = wide
				.split("\n")
				.find(
					line =>
						line.includes(darkTheme!.nav.cursor) &&
						(line.includes("FIRST_ROW_MARKER") || line.includes("LAST_ROW_MARKER")),
				);
			expect(selectedRow).toBeDefined();
			const expectedRaw = selectedRow!.includes("FIRST_ROW_MARKER") ? firstRaw : lastRaw;
			overlay.handleInput("a");
			overlay.handleInput("resize-anchor");
			overlay.handleInput(ENTER);
			expect(overlay.getAnnotations()).toEqual([
				expect.objectContaining({ rawLine: expectedRaw, note: "resize-anchor" }),
			]);
		});
	});
});
