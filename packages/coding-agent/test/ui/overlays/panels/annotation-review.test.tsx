/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, it } from "bun:test";
import type { UiEvent } from "@oh-my-pi/pi-tui";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import type {
	ReviewDiffFile,
	TextReviewSource,
} from "../../../../src/extensibility/custom-commands/bundled/annotate/annotation-types";
import { AnnotationReview } from "../../../../src/ui/overlays/panels/annotation-review";
import { AnnotationReviewModel } from "../../../../src/ui/overlays/panels/annotation-review-model";
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

function addLineNote(model: AnnotationReviewModel, sourceIndex: number, note: string): void {
	if (model.focus === "files") model.key("enter", undefined, "\r");
	while (model.sourceIndex < sourceIndex) model.key("down", undefined, "\x1b[B");
	model.key("a", "a", "a");
	model.editDraft({ from: 0, to: 0, len: 0, text: note, cursor: note.length });
	model.key("enter", undefined, "\r");
}

it("rebases line notes by file identity and source anchors after a diff moves", () => {
	const oldHunk = "@@ -1,3 +1,3 @@";
	const newHunk = "@@ -10,5 +10,6 @@";
	const oldFile = diffFile("src/value.ts", oldHunk, [
		{ kind: "context", raw: " duplicate", content: "duplicate", oldLine: 20, newLine: 20, hunkHeader: oldHunk },
		{ kind: "context", raw: " duplicate", content: "duplicate", oldLine: 30, newLine: 30, hunkHeader: oldHunk },
		{ kind: "context", raw: " unique", content: "unique", oldLine: 40, newLine: 40, hunkHeader: oldHunk },
	]);
	const newFile = diffFile("src/value.ts", newHunk, [
		{ kind: "context", raw: " prefix", content: "prefix", oldLine: 10, newLine: 10, hunkHeader: newHunk },
		{ kind: "added", raw: "+inserted", content: "inserted", newLine: 19, hunkHeader: newHunk },
		{ kind: "context", raw: " duplicate", content: "duplicate", oldLine: 20, newLine: 20, hunkHeader: newHunk },
		{ kind: "context", raw: " duplicate", content: "duplicate", oldLine: 30, newLine: 30, hunkHeader: newHunk },
		{ kind: "context", raw: " unique", content: "unique", oldLine: 45, newLine: 45, hunkHeader: newHunk },
	]);
	const env = corpusEnvironment("dark");
	const model = new AnnotationReviewModel(
		{ kind: "diff", files: [oldFile], mode: "Review" },
		{ onComplete() {} },
		{ theme: env.theme, size: () => ({ columns: 100, rows: 24 }) },
	);
	addLineNote(model, 0, "duplicate note");
	addLineNote(model, 2, "unique note");

	const newcomer = diffFile("docs/readme.md", newHunk, []);
	expect(model.replaceDiffSource([newcomer, newFile])).toBe(0);
	expect(
		model.notes.map(entry => ({
			fileIndex: entry.fileIndex,
			sourceIndex: entry.sourceIndex,
			note: entry.annotation.note,
			hunkHeader: entry.annotation.scope === "line" ? entry.annotation.hunkHeader : "",
			oldLine: entry.annotation.scope === "line" ? entry.annotation.oldLine : undefined,
			newLine: entry.annotation.scope === "line" ? entry.annotation.newLine : undefined,
		})),
	).toEqual([
		{ fileIndex: 1, sourceIndex: 2, note: "duplicate note", hunkHeader: newHunk, oldLine: 20, newLine: 20 },
		{ fileIndex: 1, sourceIndex: 4, note: "unique note", hunkHeader: newHunk, oldLine: 45, newLine: 45 },
	]);
	expect(model.fileIndex).toBe(1);
	expect(model.sourceIndex).toBe(4);
	expect(model.undoStack).toEqual([]);
});
it("drops a duplicate-text note when its old coordinate disappears", () => {
	const oldFile = diffFile("src/value.ts", H, [
		{ kind: "context", raw: " repeated", content: "repeated", oldLine: 1, newLine: 1, hunkHeader: H },
		{ kind: "context", raw: " repeated", content: "repeated", oldLine: 2, newLine: 2, hunkHeader: H },
	]);
	const newFile = diffFile("src/value.ts", H, [
		{ kind: "context", raw: " repeated", content: "repeated", oldLine: 3, newLine: 3, hunkHeader: H },
	]);
	const env = corpusEnvironment("dark");
	const model = new AnnotationReviewModel(
		{ kind: "diff", files: [oldFile], mode: "Review" },
		{ onComplete() {} },
		{ theme: env.theme, size: () => ({ columns: 100, rows: 24 }) },
	);
	addLineNote(model, 0, "not uniquely anchored");

	expect(model.replaceDiffSource([newFile])).toBe(1);
	expect(model.notes).toEqual([]);
});

