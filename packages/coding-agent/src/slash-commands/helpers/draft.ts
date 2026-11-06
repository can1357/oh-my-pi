import type { ImageContent } from "@oh-my-pi/pi-ai";
import { shiftImageMarkers } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import type { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "../types";

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

/**
 * Merge explicit queued entries, oldest first, ahead of the current draft.
 * Existing draft images keep their positions; queued attachments append.
 */
export function restoreQueuedDraft(
	editor: CustomEditor,
	entries: readonly RestoredQueuedMessage[],
	currentText?: string,
): number {
	if (entries.length === 0) return 0;
	// Image markers are positional: `[Image #N]` ↔ `pendingImages[N-1]`
	// (legacy drafts may still carry a trailing `attachment://N`). Each queued
	// message numbered its references against its own local image list
	// (1..K). Because we prepend the queued text but append the queued images
	// to `pendingImages`, any existing draft images (M of them) — plus images
	// already pulled in by earlier queued messages — shift the slot index that
	// every reference must point to. Bumping each message's marker and URI
	// indices by the running offset keeps the merged text aligned with the merged
	// `pendingImages` order; draft markers stay valid because draft images
	// keep their original positions.
	const queuedImages = entries.flatMap(entry => entry.images ?? []);
	let queuedText: string;
	if (queuedImages.length > 0) {
		const parts: string[] = [];
		let imageOffset = editor.pendingImages.length;
		for (const entry of entries) {
			parts.push(shiftImageMarkers(entry.text, imageOffset));
			if (entry.images?.length) imageOffset += entry.images.length;
		}
		queuedText = parts.join("\n\n");
	} else {
		queuedText = entries.map(entry => entry.text).join("\n\n");
	}
	const current = currentText ?? editor.getText();
	const combinedText = [queuedText, current].filter(text => text.trim()).join("\n\n");
	// Hand queued images back to the pending-image buffer first (links are
	// re-materialized lazily), then set the text: setCollapsedText folds the
	// renumbered `[Image #N, WxH]` references back into chip tokens, and the
	// collapse only recognizes indices within the merged pendingImages range.
	if (queuedImages.length > 0) {
		editor.pendingImages.push(...queuedImages);
		editor.pendingImageLinks.push(...queuedImages.map(() => undefined));
		editor.imageLinks = editor.pendingImageLinks;
	}
	editor.setCollapsedText(combinedText);
	return entries.length;
}

/** A text-only command gives a draft with images back instead of running without them; returns whether it refused. */
export function refuseImages(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): boolean {
	const images = runtime.input?.images;
	if (!images?.length) return false;
	restoreDetachedDraft(runtime.ctx.editor, command.text, images, runtime.input?.imageLinks);
	runtime.ctx.showWarning(`/${command.name} takes text only; remove the images to run it`);
	return true;
}

/**
 * Run a command that takes its whole draft, images included. An unsent draft gets
 * its attachments back, and with `restoreText` its text too; a `run` that throws on
 * a detached draft is left to the caller, which already took the draft out.
 */
export async function runWithDetachedDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
	options?: { restoreText?: boolean },
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		const hasAttachments = (runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0;
		if (submitted || !(hasAttachments || options?.restoreText)) return;
		if (runtime.draftDetached || options?.restoreText) {
			// Newer typing may already sit in the editor: merge the submission
			// back beside it so each draft's image markers keep their images.
			restoreDetachedDraft(editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
			return;
		}
		editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
		editor.pendingImageLinks = [
			...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
			...editor.pendingImageLinks,
		];
		editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
	} catch (error) {
		if (runtime.draftDetached) {
			// The caller already took this draft out of the editor before
			// dispatch (Ctrl+Enter's `handleFollowUp`, or `onSubmit` for these
			// commands); it owns restoring the submission and reporting the
			// error so a submission that failed after newer text was typed
			// merges with it once, instead of being silently dropped here.
			throw error;
		}
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
