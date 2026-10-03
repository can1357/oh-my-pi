import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { encodeTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { defaultEditorTheme } from "../test-themes";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

function send(editor: CustomEditor, text: string): void {
	editor.handleNativeEvent({ type: "send", key: "line/input", text });
}

const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

describe("TSP send event", () => {
	it("submits a multiline prompt once to its owner during optimistic startup, regardless of keyboard focus", async () => {
		const target = new CustomEditor(defaultEditorTheme);
		const other = new CustomEditor(defaultEditorTheme);
		const submitted: string[] = [];
		target.onSubmit = text => {
			submitted.push(text);
		};
		other.onSubmit = () => {
			throw new Error("send reached the keyboard focus instead of its addressed owner");
		};
		harness = await TspHarness.start(
			tui => {
				tui.addChild(target);
				tui.addChild(other);
				tui.setFocus(other);
			},
			{ expected: true, manualProbe: true, deferInput: true },
		);
		const h = harness;
		const id = `${nativeComponentId(target)}.line/input`;
		expect(h.byId(id)?.k).toBe("editor");
		expect(h.byId(id)?.p).toMatchObject({ sendable: true });
		expect(h.terminal.tspProbePending).toBe(true);
		const text = "first line\n\n  indented €🙂\nlast line";
		h.event({ ev: "send", sf: h.terminal.surface!, id, text });
		expect(submitted).toEqual([text]);
		expect(target.getText()).toBe("");
		expect(other.getText()).toBe("");
		expect(h.errors).toEqual([]);
	});

	it("publishes writable bootstrap readiness after wiring and lifting the submit gate, without user input", async () => {
		const target = new CustomEditor(defaultEditorTheme);
		const other = new CustomEditor(defaultEditorTheme);
		target.disableSubmit = true;
		target.setDraft("keep [Image #1]", [image]);
		const draft = target.getText();
		const submitted: string[] = [];
		harness = await TspHarness.start(
			tui => {
				tui.addChild(target);
				tui.addChild(other);
				tui.setFocus(other);
			},
			{ expected: true, manualProbe: true, deferInput: true },
		);
		const h = harness;
		const id = `${nativeComponentId(target)}.line/input`;
		const bootstrap = h.byId(id);
		expect(bootstrap?.k).toBe("editor");
		expect(bootstrap?.p).toMatchObject({ text: draft, sendable: false });
		expect(bootstrap?.p).not.toMatchObject({ readonly: true });
		expect(bootstrap?.p).not.toMatchObject({ disabled: true });
		h.event({ ev: "send", sf: h.terminal.surface!, id, text: "too early" });
		expect(target.getText()).toBe(draft);
		expect(target.pendingImages).toEqual([image]);

		target.onSubmit = text => {
			submitted.push(text);
		};
		await h.render();
		expect(h.byId(id)?.p).toMatchObject({ text: draft, sendable: false });
		h.event({ ev: "send", sf: h.terminal.surface!, id, text: "still disabled" });
		expect(submitted).toEqual([]);
		expect(target.getText()).toBe(draft);

		target.disableSubmit = false;
		const frames = h.frames.length;
		h.tui.requestRender();
		h.flush();
		expect(h.frames.length).toBeGreaterThan(frames);
		expect(h.byId(id)?.p).toMatchObject({ text: draft, sendable: true });
		expect(h.terminal.tspProbePending).toBe(true);
		const text = "initial prompt\nsecond line";
		h.event({ ev: "send", sf: h.terminal.surface!, id, text });
		await h.render();
		expect(submitted).toEqual([text]);
		expect(target.getText()).toBe("");
		expect(other.getText()).toBe("");
		target.handleInput("\x1b[A");
		expect(target.getText()).toBe(draft);
		expect(target.pendingImages).toEqual([image]);
		expect(h.errors).toEqual([]);
	});

	it("ignores malformed payloads, foreign surfaces and noneditable or invented node ids", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.setText("keep draft");
		const submit = vi.fn();
		editor.onSubmit = submit;
		harness = await TspHarness.start(tui => tui.addChild(editor));
		const h = harness;
		const base = nativeComponentId(editor);
		const id = `${base}.line/input`;
		const sf = h.terminal.surface!;
		for (const event of [
			{ ev: "send", sf, id, text: null },
			{ ev: "send", id, text: "prompt" },
			{ ev: "send", sf, text: "prompt" },
		]) {
			h.terminal.send(encodeTspMessage("e", JSON.stringify(event)));
			h.flush();
		}
		for (const target of [base, `${base}.bar`, `${id}/invented`, "unknown"]) {
			h.event({ ev: "send", sf, id: target, text: "prompt" });
		}
		h.event({ ev: "send", sf: "closed:surface", id, text: "prompt" });
		expect(submit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("keep draft");
		h.tui.removeChild(editor);
		await h.render();
		h.event({ ev: "send", sf, id, text: "prompt" });
		expect(submit).not.toHaveBeenCalled();
	});

	it("does not deliver sends after the surface closes", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		const submit = vi.fn();
		editor.onSubmit = submit;
		harness = await TspHarness.start(tui => tui.addChild(editor));
		const h = harness;
		const sf = h.terminal.surface!;
		const id = `${nativeComponentId(editor)}.line/input`;
		h.tui.closeNative();
		h.flush();
		h.event({ ev: "send", sf, id, text: "prompt" });
		expect(submit).not.toHaveBeenCalled();
	});
});

