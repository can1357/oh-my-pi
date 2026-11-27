import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { jsx, nativeRendering } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { KeybindingsManager } from "../../../../config/keybindings/keybindings";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import type { ExtensionUiHost } from "../../../../extensibility/extensions/render-types";
import { AnnotationReview, annotationReviewSheet } from "../../../../ui/overlays/panels/annotation-review";
import { sheetView } from "../../../../ui/overlays/sheet";
import {
	type AnnotationReviewCallbacks,
	type AnnotationReviewInput,
	AnnotationReviewModel,
	type AnnotationReviewOptions,
} from "../../../../ui/overlays/panels/annotation-review-model";
import { getEditorCommand, openEditorOnPath, openInEditor } from "../../../../utils/external-editor";
import type { ResolvedReviewTarget } from "../review/target";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
	TextReviewSourceProvenance,
} from "./annotation-types";
import { type AnnotationDraft, type OpenAnnotationDraft, openAnnotationDraft } from "./draft-store";

/** What the overlay host reads: the UI surface plus the live session cwd for editor paths. */
export type AnnotationOverlayContext = Pick<CustomCommandContext, "ui" | "cwd" | "sessionManager">;

const MISSING_EDITOR = "Set $VISUAL or $EDITOR to edit in an external editor.";

function requireEditor(): string {
	const editor = getEditorCommand();
	if (!editor) throw new Error(MISSING_EDITOR);
	return editor;
}

async function editAnnotationDraft(
	ui: ExtensionUiHost,
	draft: string,
	commit: (text: string | null) => void,
): Promise<void> {
	const editor = requireEditor();
	commit(await ui.suspend(() => openInEditor(editor, draft, { extension: ".md" })));
}

/**
 * Only sources whose full text reaches the prompt may be edited: a file (written back in
 * place) or a typed prompt. Session messages are omitted or summarized in the prompt, so
 * notes on edited session text would quote lines the model never sees.
 */
type EditableProvenance = Extract<TextReviewSourceProvenance, { kind: "file" } | { kind: "prompt" }>;

async function editTextSource(
	ui: ExtensionUiHost,
	ctx: AnnotationOverlayContext,
	review: AnnotationReviewModel,
	provenance: EditableProvenance,
): Promise<void> {
	const editor = requireEditor();
	const current = review.textSourceText() ?? "";
	const { next, exitCode } = await ui.suspend(async () => {
		if (provenance.kind === "file") {
			const exitCode = await openEditorOnPath(editor, provenance.path);
			return { next: await Bun.file(provenance.path).text(), exitCode };
		}
		return {
			next: await openInEditor(editor, current, { extension: ".txt", trimTrailingNewline: false }),
			exitCode: 0,
		};
	});
	if (exitCode !== 0) ctx.ui.notify(`Editor exited with code ${exitCode}; using what it saved.`, "warning");
	if (next === null || next === current) return;
	const dropped = review.replaceTextSource(next);
	if (dropped > 0) {
		ctx.ui.notify(
			dropped === 1
				? "Dropped 1 line note that no longer matches the edited text."
				: `Dropped ${dropped} line notes that no longer match the edited text.`,
			"warning",
		);
	}
}

async function editReviewedFile(
	ui: ExtensionUiHost,
	ctx: AnnotationOverlayContext,
	review: AnnotationReviewModel,
	repository: string | undefined,
): Promise<void> {
	const relative = review.reviewFilePath();
	if (!relative) throw new Error("No file to open.");
	const editor = requireEditor();
	// Diff paths are repository-relative and exact, so resolve them from the repo root, not the session cwd.
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const absolute = path.resolve(repository ?? vcs.repo(cwd)?.root() ?? cwd, relative);
	if (!(await Bun.file(absolute).exists())) {
		throw new Error(`${relative} is not on disk. The review still uses the frozen diff.`);
	}
	const exitCode = await ui.suspend(() => openEditorOnPath(editor, absolute));
	if (exitCode !== 0) ctx.ui.notify(`Editor exited with code ${exitCode}.`, "warning");
	ctx.ui.notify(`Opened ${relative}. The review still uses the frozen diff.`, "info");
}

