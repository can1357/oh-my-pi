import { afterEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import type { NativeTextEdit } from "@oh-my-pi/pi-tui/native/node";
import { defaultEditorTheme } from "../test-themes";
import { TspHarness } from "./tsp-harness";

const UNDO = "\x1b[45;5u"; // Ctrl+-

function editorWith(text: string): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setText(text);
	return editor;
}

/** The caret as the UTF-16 offset the `editor` node describes. */
function offsetOf(editor: Editor): number {
	const { line, col } = editor.getCursor();
	const lines = editor.getText().split("\n");
	let offset = col;
	for (let i = 0; i < line; i++) offset += lines[i]!.length + 1;
	return offset;
}

function edit(text: string, from: number, to: number, insert: string, cursor: number): NativeTextEdit {
	return { from, to, text: insert, cursor, len: text.length };
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

describe("TSP edit event", () => {
	it("reaches the editor that described the node and replaces the selection", async () => {
		const editor = editorWith("hello world");
		harness = await TspHarness.start(tui => tui.addChild(editor));
		const h = harness;
		const node = h.find(n => n.k === "editor")!;
		h.event({
			ev: "edit",
			sf: h.terminal.surface!,
			id: node.id,
			from: 6,
			to: 11,
			text: "there",
			cursor: 11,
			len: 11,
		});
		expect(editor.getText()).toBe("hello there");
		await h.render();
		expect(h.byId(node.id)?.p).toMatchObject({ text: "hello there", cursor: 11 });
	});

	it("undo reverts the last edit, and is a no-op with nothing to undo", async () => {
		const editor = new Editor(defaultEditorTheme);
		harness = await TspHarness.start(tui => tui.addChild(editor));
		const h = harness;
		const node = h.find(n => n.k === "editor")!;
		const sf = h.terminal.surface!;
		h.event({ ev: "undo", sf, id: node.id });
		expect(editor.getText()).toBe("");
		h.event({ ev: "edit", sf, id: node.id, from: 0, to: 0, text: "hi", cursor: 2, len: 0 });
		expect(editor.getText()).toBe("hi");
		h.event({ ev: "undo", sf, id: node.id });
		expect(editor.getText()).toBe("");
		await h.render();
		expect(h.byId(node.id)?.p).toMatchObject({ text: "", cursor: 0 });
	});
});

describe("Editor.applyHostEdit", () => {
	it("replaces a range across lines and places the caret in the result", () => {
		const text = "one\ntwo\nthree";
		const editor = editorWith(text);
		const changes: string[] = [];
		editor.onChange = value => changes.push(value);
		editor.applyHostEdit(edit(text, 2, 9, "X\nY", 5));
		expect(editor.getText()).toBe("onX\nYhree");
		expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
		expect(changes).toEqual(["onX\nYhree"]);
	});

	it("moves only the caret for an empty edit, clamping out-of-range offsets", () => {
		const text = "ab\ncd";
		const editor = editorWith(text);
		const changes: string[] = [];
		editor.onChange = value => changes.push(value);
		editor.applyHostEdit(edit(text, 4, 4, "", 4));
		expect(editor.getText()).toBe(text);
		expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
		editor.applyHostEdit(edit(text, 99, 99, "", 99));
		expect(editor.getText()).toBe(text);
		expect(offsetOf(editor)).toBe(text.length);
		editor.applyHostEdit(edit(text, -1, -1, "", Number.NaN));
		expect(offsetOf(editor)).toBe(0);
		expect(changes).toEqual([]);
		// No undo unit was recorded for either move.
		editor.handleInput(UNDO);
		expect(editor.getText()).toBe(text);
	});

	it("ignores an edit whose len no longer matches the text", () => {
		const editor = editorWith("abc");
		editor.handleInput("d"); // in flight before the terminal's edit arrived
		editor.applyHostEdit({ from: 0, to: 3, text: "", cursor: 0, len: 3 });
		expect(editor.getText()).toBe("abcd");
		expect(offsetOf(editor)).toBe(4);
	});

	it("counts UTF-16 code units and never splits a surrogate pair", () => {
		const text = "a😀b😀c";
		const editor = editorWith(text);
		// Select the first emoji exactly (code units 1..3).
		editor.applyHostEdit(edit(text, 1, 3, "", 1));
		expect(editor.getText()).toBe("ab😀c");
		expect(offsetOf(editor)).toBe(1);
		// A range ending inside the second emoji's pair takes the whole emoji.
		const next = editor.getText();
		editor.applyHostEdit(edit(next, 2, 3, "", 2));
		expect(editor.getText()).toBe("abc");
		// A caret landing mid-pair snaps to the pair's start.
		const emoji = "x😀";
		editor.setText(emoji);
		editor.applyHostEdit(edit(emoji, 2, 2, "", 2));
		expect(offsetOf(editor)).toBe(1);
	});

	it("widens a range that cuts into an atomic placeholder to the whole token", () => {
		const text = "a [Image #1, 800x600] b";
		const editor = editorWith(text);
		editor.atomicTokenPattern = /\[(?:Image|Paste) #\d+(?:,[^\]\n]*)?\]/g;
		// From "a " into the middle of the token, typed over with "Z".
		editor.applyHostEdit(edit(text, 1, 8, "Z", 2));
		expect(editor.getText()).toBe("aZ b");
		expect(offsetOf(editor)).toBe(2);
	});

	it("is one undo unit that restores text and caret", () => {
		const text = "keep this text";
		const editor = editorWith(text);
		editor.applyHostEdit(edit(text, 5, 10, "", 5));
		expect(editor.getText()).toBe("keep text");
		editor.applyHostEdit(edit("keep text", 5, 5, "", 0));
		editor.handleInput(UNDO);
		expect(editor.getText()).toBe(text);
		expect(offsetOf(editor)).toBe(text.length);
	});
});

describe("Input.applyHostEdit", () => {
	it("replaces a range with newlines stripped, as a paste", () => {
		const input = new Input();
		input.setValue("hello world");
		input.applyHostEdit({ from: 0, to: 5, text: "bye\nnow", cursor: 7, len: 11 });
		expect(input.getValue()).toBe("byenow world");
		expect(input.getCursor()).toBe(6);
		input.applyHostEdit({ from: 0, to: 12, text: "", cursor: 0, len: 11 }); // stale
		expect(input.getValue()).toBe("byenow world");
		input.handleInput(UNDO);
		expect(input.getValue()).toBe("hello world");
	});

	it("maps a masked field's bullet offsets onto its graphemes", () => {
		const input = new Input();
		input.mask = true;
		input.setValue("a😀bc");
		// Described as four bullets; delete the second and third (😀 and b).
		input.applyHostEdit({ from: 1, to: 3, text: "", cursor: 1, len: 4 });
		expect(input.getValue()).toBe("ac");
		expect(input.getCursor()).toBe(1);
	});
});
