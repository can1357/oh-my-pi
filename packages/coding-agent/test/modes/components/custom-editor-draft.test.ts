import { beforeAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { chipLabel } from "@oh-my-pi/pi-coding-agent/modes/composer-attachments";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

beforeAll(async () => {
	await initTheme(false);
});

describe("CustomEditor draft restore", () => {
	it("collapses stored image markers into chip tokens that round-trip on expansion", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("look at [Image #1, 800x600] please", [image]);
		expect(editor.getText()).toBe(`look at ${chipLabel("image", 1)} please`);
		// The wire format is restored at submit time via the atom table.
		expect(editor.getExpandedText()).toBe("look at [Image #1, 800x600] please");
	});

	it("strips a legacy attachment URI from restored drafts", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("see [Image #1] attachment://1 end", [image]);
		expect(editor.getText()).toBe(`see ${chipLabel("image", 1)} end`);
	});

	it("re-materializes image links asynchronously so restored chips are clickable", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { promise, resolve } = Promise.withResolvers<(string | undefined)[] | undefined>();
		editor.draftImageLinkMaterializer = () => promise;
		editor.setDraft("[Image #1]", [image]);
		expect(editor.imageLinks).toBeUndefined();
		resolve(["/tmp/blob-1.png"]);
		// The materializer awaited this promise before we did, so its continuation
		// (link assignment) is queued ahead of ours — awaiting it here is a
		// deterministic happens-after, no timer needed.
		await promise;
		expect(editor.imageLinks).toEqual(["/tmp/blob-1.png"]);
		expect(editor.pendingImageLinks).toEqual(["/tmp/blob-1.png"]);
	});

	it("drops stale link results when the draft was replaced mid-materialization", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { promise, resolve } = Promise.withResolvers<(string | undefined)[] | undefined>();
		editor.draftImageLinkMaterializer = () => promise;
		editor.setDraft("[Image #1]", [image]);
		editor.clearDraft();
		resolve(["/tmp/stale.png"]);
		await promise;
		expect(editor.imageLinks).toBeUndefined();
		expect(editor.pendingImageLinks).toEqual([]);
	});

	it("clearDraft resets text attachments and their numbering", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.insertTextAttachment("a\nb");
		expect(editor.pendingTexts).toHaveLength(1);
		editor.clearDraft();
		expect(editor.pendingTexts).toEqual([]);
		editor.insertTextAttachment("c");
		expect(editor.pendingTexts[0]?.n).toBe(1);
	});

	it("never recycles a deleted chip's number within one draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.insertTextAttachment("first");
		editor.setText("");
		editor.insertTextAttachment("second");
		expect(editor.pendingTexts.map(t => t.n)).toEqual([1, 2]);
		// Only the surviving token's chip is visible.
		const chips = editor.composerChips();
		expect(chips).toHaveLength(1);
		expect(chips[0]).toMatchObject({ kind: "paste", n: 2 });
	});
});