it("uses exact section identity to disambiguate repeated paths", () => {
	const path = "src/dupe.ts";
	const first = diffFile(path, H, [
		{ kind: "context", raw: " first", content: "first", oldLine: 1, newLine: 1, hunkHeader: H },
	]);
	const second = diffFile(
		path,
		H,
		[{ kind: "context", raw: " second", content: "second", oldLine: 2, newLine: 2, hunkHeader: H }],
		{ occurrence: 2 },
	);
	const env = corpusEnvironment("dark");
	const model = new AnnotationReviewModel(
		{ kind: "diff", files: [first, second], mode: "Review" },
		{ onComplete() {} },
		{ theme: env.theme, size: () => ({ columns: 100, rows: 24 }) },
	);
	model.key("down", undefined, "\x1b[B");
	model.key("enter", undefined, "\r");
	addLineNote(model, 0, "second-file note");

	const refreshedSecond = { ...second, occurrence: 1 };
	const refreshedFirst = { ...first, occurrence: 2 };
	expect(model.replaceDiffSource([refreshedSecond, refreshedFirst])).toBe(0);
	expect(model.fileIndex).toBe(0);
	expect(model.notes.map(entry => [entry.fileIndex, entry.annotation.occurrence, entry.annotation.note])).toEqual([
		[0, 1, "second-file note"],
	]);
});

it("drops notes on ambiguous file identities, keeps empty reviews refreshable, and disables Continue", () => {
	const file = diffFile("src/value.ts", H, MANY.slice(0, 1));
	const env = corpusEnvironment("dark");
	let refreshCalls = 0;
	const model = new AnnotationReviewModel(
		{ kind: "diff", files: [file, { ...file }], mode: "Review" },
		{
			onComplete() {},
			onRefresh: async () => {
				refreshCalls++;
			},
		},
		{ theme: env.theme, size: () => ({ columns: 100, rows: 24 }) },
	);
	addLineNote(model, 0, "must not attach");

	expect(model.replaceDiffSource([file])).toBe(1);
	expect(model.notes).toEqual([]);
	expect(model.replaceDiffSource([])).toBe(0);
	expect(model.files).toEqual([]);
	expect(model.actionDisabled(0)).toBe(true);
	model.key("r", "r", "r");
	expect(refreshCalls).toBe(1);
});

it("blocks concurrent refresh inputs and warns after a failed refresh", async () => {
	const pending = Promise.withResolvers<void>();
	const warnings: string[] = [];
	const env = corpusEnvironment("dark");
	let refreshCalls = 0;
	const model = new AnnotationReviewModel(
		{ kind: "diff", files: FILES.slice(0, 2), mode: "Review" },
		{
			onComplete() {},
			onWarning: message => warnings.push(message),
			onRefresh: () => {
				refreshCalls++;
				return pending.promise;
			},
		},
		{ theme: env.theme, size: () => ({ columns: 100, rows: 24 }) },
	);
	model.key("r", "r", "r");
	expect(model.refreshing).toBe(true);
	model.key("r", "r", "r");
	model.action("refresh");
	model.pick("files", "f1", true);
	expect(refreshCalls).toBe(1);
	expect(model.fileIndex).toBe(0);

	pending.reject(new Error("offline"));
	await pending.promise.catch(() => {});
	expect(model.refreshing).toBe(false);
	expect(warnings).toEqual(["Failed to refresh review: offline"]);
});

it("keeps cancel available during refresh and ignores late failures", async () => {
	const env = corpusEnvironment("dark");
	for (const closeBy of ["key", "native"] as const) {
		const pending = Promise.withResolvers<void>();
		const warnings: string[] = [];
		const model = new AnnotationReviewModel(
			{ kind: "diff", files: FILES.slice(0, 1), mode: "Review" },
			{
				onComplete() {},
				onWarning: message => warnings.push(message),
				onRefresh: () => pending.promise,
			},
			{ theme: env.theme, size: () => ({ columns: 100, rows: 24 }) },
		);
		model.key("r", "r", "r");
		if (closeBy === "key") model.key("escape", undefined, "\x1b");
		else model.action("close");
		expect(model.finished).toBe(true);
		const revision = model.rev();

		pending.reject(new Error("offline"));
		await pending.promise.catch(() => {});
		expect(model.refreshing).toBe(false);
		expect(model.rev()).toBe(revision);
		expect(warnings).toEqual([]);
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
