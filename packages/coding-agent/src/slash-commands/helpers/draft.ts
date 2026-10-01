import type { ImageContent } from "@oh-my-pi/pi-ai";
import { shiftImageMarkers } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import type { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import type { TuiSlashCommandRuntime } from "../types";

/** Clear only text still owned by this submission, never a newer detached draft. */
export function clearSubmittedText(runtime: TuiSlashCommandRuntime): void {
	if (!runtime.draftDetached) runtime.ctx.editor.setText("");
}

/**
 * Return a submission that already left the editor without replacing a draft
 * typed while it awaited dispatch: its attachments append after the newer
 * draft's, its `[Image #N]` markers shift to match, and its text goes first.
 */
export function restoreDetachedDraft(
	editor: CustomEditor,
	text: string,
	images?: ImageContent[],
	imageLinks?: (string | undefined)[],
): void {
	const currentText = editor.getExpandedText();
	const restoredText = shiftImageMarkers(text, editor.pendingImages.length);
	if (images?.length) {
		editor.pendingImages.push(...images);
		editor.pendingImageLinks.push(...(imageLinks ?? images.map(() => undefined)));
		editor.imageLinks = editor.pendingImageLinks;
	}
	editor.setCollapsedText([restoredText, currentText].filter(part => part.trim()).join("\n\n"));
}