/** The review's close and external-editor keys from the host keymap. */
function reviewKeys(keybindings: KeybindingsManager): AnnotationReviewOptions {
	return {
		cancelKey: keybindings.keysFor("tui.select.cancel")[0],
		externalEditorKey: keybindings.keysFor("app.editor.external")[0],
	};
}

/**
 * Show the annotation review fullscreen until it completes, resuming `draft`'s saved notes.
 * `callbacks` builds the review's host callbacks once the model exists.
 */
async function showAnnotationReview<T>(
	ctx: AnnotationOverlayContext,
	input: AnnotationReviewInput,
	draft: OpenAnnotationDraft,
	callbacks: (
		ui: ExtensionUiHost,
		review: () => AnnotationReviewModel,
	) => Omit<AnnotationReviewCallbacks, "onComplete">,
): Promise<T | undefined> {
	let review: AnnotationReviewModel | undefined;
	try {
		return await ctx.ui.custom<T | undefined>(
			(ui, _theme, keybindings, done) => {
				review = new AnnotationReviewModel(
					input,
					{
						...callbacks(ui, () => review!),
						onComplete: result => done(result as T | undefined),
						onWarning: message => ctx.ui.notify(message, "warning"),
					},
					{ theme: currentTheme, size: () => ui.size() },
					reviewKeys(keybindings),
				);
				draft.restore(review);
				return sheetView(
					nativeRendering(),
					annotationReviewSheet(review),
					jsx(AnnotationReview, { model: review }),
				);
			},
			{ overlay: true, fullscreen: true },
		);
	} finally {
		review?.dispose();
	}
}

/** Mount the frozen diff in the review overlay owned by the command host, resuming its saved draft. */
export async function showCodeReviewOverlay(
	ctx: AnnotationOverlayContext,
	target: ResolvedReviewTarget,
	focus?: string,
	resumed?: AnnotationDraft,
): Promise<CodeReviewOverlayResult | undefined> {
	const draft = await openAnnotationDraft(ctx.sessionManager, { kind: "diff", target, focus }, resumed);
	if (draft.restored && !resumed) ctx.ui.notify("Restored the saved annotation draft.", "info");
	const result = await showAnnotationReview<CodeReviewOverlayResult>(
		ctx,
		{ kind: "diff", files: target.snapshot.files, mode: target.mode },
		draft,
		(ui, review) => ({
			onAnnotationExternalEditor: (text, commit) => editAnnotationDraft(ui, text, commit),
			// PR and caller-supplied diffs need not match the local checkout, so only local reviews open the working-tree file.
			onExternalEditor:
				target.kind === "pr" || target.kind === "patch"
					? undefined
					: () => editReviewedFile(ui, ctx, review(), target.repository),
		}),
	);
	await draft.close(result).catch(error => ctx.ui.notify(`Could not save the annotation draft: ${error}`, "warning"));
	return result;
}

/** Mount a frozen text source in the same annotation review, resuming its saved draft. */
export async function showTextReviewOverlay(
	ctx: AnnotationOverlayContext,
	source: TextReviewSource,
	resumed?: AnnotationDraft,
): Promise<TextReviewOverlayResult | undefined> {
	const draft = await openAnnotationDraft(ctx.sessionManager, { kind: "text", source }, resumed);
	if (draft.restored && !resumed) ctx.ui.notify("Restored the saved annotation draft.", "info");
	const provenance = source.provenance;
	const editable = provenance?.kind === "file" || provenance?.kind === "prompt" ? provenance : undefined;
	const result = await showAnnotationReview<TextReviewOverlayResult>(
		ctx,
		{ kind: "text", source },
		draft,
		(ui, review) => ({
			onAnnotationExternalEditor: (text, commit) => editAnnotationDraft(ui, text, commit),
			onExternalEditor: editable ? () => editTextSource(ui, ctx, review(), editable) : undefined,
		}),
	);
	await draft.close(result).catch(error => ctx.ui.notify(`Could not save the annotation draft: ${error}`, "warning"));
	return result;
}