describe("cleared draft recall", () => {
	it("recalls an image-only draft as a live, atomically deletable chip", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.addToHistory("earlier prompt");
		editor.setDraft("[Image #1]", [image]);
		editor.clearDraftForRecall();
		expect(editor.pendingImages).toEqual([]);

		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe("[Image #1]");
		expect(editor.composerChips()).toEqual([{ kind: "image", n: 1, image, link: undefined }]);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("earlier prompt");
		expect(editor.pendingImages).toEqual([]);
		editor.handleInput("\x1b[B");
		expect(editor.getExpandedText()).toBe("[Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		editor.handleInput("\x7f"); // Down recalls at the end, after the chip.
		expect(editor.getExpandedText()).toBe("");
		expect(editor.composerChips()).toEqual([]);
	});

	it("keeps the saved attachment snapshot intact across repeated recall and mutation", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.insertTextAttachment("original payload");
		editor.clearDraftForRecall();

		for (const addition of ["first edit", "second edit"]) {
			editor.handleInput("\x1b[A");
			expect(editor.getExpandedText()).toBe("original payload ");
			editor.handleInput("\x05");
			editor.insertTextAttachment(addition);
			expect(editor.getExpandedText()).toBe("original payload " + addition + " ");
			expect(editor.composerChips().map(chip => chip.n)).toEqual([1, 2]);
			editor.clearDraft();
		}
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe("original payload ");
		expect(editor.pendingTexts.map(text => text.content)).toEqual(["original payload"]);
	});

	it("recalls an unsent multiline draft without trimming it or submitting it", () => {
		const editor = new CustomEditor(getEditorTheme());
		const submitted: string[] = [];
		editor.onSubmit = text => {
			submitted.push(text);
		};
		editor.setText("  first line\nsecond line  ");
		editor.clearDraftForRecall();
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("  first line\nsecond line  ");
		expect(submitted).toEqual([]);
	});

	it("restores image and paste payloads without leaking them into other history entries", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("inspect [Image #1] ", [image]);
		editor.insertTextAttachment("first\nsecond");
		const expanded = editor.getExpandedText();
		editor.clearDraftForRecall();
		editor.setText("unrelated prompt");
		editor.clearDraftForRecall();
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe("unrelated prompt");
		expect(editor.pendingImages).toEqual([]);
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe(expanded);
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.composerChips().map(chip => chip.kind)).toEqual(["image", "paste"]);
		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("unrelated prompt");
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingTexts).toEqual([]);
	});

	it("does not submit a canceled image with another history entry after editing the recalled draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("canceled [Image #1]", [image]);
		editor.clearDraftForRecall();
		editor.addToHistory("different [Image #1]");
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");
		expect(editor.pendingImages).toEqual([image]);
		editor.handleInput("\x05");
		editor.handleInput("\x15"); // Delete the recalled text without clearing its attachment state.
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("different [Image #1]");
		const submitted: { text: string; images: ImageContent[] }[] = [];
		editor.onSubmit = text => {
			submitted.push({ text, images: [...editor.pendingImages] });
		};
		editor.handleInput("\r");
		expect(submitted).toEqual([{ text: "different [Image #1]", images: [] }]);
	});

	it("does not expand another history entry with paste payloads from an edited recalled draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.insertTextAttachment("canceled text attachment");
		editor.insertPaste("canceled legacy paste");
		const otherPrompt = `different ${editor.getText()}`.trim();
		editor.clearDraftForRecall();
		editor.addToHistory(otherPrompt);
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");
		editor.handleInput("\x05");
		editor.handleInput("\x15");
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe(otherPrompt);
		const submitted: string[] = [];
		editor.onSubmit = text => {
			submitted.push(text);
		};
		editor.handleInput("\r");
		expect(submitted).toEqual([otherPrompt]);
		expect(editor.pendingTexts).toEqual([]);
	});

	for (const transition of ["discard", "submit", "replace"] as const) {
		it(`preserves a fresh image during normal history recall after ${transition} of a recalled draft`, () => {
			const editor = new CustomEditor(getEditorTheme());
			editor.setDraft("canceled [Image #1]", [image]);
			editor.clearDraftForRecall();
			editor.handleInput("\x1b[A");
			if (transition === "discard") editor.clearDraft();
			if (transition === "submit") editor.handleInput("\r");
			const freshImage: ImageContent = { ...image, data: "ZnJlc2g=" };
			if (transition === "replace") {
				editor.setDraft("fresh [Image #1]", [freshImage]);
			} else {
				editor.pendingImages = [freshImage];
				editor.setCollapsedText("fresh [Image #1]");
			}
			editor.addToHistory("submitted [Image #1]");
			editor.handleInput("\x05");
			editor.handleInput("\x15");
			editor.handleInput("\x1b[A");
			const submitted: { text: string; images: ImageContent[] }[] = [];
			editor.onSubmit = text => {
				submitted.push({ text, images: [...editor.pendingImages] });
			};
			editor.handleInput("\r");
			expect(submitted).toEqual([{ text: "submitted [Image #1]", images: [freshImage] }]);
		});
	}

	it("does not persist canceled drafts or hide prior history behind empty clears", () => {
		const written: string[] = [];
		const editor = new CustomEditor(getEditorTheme());
		editor.setHistoryStorage({
			add: async text => {
				written.push(text);
			},
			getRecent: () => [{ prompt: "submitted earlier" }],
		});
		editor.setText("unsent private draft");
		editor.clearDraftForRecall();
		editor.clearDraftForRecall();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("unsent private draft");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("submitted earlier");
		expect(written).toEqual([]);
	});

	it("does not retain evicted legacy pastes in newer drafts", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.insertPaste("old payload");
		const marker = editor.getText();
		editor.clearDraftForRecall();
		for (let index = 0; index < 100; index++) {
			editor.setText("draft " + index);
			editor.clearDraftForRecall();
		}
		editor.handleInput("\x1b[A");
		editor.setText(marker);
		expect(editor.getExpandedText()).toBe(marker);
	});

	it("rematerializes missing attachment links after a canceled restore", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const first = Promise.withResolvers<(string | undefined)[]>();
		const second = Promise.withResolvers<(string | undefined)[]>();
		let calls = 0;
		editor.draftImageLinkMaterializer = () => (++calls === 1 ? first.promise : second.promise);
		editor.setDraft("[Image #1]", [image]);
		editor.clearDraftForRecall();
		first.resolve(["file:///tmp/image.png"]);
		await first.promise;
		editor.handleInput("\x1b[A");
		second.resolve(["file:///tmp/image.png"]);
		await second.promise;
		expect(editor.composerChips()).toEqual([{ kind: "image", n: 1, image, link: "file:///tmp/image.png" }]);
	});
});

describe("cleared draft recovery preference", () => {
	it("respects disabling and re-enabling recovery without replacing the editor", () => {
		const editor = new CustomEditor(getEditorTheme());
		const settings = Settings.isolated();
		const helpers = new UiHelpers({
			editor,
			settings,
			ui: { requestRender() {} },
		} as unknown as InteractiveModeContext);
		editor.addToHistory("submitted earlier");
		editor.setText("recovered by default");
		helpers.clearEditor();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recovered by default");
		settings.set("composer.recallClearedDrafts", false);
		editor.setDraft("discard [Image #1]", [image]);
		helpers.clearEditor();
		expect(editor.getText()).toBe("");
		expect(editor.pendingImages).toEqual([]);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recovered by default");
		expect(editor.pendingImages).toEqual([]);
		settings.set("composer.recallClearedDrafts", true);
		editor.setText("recovered again");
		helpers.clearEditor();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recovered again");
	});
});