describe("CustomEditor explicit prompt submission", () => {
	it("bypasses large-paste selection menus and never expands tokens from a displaced draft", () => {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.pasteText("old expansion\n".repeat(20));
		const menu = vi.fn(() => true);
		editor.onLargePaste = menu;
		const submitted: string[] = [];
		editor.onSubmit = text => {
			submitted.push(text);
		};
		const text = `${"large prompt\n".repeat(100)}literal [Paste #1, +20 lines]`;
		send(editor, text);
		expect(submitted).toEqual([text]);
		expect(menu).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe("old expansion\n".repeat(20));
	});

	it("retains the prior draft and attachments for recall instead of submitting them with explicit text", () => {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.setDraft("Inspect [Image #1, 1x1]", [image]);
		const previous = editor.getText();
		const submitted: { text: string; images: ImageContent[] }[] = [];
		editor.onSubmit = text => {
			submitted.push({ text, images: [...editor.pendingImages] });
		};
		send(editor, "/command supplied\nsecond line");
		expect(submitted).toEqual([{ text: "/command supplied\nsecond line", images: [] }]);
		expect(editor.pendingImages).toEqual([]);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe(previous);
		expect(editor.getExpandedText()).toBe("Inspect [Image #1, 1x1]");
		expect(editor.pendingImages).toEqual([image]);
	});

	it("leaves drafts untouched for blank, disabled or unwired sends", () => {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.setDraft("keep [Image #1]", [image]);
		const previous = editor.getText();
		const submit = vi.fn();
		editor.onSubmit = submit;
		for (const text of ["", " \n\t"]) send(editor, text);
		editor.disableSubmit = true;
		send(editor, "disabled");
		editor.disableSubmit = false;
		editor.onSubmit = undefined;
		send(editor, "unwired");
		expect(submit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe(previous);
		expect(editor.pendingImages).toEqual([image]);
	});

	it("waits for clipboard attachments before replacing their draft, then drains sends and keys in FIFO order", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.setText("clipboard draft");
		const clipboard = Promise.withResolvers<boolean>();
		const submitted = Promise.withResolvers<void>();
		const prompts: string[] = [];
		editor.onPasteImage = async () => {
			await clipboard.promise;
			editor.setDraft("clipboard draft [Image #1]", [image]);
			return true;
		};
		editor.onSubmit = text => {
			prompts.push(text);
			submitted.resolve();
		};
		editor.handleInput("\x16");
		send(editor, "explicit\ntext");
		editor.handleInput("tail");
		expect(prompts).toEqual([]);
		expect(editor.getText()).toBe("clipboard draft");
		clipboard.resolve(true);
		await submitted.promise;
		expect(prompts).toEqual(["explicit\ntext"]);
		expect(editor.getText()).toBe("tail");
		editor.setText("");
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe("clipboard draft [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
	});

	it("keeps the draft when submission becomes disabled while a send waits for clipboard work", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.setText("keep draft");
		const clipboard = Promise.withResolvers<boolean>();
		const submit = vi.fn();
		editor.onPasteImage = () => clipboard.promise;
		editor.onSubmit = submit;
		editor.handleInput("\x16");
		send(editor, "queued prompt");
		editor.disableSubmit = true;
		clipboard.resolve(false);
		await clipboard.promise;
		expect(submit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("keep draft");
	});

	it("drains a send once even when the preceding clipboard read rejects", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		const clipboard = Promise.withResolvers<boolean>();
		const submitted = Promise.withResolvers<void>();
		const prompts: string[] = [];
		editor.onPasteImage = () => clipboard.promise;
		editor.onSubmit = text => {
			prompts.push(text);
			submitted.resolve();
		};
		editor.handleInput("\x16");
		send(editor, "after failure");
		expect(prompts).toEqual([]);
		clipboard.reject(new Error("clipboard unavailable"));
		await submitted.promise;
		expect(prompts).toEqual(["after failure"]);
	});
});
