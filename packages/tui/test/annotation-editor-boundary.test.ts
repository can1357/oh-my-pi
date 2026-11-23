import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { CURSOR_MARKER, type TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const WIDTH = 40;
// AnnotationOverlay reserves four frame cells and the editor prompt gutter reserves two more.
const INPUT_CAPACITY = WIDTH - 6;
let darkTheme: Theme | undefined;

function makeOverlay(): AnnotationOverlay {
	const tui = { terminal: { rows: 40 }, requestRender() {}, stop() {}, start() {} } as unknown as TUI;
	const keybindings = KeybindingsManager.inMemory({
		"tui.select.cancel": "escape",
		"app.editor.external": "ctrl+e",
	});
	const source: TextReviewSource = {
		id: "boundary",
		kind: "message",
		label: "source",
		text: "source text",
	};
	const overlay = new AnnotationOverlay(tui, darkTheme!, keybindings, source, { onComplete() {} });
	overlay.focused = true;
	overlay.setUseTerminalCursor(false);
	return overlay;
}

function typeText(overlay: AnnotationOverlay, text: string): void {
	for (const glyph of text) overlay.handleInput(glyph);
}

function renderedInputRows(overlay: AnnotationOverlay): string[] {
	return overlay.render(WIDTH).flatMap(line => stripVTControlCharacters(line).match(/[Q界]+/g) ?? []);
}

describe("AnnotationOverlay software cursor width boundary", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
	});

	beforeEach(() => {
		if (!darkTheme) throw new Error("dark theme unavailable");
		setThemeInstance(darkTheme);
	});

	it("preserves full-cell input and shows a software caret after wrapping", () => {
		const overlay = makeOverlay();
		overlay.handleInput("A");

		const exact = "Q".repeat(INPUT_CAPACITY);
		typeText(overlay, exact);
		expect(renderedInputRows(overlay)).toEqual([exact]);

		typeText(overlay, "Q");
		expect(renderedInputRows(overlay)).toEqual([exact, "Q"]);
		const continuationRow = overlay.render(WIDTH).filter(line => stripVTControlCharacters(line).includes("Q"))[1]!;
		expect(stripVTControlCharacters(continuationRow.replaceAll(CURSOR_MARKER, ""))).toContain(
			`Q${stripVTControlCharacters(darkTheme!.nav.cursor)}`,
		);

		typeText(overlay, "Q");
		expect(renderedInputRows(overlay)).toEqual([exact, "QQ"]);
	});

	it("keeps a wide trailing glyph visible when the software cursor borrows its cells", () => {
		const overlay = makeOverlay();
		overlay.handleInput("A");

		const exact = "Q".repeat(INPUT_CAPACITY - visibleWidth("界")) + "界";
		typeText(overlay, exact);
		expect(renderedInputRows(overlay)).toEqual([exact]);
	});
});
