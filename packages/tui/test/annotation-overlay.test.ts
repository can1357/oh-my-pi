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

const ENTER = "\r";
const TAB = "\t";
const DOWN = "\x1b[B";
const CANCEL = "\x1b";
const SHIFT_ENTER = "\x1b[13;2~";
const CTRL_U = "\x15";
const CTRL_E = "\x05";
let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager;

function render(overlay: AnnotationOverlay, width = 90): string {
	return overlay.render(width).map(stripVTControlCharacters).join("\n");
}

type DiffOverlayOptions = Omit<AnnotationOverlayCallbacks, "onComplete"> & {
	onComplete?: (result: CodeReviewOverlayResult | undefined) => void;
};

function makeDiffOverlay(files: readonly ReviewDiffFile[], options: DiffOverlayOptions = {}): AnnotationOverlay {
	const { onComplete = () => {}, ...callbacks } = options;
	return new AnnotationOverlay(
		makeTui(),
		darkTheme!,
		getKeybindings() as KeybindingsManager,
		files,
		"Reviewing changes",
		{ ...callbacks, onComplete },
	);
}

function makeTextOverlay(
	source: TextReviewSource,
	onComplete: (result: TextReviewOverlayResult | undefined) => void = () => {},
): AnnotationOverlay {
	return new AnnotationOverlay(makeTui(), darkTheme!, getKeybindings() as KeybindingsManager, source, { onComplete });
}

function makeTui(): TUI {
	return {
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
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
		try {
			const overlay = makeDiffOverlay(oneLineFiles);
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
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
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
});
