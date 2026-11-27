import type { ImageContent } from "@oh-my-pi/pi-ai";
import { shiftImageMarkers } from "../../modes/view-model/prompt/composer-attachments";
import type { Composer } from "../../ui/composer/composer";
import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "../types";

/** Clear only text still owned by this submission, never a newer detached draft. */
export function clearSubmittedText(runtime: TuiSlashCommandRuntime): void {
	if (!runtime.draftDetached) runtime.ctx.composer.setText("");
}

/**
 * Return a submission that already left the editor without replacing a draft
 * typed while it awaited dispatch: its attachments append after the newer
 * draft's, its `[Image #N]` markers shift to match, and its text goes first.
 */
export function restoreDetachedDraft(
	composer: Composer,
	text: string,
	images?: ImageContent[],
	imageLinks?: (string | undefined)[],
): void {
	const currentText = composer.expandedText();
	const restoredText = shiftImageMarkers(text, composer.pendingImages.length);
	if (images?.length) {
		composer.pendingImages.push(...images);
		composer.pendingImageLinks.push(...(imageLinks ?? images.map(() => undefined)));
	}
	composer.setCollapsedText([restoredText, currentText].filter(part => part.trim()).join("\n\n"));
}

/** A text-only command gives a draft with images back instead of running without them; returns whether it refused. */
export function refuseImages(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): boolean {
	const images = runtime.input?.images;
	if (!images?.length) return false;
	restoreDetachedDraft(runtime.ctx.composer, command.text, images, runtime.input?.imageLinks);
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
	const { composer } = runtime.ctx;
	if (!runtime.draftDetached) composer.clearDraft();
	try {
		const submitted = await run();
		const hasAttachments = (runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0;
		if (submitted || !(hasAttachments || options?.restoreText)) return;
		if (runtime.draftDetached || options?.restoreText) {
			// Newer typing may already sit in the editor: merge the submission
			// back beside it so each draft's image markers keep their images.
			restoreDetachedDraft(composer, command.text, runtime.input?.images, runtime.input?.imageLinks);
			return;
		}
		composer.pendingImages.unshift(...(runtime.input?.images ?? []));
		composer.pendingImageLinks.unshift(
			...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
		);
	} catch (error) {
		if (runtime.draftDetached) {
			// The caller already took this draft out of the editor before
			// dispatch (Ctrl+Enter's `handleFollowUp`, or `onSubmit` for these
			// commands); it owns restoring the submission and reporting the
			// error so a submission that failed after newer text was typed
			// merges with it once, instead of being silently dropped here.
			throw error;
		}
		if (!composer.text() && composer.pendingImages.length === 0) {
			composer.setText(command.text);
			composer.pendingImages.push(...(runtime.input?.images ?? []));
			composer.pendingImageLinks.push(...(runtime.input?.imageLinks ?? []));
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
