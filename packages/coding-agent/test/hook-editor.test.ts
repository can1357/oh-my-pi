import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { KeybindingsManager, setKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { HookEditorOptions } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/hook-editor";
import { HookEditor, type HookEditorHandle } from "../src/ui/overlays/panels/hook-dialogs";
import { type LayerTerminal, mountLayer } from "./helpers/layer-terminal";

interface Mounted extends LayerTerminal {
	readonly handle: HookEditorHandle;
}

const open: Mounted[] = [];

afterEach(() => {
	for (const editor of open.splice(0)) editor.dispose();
	vi.restoreAllMocks();
});

function mountEditor(
	title: string,
	prefill: string | undefined,
	onSubmit: (value: string, images?: readonly ImageContent[]) => void,
	onCancel: (draft: string, images?: readonly ImageContent[]) => void,
	options?: HookEditorOptions,
): Mounted {
	let handle: HookEditorHandle | undefined;
	const term = mountLayer(
		() =>
			HookEditor({
				title,
				prefill,
				options,
				onSubmit,
				onCancel,
				ref: h => {
					handle = h;
				},
			}),
		{ focusKind: "editor" },
	);
	if (!handle) throw new Error("Hook editor did not hand out its handle");
	const mounted = { ...term, handle };
	open.push(mounted);
	return mounted;
}

function largePasteText(): string {
	return Array.from({ length: 11 }, (_, index) => `pasted line ${index + 1}`).join("\n");
}

describe("HookEditor default (hook) mode", () => {
	it("inserts a newline on Enter instead of submitting immediately", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, onCancel);

		editor.handleInput("a");
		editor.handleInput("b");
		editor.handleInput("\r");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		editor.handleInput("c");
		editor.handleInput("d");
		editor.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("ab\ncd");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits Ctrl+Enter variants with NumLock or keypad Enter metadata", () => {
		for (const variant of ["\x1b[13;133u", "\x1b[57414;5u", "\x1b[57414;133u"]) {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const editor = mountEditor("Prompt", "draft", onSubmit, onCancel);

			editor.handleInput(variant);

			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0]?.[0]).toBe("draft");
			expect(onCancel).not.toHaveBeenCalled();
		}
	});

	it("keeps Ctrl+Q working after Enter inserts a newline (Windows Terminal)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, onCancel);

		editor.handleInput("a");
		editor.handleInput("b");
		// Windows Terminal sends bare `\r` for both Enter and Ctrl+Enter; the
		// hook editor must treat `\r` as a newline and reserve Ctrl+Q for submit.
		editor.handleInput("\r");
		editor.handleInput("c");
		editor.handleInput("d");
		expect(onSubmit).not.toHaveBeenCalled();

		editor.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("ab\ncd");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits a large paste whole on Ctrl+Enter", () => {
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, vi.fn());
		const pasted = largePasteText();

		editor.term.paste(pasted);
		editor.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe(pasted);
	});

	it("treats Enter after a paste as a newline in hook mode", () => {
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, vi.fn());

		editor.term.paste("first\nsecond");
		editor.handleInput("\r");
		expect(onSubmit).not.toHaveBeenCalled();
		editor.handleInput("last");
		editor.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("first\nsecond\nlast");
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", "draft", onSubmit, onCancel);

		editor.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("HookEditor prompt-style mode", () => {
	it("opens the external editor on Ctrl+G and submits its text", async () => {
		const externalEditor = vi.fn(async (text: string) => `${text} edited`);
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", "draft", onSubmit, vi.fn(), {
			promptStyle: true,
			externalEditor,
		});

		editor.handleInput("\x07");
		// The edited text lands in the continuation after the editor's promise.
		await externalEditor.mock.results[0]?.value;
		await Promise.resolve();
		expect(externalEditor).toHaveBeenCalledWith("draft");
		editor.handleInput("\r");

		expect(onSubmit.mock.calls[0]?.[0]).toBe("draft edited");
	});

	it("submits the complete pasted answer once when paste and Enter arrive together", () => {
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, vi.fn(), {
			promptStyle: true,
		});
		const pasted = largePasteText();

		editor.term.paste(pasted);
		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe(pasted);
	});

	it("keeps empty and image-path pastes as text in a prompt that did not opt into images", () => {
		const onPasteImage = vi.fn(async () => true);
		const onPasteImagePath = vi.fn();
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, vi.fn(), {
			promptStyle: true,
			onPasteImage,
			onPasteImagePath,
		});

		editor.term.paste("");
		editor.term.paste("/tmp/shot.png");
		editor.handleInput("\r");

		expect(onPasteImage).not.toHaveBeenCalled();
		expect(onPasteImagePath).not.toHaveBeenCalled();
		expect(onSubmit.mock.calls[0]?.[0]).toBe("/tmp/shot.png");
	});

	it("refuses image attachments unless the prompt opted in and is still open", () => {
		const image: ImageContent = { type: "image", data: "image", mimeType: "image/png" };
		const plain = mountEditor("Prompt", undefined, vi.fn(), vi.fn(), { promptStyle: true });
		const closed = mountEditor("Prompt", undefined, vi.fn(), vi.fn(), { promptStyle: true, acceptImages: true });
		closed.dispose();

		expect(plain.handle.attachImage(image)).toBeUndefined();
		expect(closed.handle.attachImage(image)).toBeUndefined();
	});

	it("numbers images in text order on submit when they attached out of order", () => {
		// Concurrent path loads: the second-pasted file finished first and took #1.
		const later: ImageContent = { type: "image", data: "later", mimeType: "image/png" };
		const earlier: ImageContent = { type: "image", data: "earlier", mimeType: "image/png" };
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", "[Image #2] then [Image #1]", onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: true,
			images: [later, earlier],
		});

		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledWith("[Image #1] then [Image #2]", [earlier, later]);
	});

	it("drops images whose markers were deleted and renumbers the rest on submit", () => {
		const first: ImageContent = { type: "image", data: "first", mimeType: "image/png" };
		const second: ImageContent = { type: "image", data: "second", mimeType: "image/jpeg" };
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", "[Image #2]", onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: true,
			images: [first, second],
		});

		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledWith("[Image #1]", [second]);
	});

	it("hands an empty paste to the host's clipboard image read and submits the marker it lands", () => {
		// Windows Terminal owns Ctrl+V and pastes an image-only clipboard as an empty paste.
		const image: ImageContent = { type: "image", data: "image", mimeType: "image/png" };
		const onSubmit = vi.fn();
		// The host attaches through the editor's handle, as InputController does for a prompt paste target.
		const onPasteImage = vi.fn(async () => {
			const marker = editor.handle.attachImage(image);
			if (marker) editor.handle.paste(marker);
			return true;
		});
		const editor = mountEditor("Prompt", "see ", onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: true,
			onPasteImage,
		});

		editor.term.paste("");
		expect(onPasteImage).toHaveBeenCalledTimes(1);
		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledWith("see [Image #1]", [image]);
	});

	it("hands each pasted image path to the host when the prompt opted into images", () => {
		const onPasteImagePath = vi.fn();
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: true,
			onPasteImagePath,
		});

		editor.term.paste("/tmp/a.png /tmp/b.png");
		editor.handleInput("\r");

		expect(onPasteImagePath.mock.calls.map(call => call[0])).toEqual(["/tmp/a.png", "/tmp/b.png"]);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("");
	});

	it("labels attached images with their size and deletes the marker as a unit", () => {
		const image: ImageContent = { type: "image", data: "image", mimeType: "image/png" };
		const onSubmit = vi.fn();
		const editor = mountEditor("Prompt", "see ", onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: true,
		});
		const marker = editor.handle.attachImage(image, { width: 640, height: 240 });
		expect(marker).toBe("[Image #1, 640x240]");
		editor.handle.paste(marker ?? "");

		// One backspace removes the whole marker, so its image is dropped on submit.
		editor.handleInput("\x7f");
		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledWith("see ", []);
	});

	it("submits on alternate Enter encodings recognized by the key matcher", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		editor.handleInput("a");
		editor.handleInput("\x1bOM");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits when a terminal reports plain Enter as LF", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		editor.handleInput("a");
		editor.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("inserts newline on Shift+Enter instead of submitting", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		editor.handleInput("a");
		editor.handleInput("\x1b[13;2u");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		editor.handleInput("b");
		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("a\nb");
	});

	it("submits on the Ctrl+Enter chord in prompt-style mode (#3353)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		editor.handleInput("x");
		editor.handleInput("y");
		editor.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("xy");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits on Ctrl+Q in prompt-style mode (Windows Terminal fallback, #3353)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		// Windows Terminal swallows Ctrl+Enter, so app.message.followUp also binds
		// Ctrl+Q (#1903). The ask tool's prompt-style editor missed this chord
		// before #3353 — users hit Ctrl+Enter expecting submit, got nothing.
		editor.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toBe("draft");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("hands the draft and its images to onCancel on Escape (#18211)", () => {
		const image: ImageContent = {
			type: "image",
			data: "image",
			mimeType: "image/png",
		};
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", "see [Image #1]", onSubmit, onCancel, {
			promptStyle: true,
			acceptImages: true,
			images: [image],
		});

		editor.handleInput(" ");
		editor.handleInput("x");
		editor.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledWith("see [Image #1] x", [image]);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const editor = mountEditor("Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		editor.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("cancels on app.interrupt in prompt-style mode even when remapped", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.interrupt": "alt+x" }));
		try {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const editor = mountEditor("Prompt", "draft", onSubmit, onCancel, {
				promptStyle: true,
			});

			editor.handleInput("\x1bx");

			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(onSubmit).not.toHaveBeenCalled();
		} finally {
			setKeybindings(KeybindingsManager.inMemory());
		}
	});
});
