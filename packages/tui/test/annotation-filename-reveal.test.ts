import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getKeybindings, setKeybindings, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { ReviewDiffFile } from "@oh-my-pi/pi-tui/overlays/annotation-types";

const DOWN = "\x1b[B";
const TAB = "\t";
let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager;

function render(overlay: AnnotationOverlay, width = 90): string[] {
	return overlay.render(width).map(line => stripVTControlCharacters(line));
}

function makeOverlay(paths: readonly string[], backgroundLines: readonly string[] = []): AnnotationOverlay {
	const rows: ReviewDiffFile["rows"] = backgroundLines.map((content, index) => ({
		kind: "context",
		raw: ` ${content}`,
		content,
		oldLine: index + 1,
		newLine: index + 1,
		hunkHeader: "@@ -1,3 +1,3 @@",
	}));
	const files: ReviewDiffFile[] = paths.map(path => ({
		path,
		oldPath: path,
		newPath: path,
		occurrence: 1,
		rawDiff: `diff --git a/${path} b/${path}`,
		rows,
		linesAdded: 0,
		linesRemoved: 0,
		isBinary: false,
	}));
	return new AnnotationOverlay(
		{ terminal: { rows: 40 }, requestRender() {}, stop() {}, start() {} } as unknown as TUI,
		darkTheme!,
		getKeybindings() as KeybindingsManager,
		files,
		"Reviewing changes",
		{ onComplete() {} },
	);
}

beforeAll(async () => {
	darkTheme = await getThemeByName("dark");
});

beforeEach(() => {
	if (!darkTheme) throw new Error("dark theme unavailable");
	setThemeInstance(darkTheme);
	previousKeybindings = getKeybindings() as KeybindingsManager;
	setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
});

afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("AnnotationOverlay filename reveal", () => {
	it("shows the full selected filepath past the truncated sidebar label", () => {
		const path = `src/${"deep-module/".repeat(5)}selected-file.ts`;
		const lines = render(makeOverlay([path]));

		expect(lines.some(line => line.includes(path))).toBe(true);
	});

	it("reveals an exactly fitting filename when a note reduces its sidebar label budget", () => {
		// At width 90 the sidebar has 25 cells: two cursor cells, 17 label cells, and six change-badge cells.
		const path = "src/boundaries.ts";
		const overlay = makeOverlay([path]);
		const before = render(overlay)[1]!;
		expect(before.slice(4, 21)).toBe(path);
		expect(before.slice(21, 27)).toBe(" +0/-0");

		overlay.handleInput("a");
		overlay.handleInput("boundary note");
		overlay.handleInput("\r");
		const revealed = render(overlay)[1]!;
		expect(revealed.slice(4, 21)).toBe(path);

		overlay.handleInput(TAB);
		const collapsed = render(overlay)[1]!;
		expect(collapsed.slice(4, 21)).not.toBe(path);
		expect(collapsed.slice(4, 27)).toContain("…");
		expect(collapsed.slice(4, 27)).toContain("✎1");

		overlay.handleInput("\x1b[Z");
		expect(render(overlay)[1]!.slice(4, 21)).toBe(path);
	});

	it("keeps file rows stable while selection moves and reveals the new selection", () => {
		const path = `src/${"deep-module/".repeat(5)}selected-file.ts`;
		const overlay = makeOverlay([path, "second.ts", "third.ts"]);
		const before = render(overlay);
		const secondFileRow = before[2];

		overlay.handleInput(DOWN);
		const after = render(overlay);

		expect(after).toHaveLength(before.length);
		expect(secondFileRow).toContain("second.ts");
		expect(after[2]).toContain("second.ts");
		expect(after.some(line => line.includes(path))).toBe(false);
	});

	it("removes the floating reveal when file focus exits", () => {
		const path = `src/${"deep-module/".repeat(5)}selected-file.ts`;
		const overlay = makeOverlay([path]);
		expect(render(overlay).some(line => line.includes(path))).toBe(true);

		overlay.handleInput(TAB);
		const lines = render(overlay);

		expect(lines.some(line => line.includes(path))).toBe(false);
	});

	it("wraps very long filepaths within the frame without overflowing", () => {
		const path = `src/${Array.from({ length: 11 }, (_, index) => `folder-${String(index).padStart(3, "0")}`).join("/")}/target.ts`;
		const width = 65;
		const lines = render(makeOverlay([path]), width);

		const pathColumn = 4;
		const interiorWidth = width - pathColumn - 1;
		const revealRows = Math.ceil(visibleWidth(path) / interiorWidth);
		const revealedPath = lines
			.slice(1, 1 + revealRows)
			.map(line => line.slice(pathColumn, width - 1).trimEnd())
			.join("");

		expect(revealedPath).toContain(path);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
	});

	it("floats a bottom selection upward to show its full filepath without changing rows after collapse", () => {
		const width = 65;
		const path = `src/${"nested-directory/".repeat(7)}BOTTOM_FILENAME_TAIL.ts`;
		const paths = Array.from({ length: 80 }, (_, index) => `file-${index}.ts`);
		paths[paths.length - 1] = path;
		const overlay = makeOverlay(paths);
		for (let index = 1; index < paths.length; index++) overlay.handleInput(DOWN);
		render(overlay, width);

		overlay.handleInput(TAB);
		const collapsedBefore = render(overlay, width);
		overlay.handleInput("\x1b[Z");
		const revealed = render(overlay, width);

		const pathColumn = 4;
		const interiorWidth = width - pathColumn - 1;
		const revealRows = Math.ceil(visibleWidth(path) / interiorWidth);
		const revealStart = revealed.findIndex(line => line.slice(pathColumn, width - 1).startsWith("src/"));
		const revealedPath = revealed
			.slice(revealStart, revealStart + revealRows)
			.map(line => line.slice(pathColumn, width - 1).trimEnd())
			.join("");
		expect(revealRows).toBe(3);
		expect(revealStart).toBeGreaterThan(1);
		expect(revealedPath).toBe(path);
		expect(revealed.some(line => line.includes("BOTTOM_FILENAME_TAIL.ts"))).toBe(true);
		expect(revealed).toHaveLength(collapsedBefore.length);
		expect(revealed.length).toBeLessThanOrEqual(40);
		expect(revealed.every(line => visibleWidth(line) <= width)).toBe(true);

		overlay.handleInput(TAB);
		const collapsedAfter = render(overlay, width);
		expect(collapsedAfter).toEqual(collapsedBefore);
		expect(collapsedAfter.some(line => line.includes("file-78.ts"))).toBe(true);
	});

	it("marks a filepath longer than the whole frame while preserving its tail", () => {
		const width = 65;
		const path = `src/${"long-directory/".repeat(500)}BOTTOM_FILENAME_TAIL.ts`;
		const lines = render(makeOverlay([path]), width);

		expect(lines.some(line => line.slice(4, width - 1).startsWith("…"))).toBe(true);
		expect(lines.some(line => line.includes("BOTTOM_FILENAME_TAIL.ts"))).toBe(true);
		expect(lines.length).toBeLessThanOrEqual(40);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
	});

	it("keeps wrapped path segments separate from the diff text underneath", () => {
		const path = `src/${"nested-path-segment/".repeat(6)}target.ts`;
		const lines = render(makeOverlay([path], ["background-line-0", "background-line-1", "background-line-2"]), 65);

		expect(lines[1]).toContain("src/");
		expect(lines[3]).not.toContain("background-line-1");
		expect(lines[4]).toContain("background-line-2");
	});
});
