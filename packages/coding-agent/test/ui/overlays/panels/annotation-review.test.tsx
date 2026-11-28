/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, it } from "bun:test";
import type { UiEvent } from "@oh-my-pi/pi-tui";
import { cellGrid, plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import type {
	ReviewDiffFile,
	TextReviewSource,
} from "../../../../src/extensibility/custom-commands/bundled/annotate/annotation-types";
import { AnnotationReview } from "../../../../src/ui/overlays/panels/annotation-review";
import {
	type AnnotationReviewInput,
	AnnotationReviewModel,
} from "../../../../src/ui/overlays/panels/annotation-review-model";
import { type Driver, panelSuite } from "./harness";

function diffFile(
	path: string,
	hunk: string,
	rows: ReviewDiffFile["rows"],
	extra: Partial<ReviewDiffFile> = {},
): ReviewDiffFile {
	return {
		path,
		oldPath: path,
		newPath: path,
		occurrence: 1,
		rawDiff: [`diff --git a/${path} b/${path}`, hunk, ...rows.map(r => r.raw)].join("\n"),
		rows: [{ kind: "hunk", raw: `${hunk} function body()`, hunkHeader: hunk }, ...rows],
		linesAdded: rows.filter(r => r.kind === "added").length,
		linesRemoved: rows.filter(r => r.kind === "removed").length,
		isBinary: false,
		...extra,
	};
}
const H = "@@ -1,9 +1,10 @@";
const MANY = Array.from({ length: 30 }, (_, i) => ({
	kind: (i % 5 === 0 ? "removed" : i % 3 === 0 ? "added" : "context") as "context",
	raw: ` line ${i}`,
	content: `${"\t".repeat(i % 2)}const value${i} = compute(${i}); // ${"x".repeat(i * 4)} 中文`,
	oldLine: i + 1,
	newLine: i + 1,
	hunkHeader: H,
}));
const FILES: ReviewDiffFile[] = [
	diffFile("src/value.ts", H, MANY),
	diffFile(
		`packages/very/long/directory/structure/that/keeps/going/deeper/and/deeper/file-name-${"z".repeat(30)}.ts`,
		H,
		MANY.slice(0, 4),
	),
	{
		...diffFile("assets/logo.png", H, []),
		isBinary: true,
		rows: [],
		rawDiff: "diff --git a/x b/x\nnew file mode 100644\nBinary files differ",
	},
	{ ...diffFile("old/name.ts", H, []), rows: [], oldPath: "old/name.ts", newPath: "new/name.ts" },
	...Array.from({ length: 14 }, (_, i) =>
		diffFile(`src/gen/file${i}.ts`, H, MANY.slice(0, 2), { occurrence: i % 4 === 0 ? 2 : 1 }),
	),
];
const TEXT: TextReviewSource = {
	id: "t",
	kind: "message",
	label: "Reply\tto user",
	text: `one\ntwo\t tabs\n${"long ".repeat(40)}\n\nlast 中文`,
};
const ENTER = "\r";
const TAB = "\t";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const PGDN = "\x1b[6~";
const PGUP = "\x1b[5~";
const SHIFT_DOWN = "\x1b[1;2B";

function mountReview(input: AnnotationReviewInput, initialColumns: number) {
	const { theme } = corpusEnvironment("dark");
	const rows = 24;
	let columns = initialColumns;
	const model = new AnnotationReviewModel(input, { onComplete() {} }, { theme, size: () => ({ columns, rows }) });
	const terminal = createTestTerminal(() => ({ layer: <AnnotationReview model={model} /> }), {
		columns,
		rows,
		theme: theme(),
	});
	terminal.focus(terminal.surface.layer()[0]!);
	return {
		model,
		terminal,
		theme: theme(),
		resize(width: number) {
			columns = width;
			terminal.resize(width, rows);
		},
		addNote(text: string) {
			terminal.press("a");
			terminal.paste(text);
			terminal.press("enter");
		},
	};
}

function foreground(rows: readonly string[], text: string): string | undefined {
	return cellFor(rows, text)?.cell.fg;
}

function cellFor(rows: readonly string[], text: string) {
	const grid = cellGrid(rows);
	for (const [rowIndex, row] of grid.entries()) {
		const index = row.findIndex(
			(_, i) =>
				row
					.slice(i, i + text.length)
					.map(cell => cell.ch)
					.join("") === text,
		);
		if (index !== -1) return { row, rowIndex, cell: row[index]! };
	}
	return undefined;
}

it("colors a wrapped code line and keeps its exact source quote after resize", () => {
	const quote = `\tconst wrappedValue = "${"wide ".repeat(20)}";`;
	const source = { id: "wrapped", label: "wrapped", text: `first\n${quote}\nlast` };
	const code = mountReview({ kind: "text", source: { ...source, kind: "code", language: "typescript" } }, 36);
	const prose = mountReview({ kind: "text", source: { ...source, kind: "message" } }, 36);
	try {
		expect(plainRows(code.terminal.rows()).filter(row => row.includes("wide wide")).length).toBeGreaterThan(1);
		const keyword = foreground([code.theme.fg("syntaxKeyword", "const")], "const");
		expect(foreground(code.terminal.rows(), "const")).toBe(keyword);
		const proseColor = foreground(prose.terminal.rows(), "const");
		expect(proseColor).toBeDefined();
		expect(proseColor).not.toBe(keyword);
		code.terminal.press("down");
		code.resize(100);
		code.addNote("text note");
		expect(code.model.getTextAnnotations()).toEqual([{ scope: "line", line: 2, quote, note: "text note" }]);
	} finally {
		prose.terminal.dispose();
		code.terminal.dispose();
	}
});

it("keeps syntax colors and diff tint on wrapped, selected patch lines and preserves anchors", () => {
	const path = "src/value.ts";
	const hunkHeader = "@@ -40,2 +40,2 @@";
	const removed = `/* old comment starts ${"removed wrap ".repeat(8)}removedWrapEnd */`;
	const added = `const newValue = makeValue("${"added wrap ".repeat(6)}addedWrapEnd");`;
	const file = diffFile(path, hunkHeader, [
		{ kind: "removed", raw: `-${removed}`, content: removed, oldLine: 40, hunkHeader },
		{ kind: "added", raw: `+${added}`, content: added, newLine: 40, hunkHeader },
		{
			kind: "context",
			raw: " const contextValue = 0;",
			content: "const contextValue = 0;",
			oldLine: 41,
			newLine: 41,
			hunkHeader,
		},
	]);
	const review = mountReview({ kind: "diff", files: [file], mode: "Reviewing changes" }, 76);
	try {
		const initialRows = review.terminal.rows();
		const oldStart = cellFor(initialRows, "old comment")!;
		const oldEnd = cellFor(initialRows, "removedWrapEnd")!;
		const addedStart = cellFor(initialRows, "const newValue")!;
		const addedEnd = cellFor(initialRows, "addedWrapEnd")!;
		const context = cellFor(initialRows, "contextValue")!;
		const selectedBg = cellGrid([review.theme.bg("selectedBg", "x")])[0]![0]!.bg;

		const keyword = foreground([review.theme.fg("syntaxKeyword", "const")], "const")!;
		const comment = foreground([review.theme.fg("syntaxComment", "x")], "x")!;
		const string = foreground([review.theme.fg("syntaxString", "x")], "x")!;
		expect(oldStart.cell.fg).toBe(comment);
		expect(addedStart.cell.fg).toBe(keyword);
		for (const [start, end, fg] of [
			[oldStart, oldEnd, comment],
			[addedStart, addedEnd, string],
		] as const) {
			expect(end.rowIndex).toBeGreaterThan(start.rowIndex);
			expect(start.cell.bg).not.toBe("");
			expect(end.cell).toMatchObject({ bg: start.cell.bg, fg });
		}
		expect(oldStart.cell.bg).not.toBe(addedStart.cell.bg);
		expect(context.cell.bg).toBe("");

		review.terminal.press("enter");
		review.terminal.press("down");
		const selectedRows = review.terminal.rows();
		const selectedAdded = cellFor(selectedRows, "const newValue")!;
		const selectedAddedEnd = cellFor(selectedRows, "addedWrapEnd")!;
		expect(selectedAdded.row.some(cell => cell.ch === review.theme.symbols.symbol("nav.cursor"))).toBe(true);
		expect(selectedAdded.cell.bg).not.toBe("");
		expect(selectedAdded.cell.bg).not.toBe(selectedBg);
		expect(selectedAdded.cell.bg).not.toBe(oldStart.cell.bg);
		expect(selectedAdded.cell.fg).toBe(keyword);
		expect(selectedAddedEnd.cell).toMatchObject({ bg: selectedAdded.cell.bg, fg: string });

		review.terminal.press("up");
		review.addNote("old-side note");
		review.resize(100);
		review.terminal.press("down");
		review.addNote("new-side note");
		const anchor = { scope: "line" as const, path, oldPath: path, newPath: path, hunkHeader, occurrence: 1 };
		expect(review.model.getAnnotations()).toEqual([
			{ ...anchor, rawLine: `-${removed}`, oldLine: 40, note: "old-side note" },
			{ ...anchor, rawLine: `+${added}`, newLine: 40, note: "new-side note" },
		]);
	} finally {
		review.terminal.dispose();
	}
});

const SETUPS: Record<string, { text?: boolean; rows: number; files?: ReviewDiffFile[] }> = {
	"short-terminal": { rows: 12 },
	empty: { rows: 30, files: [] },
	text: { text: true, rows: 40 },
	"text-paste": { text: true, rows: 20 },
};

it("requires a second Enter press, not a key release, to discard notes", () => {
	const env = corpusEnvironment("dark");
	const model = new AnnotationReviewModel(
		{ kind: "text", source: TEXT },
		{ onComplete() {} },
		{ theme: env.theme, size: () => ({ columns: 100, rows: 24 }) },
	);
	const term = createTestTerminal(() => ({ layer: <AnnotationReview model={model} /> }), {
		columns: 100,
		rows: 24,
		theme: env.theme(),
	});
	try {
		term.focus(term.surface.layer()[0]!);
		term.press("a");
		term.paste("keep this note");
		term.press("enter");
		term.press("tab");
		term.press("down");
		term.press("enter");
		expect(model.discardArmed).toBe(true);
		term.press("enter", { kind: "release" });
		expect(model.getTextAnnotations().map(note => note.note)).toEqual(["keep this note"]);
		expect(model.finished).toBe(false);
		term.press("enter");
		expect(model.finished).toBe(true);
		expect(model.getTextAnnotations()).toEqual([]);
	} finally {
		term.dispose();
	}
});

panelSuite({
	dir: "overlays/plan-annotation",
	mount(caseName, corpusCase) {
		const setup = SETUPS[caseName] ?? { rows: 40 };
		const env = corpusEnvironment(corpusCase.theme);
		const noop = () => {};
		const model = new AnnotationReviewModel(
			setup.text
				? { kind: "text", source: TEXT }
				: { kind: "diff", files: setup.files ?? FILES, mode: "Reviewing `main..HEAD` changes" },
			setup.text ? { onComplete: noop } : { onComplete: noop, onWarning: noop, onExternalEditor: noop },
			{ theme: env.theme, size: () => ({ columns: corpusCase.widths.at(-1)!, rows: setup.rows }) },
		);
		// Every recorded stage drew the face at each width in turn (narrow ones take the focus off the files).
		const drawn = () => {
			for (const width of corpusCase.widths) model.drawnAt(width);
		};
		drawn();
		const step = (run: (d: Driver) => void) => (d: Driver) => {
			run(d);
			drawn();
		};
		const press = (...keys: string[]) => step(d => keys.forEach(key => d.press(key)));
		const emit = (event: Record<string, unknown>) =>
			step(d => void d.emit({ mods: [], ...event } as unknown as UiEvent));
		const steps: Record<string, (d: Driver) => void> = {
			"files nav": press("j", "j", DOWN, "k"),
			"file note a": press("a", ..."file wide note", ENTER),
			"reveal long path": press("k"),
			"to diff": press(ENTER),
			"move lines": press("j", "j", SHIFT_DOWN),
			page: press(PGDN, PGDN),
			"page up": press(PGUP),
			G: press("G"),
			g: press("g", "j", "j"),
			"line note": press("a", ..."first\nnote", ENTER),
			"line note typed only": press("a", ..."second"),
			"commit second": press(ENTER),
			chooser: press("e"),
			"chooser nav": press(DOWN, "j", UP),
			"chooser edit": press(ENTER, ..." more"),
			"commit edit": press(ENTER),
			"chooser esc": press("e", ESC),
			undo: press("u"),
			record: step(noop),
			"shift A": press("A", ..."file2", ENTER),
			"next file": press("]", "]"),
			"prev file": press("["),
			"files left": press("h"),
			"tab actions": press(TAB, TAB),
			"actions nav": press(UP, "j", "k"),
			"discard arm": press(DOWN, DOWN, ENTER),
			disarm: press("j"),
			"shift tab": press("\x1b[Z"),
			"native select file": emit({ type: "select", key: "split/rail/files", item: "f2" }),
			"native activate file": emit({ type: "activate", key: "split/rail/files", item: "f0" }),
			"native select line": emit({ type: "select", key: "split/pane/lines", item: "l3" }),
			"native activate line": emit({ type: "activate", key: "split/pane/lines", item: "l4" }),
			"type in native note": press(..."native"),
			"blocked action": emit({ type: "action", key: "actions/paste", act: "paste" }),
			commit: press(ENTER),
			"chooser native": press("k", "k", "k", "k", "a", ..."x", ENTER, "e"),
			"chooser select": emit({ type: "select", key: "split/pane/chooser/chooser", item: "c1" }),
			"chooser activate": emit({ type: "activate", key: "split/pane/chooser/chooser", item: "c0" }),
			"close draft": press(ESC),
			record2: step(noop),
			// files focus
			"edit file note": press("j", "e", ..."!", ENTER),
			"two file notes": press("A", ..."again", ENTER, "e"),
			"chooser pick": press(DOWN, ENTER, ESC),
			"back to files": press("u", "\x1b[Z", "\x1b[Z", "\x1b[Z"),
			"many down": press(...Array<string>(15).fill("j")),
			"to diff and left": press("l", "h", "\x1b[C", "h"),
			"native files": emit({ type: "select", key: "split/rail/files", item: "f1" }),
			describe: step(noop),
			"after describe keys": press(TAB, "j"),
			// native actions
			"describe first": step(noop),
			note: press(TAB, "a", ..."n", ENTER),
			discard: emit({ type: "action", key: "actions/discard", act: "discard" }),
			"pgdn native": press(PGDN),
			"discard 2": emit({ type: "action", key: "actions/discard", act: "discard" }),
			"discard 3": emit({ type: "action", key: "actions/discard", act: "discard" }),
			after: press("j"),
			review: emit({ type: "action", key: "actions/review", act: "review" }),
			notes: press(TAB, "a", ..."a", ENTER, "a", ..."b", ENTER, "A", ..."c", ENTER, "a", ..."d", ENTER),
			"chooser move": press(DOWN, DOWN),
			esc: press(ESC),
			editor: press("a", ..."l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8"),
			// text
			lines: press("j", "j", PGDN, "G", "g", "j"),
			"text note": press("A", ..."all", ENTER),
			"edit chooser": press("e", DOWN, ENTER, ..."!", ENTER),
			replace: step(() => void model.replaceTextSource("zero\ntwo\t tabs\nhm\n")),
			restore: step(() =>
				model.restoreDraft({
					kind: "text",
					annotations: [
						{ sourceIndex: 1, annotation: { scope: "line", line: 2, quote: "two\t tabs", note: "r" } },
					],
					editor: { sourceIndex: 0, scope: "line", text: "draft" },
				}),
			),
			unfocus: step(noop),
			refocus: step(noop),
			"native line": emit({ type: "select", key: "pane/lines", item: "l2" }),
			tab: press(TAB, ENTER),
		};
		for (const stage of corpusCase.stages) {
			if (stage.label.startsWith("key ")) steps[stage.label] = press(JSON.parse(stage.label.slice(4)) as string);
		}
		// "note" differs per case: the native-actions and review cases add ctrl+e after it.
		if (caseName === "diff-review-action") steps.note = press(TAB, "a", ..."n", ENTER, "\x05");
		if (caseName === "text") steps["line note"] = press("a", ..."hm", ENTER);
		if (caseName === "text-paste") steps.note = press("a", ..."x", ENTER);
		return { view: () => <AnnotationReview model={model} />, steps };
	},
});
