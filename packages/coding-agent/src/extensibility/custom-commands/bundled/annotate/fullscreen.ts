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
import { refreshReviewTarget } from "../review";
import { prepareReviewTarget } from "../review/prompt";
import { getReviewTargetIssue, type ResolvedReviewTarget } from "../review/target";
import { readFileTextReviewSource } from "./direct-source";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
	TextReviewSourceProvenance,
} from "./annotation-types";
import {
	annotationDraftKey,
	type AnnotationDraft,
	type AnnotationDraftSource,
	loadAnnotationDrafts,
	type OpenAnnotationDraft,
	openAnnotationDraft,
} from "./draft-store";

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
	source: TextReviewSource,
): Promise<void> {
	const editor = requireEditor();
	const current = review.textSourceText() ?? source.text;
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
	if (next !== null && next !== current) notifyDroppedTextNotes(ctx, review.replaceTextSource(next));
}

function notifyDroppedTextNotes(ctx: AnnotationOverlayContext, dropped: number): void {
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

type AnnotationReviewResult = CodeReviewOverlayResult | TextReviewOverlayResult;
type Reload = { kind: "reload"; source: AnnotationDraftSource; saved: AnnotationDraft | null };
type ReviewDone = { kind: "done"; source: AnnotationDraftSource; result: AnnotationReviewResult | undefined };

function reviewInput(source: AnnotationDraftSource): AnnotationReviewInput {
	return source.kind === "diff"
		? { kind: "diff", files: source.target.snapshot.files, mode: source.target.mode }
		: { kind: "text", source: source.source };
}

function canReloadSource(source: AnnotationDraftSource): boolean {
	return source.kind === "diff"
		? source.target.refreshSource !== undefined
		: source.source.provenance?.kind === "file";
}

async function reloadSource(
	ctx: AnnotationOverlayContext,
	review: AnnotationReviewModel,
	current: AnnotationDraftSource,
	complete: (transition: Reload) => void,
): Promise<void> {
	let source: AnnotationDraftSource;
	let message: string | undefined;
	let changed: boolean;
	if (current.kind === "diff") {
		const target = await refreshReviewTarget(current.target);
		if (review.finished) return;
		changed = current.target.rawDiff !== target.rawDiff;
		source = changed ? { kind: "diff", target, focus: current.focus } : current;
		if (changed) message = getReviewTargetIssue(target);
	} else {
		const provenance = current.source.provenance;
		if (provenance?.kind !== "file") return;
		const refreshed = await readFileTextReviewSource(
			provenance.path,
			ctx.sessionManager.getCwd?.() ?? ctx.cwd,
			current.source.sessionId ?? ctx.sessionManager.getSessionId(),
		);
		if (review.finished) return;
		changed = (review.textSourceText() ?? current.source.text) !== refreshed.text;
		source = { kind: "text", source: { ...current.source, text: refreshed.text } };
		if (changed && !refreshed.text) message = "The annotation file is now empty.";
	}

	if (review.finished || !(await review.confirmDiscardForRefresh(changed)) || review.finished) return;
	const key = changed ? annotationDraftKey(source) : undefined;
	// Look up the destination before closing the pane; a failed lookup leaves its draft intact.
	const saved =
		key !== undefined && key !== annotationDraftKey(current)
			? ((await loadAnnotationDrafts(ctx.sessionManager)).find(draft => draft.key === key) ?? null)
			: null;
	if (review.finished) return;
	complete({ kind: "reload", source, saved });
	if (message) ctx.ui.notify(message, "info");
}

/** Mount one source until the operator closes, submits, or confirms a reload. */
async function showAnnotationReview(
	ctx: AnnotationOverlayContext,
	mountedSource: AnnotationDraftSource,
	draft: OpenAnnotationDraft,
): Promise<Reload | ReviewDone> {
	let review: AnnotationReviewModel | undefined;
	let source = mountedSource;
	try {
		const outcome = await ctx.ui.custom<Reload | AnnotationReviewResult | undefined>(
			(ui, _theme, keybindings, done) => {
				const editSource = () => {
					if (mountedSource.kind === "diff") {
						const target = mountedSource.target;
						if (target.kind !== "pr" && target.kind !== "patch") {
							return () => editReviewedFile(ui, ctx, review!, target.repository);
						}
					} else {
						const text = mountedSource.source;
						const provenance = text.provenance;
						if (provenance?.kind === "file" || provenance?.kind === "prompt") {
							return () => editTextSource(ui, ctx, review!, provenance, text);
						}
					}
					return undefined;
				};
				const callbacks: AnnotationReviewCallbacks = {
					onComplete: done,
					onWarning: message => ctx.ui.notify(message, "warning"),
					onAnnotationExternalEditor: (text, commit) => editAnnotationDraft(ui, text, commit),
					onRefresh: canReloadSource(mountedSource)
						? () => reloadSource(ctx, review!, mountedSource, done)
						: undefined,
					onExternalEditor: editSource(),
					onBeforeReview: () => {
						if (source.kind !== "diff") return undefined;
						try {
							const target = prepareReviewTarget(source.target);
							if (target !== source.target) source = { ...source, target };
							return undefined;
						} catch (error) {
							return error instanceof Error ? error.message : String(error);
						}
					},
				};
				review = new AnnotationReviewModel(
					reviewInput(mountedSource),
					callbacks,
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
		return outcome && "kind" in outcome ? outcome : { kind: "done", source, result: outcome };
	} finally {
		review?.dispose();
	}
}

async function runAnnotationReview(
	ctx: AnnotationOverlayContext,
	initial: AnnotationDraftSource,
	resumed: AnnotationDraft | undefined,
): Promise<ReviewDone> {
	let source = initial;
	let draft = await openAnnotationDraft(ctx.sessionManager, source, resumed);
	if (draft.restored && !resumed) ctx.ui.notify("Restored the saved annotation draft.", "info");

	while (true) {
		let outcome: Reload | ReviewDone;
		try {
			outcome = await showAnnotationReview(ctx, source, draft);
		} catch (error) {
			await draft
				.close(undefined)
				.catch(closeError => ctx.ui.notify(`Could not save the annotation draft: ${closeError}`, "warning"));
			throw error;
		}

		if (outcome.kind === "reload") {
			// A confirmed reload discards the old source, even when its notes still happen to anchor.
			await draft.close({ action: "refresh" });
			source = outcome.source;
			draft = await openAnnotationDraft(ctx.sessionManager, source, outcome.saved);
			if (draft.restored) ctx.ui.notify("Restored the saved annotation draft.", "info");
			continue;
		}

		await draft
			.close(outcome.result)
			.catch(error => ctx.ui.notify(`Could not save the annotation draft: ${error}`, "warning"));
		return outcome;
	}
}

/** Mount a frozen diff in the review overlay, resuming its saved draft. */
export async function showCodeReviewOverlay(
	ctx: AnnotationOverlayContext,
	target: ResolvedReviewTarget,
	focus?: string,
	resumed?: AnnotationDraft,
): Promise<(CodeReviewOverlayResult & { refreshedTarget?: ResolvedReviewTarget }) | undefined> {
	const outcome = await runAnnotationReview(ctx, { kind: "diff", target, focus }, resumed);
	if (outcome.source.kind !== "diff" || !outcome.result) return undefined;
	const result = outcome.result as CodeReviewOverlayResult;
	return outcome.source.target !== target ? { ...result, refreshedTarget: outcome.source.target } : result;
}

/** Mount a frozen text source in the same annotation review, resuming its saved draft. */
export async function showTextReviewOverlay(
	ctx: AnnotationOverlayContext,
	source: TextReviewSource,
	resumed?: AnnotationDraft,
): Promise<TextReviewOverlayResult | undefined> {
	const outcome = await runAnnotationReview(ctx, { kind: "text", source }, resumed);
	if (!outcome.result) return undefined;
	const result = outcome.result as TextReviewOverlayResult;
	if (outcome.source.kind !== "text") return result;
	return result.editedText === undefined && outcome.source.source.text !== source.text
		? { ...result, editedText: outcome.source.source.text }
		: result;
}
