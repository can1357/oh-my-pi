import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "@pk-nerdsaver-ai/pi-tui/components/editor";
import { visibleWidth } from "@pk-nerdsaver-ai/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";

const WIDTH = 32;

function renderPlain(editor: Editor, width = WIDTH): string[] {
	return editor.render(width).map(line => stripVTControlCharacters(line));
}

describe("Editor bottom section", () => {
	it("renders body rows, a divider, footer rows, and a plain bottom border inside the frame", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello");
		editor.setBottomSection({ bodyRows: ["[repo/main]"], footerRows: ["Run"] });

		const lines = renderPlain(editor);
		// top border, text row, chips row, divider, rail row, bottom border
		expect(lines.length).toBe(6);
		expect(lines[0]).toMatch(/^\+-+\+$/);
		expect(lines[1]).toContain("hello");
		expect(lines[2]).toContain("[repo/main]");
		expect(lines[3]).toMatch(/^\|-+\|$/); // divider (tee falls back to vertical in this theme)
		expect(lines[4]).toContain("Run");
		expect(lines[5]).toMatch(/^\+-+\+$/); // bottom border carries no text when a section is set
		// no line overflows the render width
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	it("caps the rendered frame when a footer would exceed maxHeight", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello");
		editor.setBottomSection({ bodyRows: ["chip-1", "chip-2"], footerRows: ["Run"] });
		editor.setMaxHeight(3);

		expect(renderPlain(editor).length).toBeLessThanOrEqual(3);
	});

	it("keeps bottom-section rows uniform at narrow widths", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("x");
		editor.setBottomSection({ bodyRows: ["chip"], footerRows: ["Run"] });

		const sectionRows = renderPlain(editor, 4).slice(2);
		expect(sectionRows.length).toBe(4);
		expect(new Set(sectionRows.map(row => visibleWidth(row)))).toEqual(new Set([4]));
	});

	it("omits the divider when only body rows are present and truncates overlong rows", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("x");
		editor.setBottomSection({ bodyRows: ["y".repeat(200)] });

		const lines = renderPlain(editor);
		expect(lines.some(line => /^\|-+\|$/.test(line))).toBe(false);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	it("supports a live provider and keeps the classic fused bottom border when it returns undefined", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("tail");
		let section: { footerRows: string[] } | undefined = { footerRows: ["rail"] };
		editor.setBottomSection(() => section);

		expect(renderPlain(editor).some(line => line.includes("rail"))).toBe(true);

		section = undefined;
		const lines = renderPlain(editor);
		expect(lines.some(line => line.includes("rail"))).toBe(false);
		// classic shape: the last line fuses the text onto the bottom border
		expect(lines.at(-1)).toContain("tail");
	});

	it("shows the placeholder with terminal cursor rendering while focused or unfocused", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.placeholder = "Describe the outcome";
		editor.setUseTerminalCursor(true);

		editor.focused = false;
		expect(editor.render(WIDTH).join("\n")).toContain("Describe the outcome");

		editor.focused = true;
		expect(editor.render(WIDTH).join("\n")).toContain("Describe the outcome");
	});

	it("shows placeholder ghost text only while the editor is empty", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.placeholder = "Describe the outcome you want…";

		expect(renderPlain(editor).join("\n")).toContain("Describe the outcome");

		editor.setText("real input");
		const withText = renderPlain(editor).join("\n");
		expect(withText).not.toContain("Describe the outcome");
		expect(withText).toContain("real input");
	});
});
