import { beforeAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { chipLabel } from "@oh-my-pi/pi-coding-agent/modes/composer-attachments";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

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
