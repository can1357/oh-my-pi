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

type DiffAnnotationDraftSource = Extract<AnnotationDraftSource, { kind: "diff" }>;
type TextAnnotationDraftSource = Extract<AnnotationDraftSource, { kind: "text" }>;

type RefreshHandoff<Source> = {
	readonly action: "refresh";
	readonly source: Source;
	readonly saved: AnnotationDraft | null;
};

function isRefreshHandoff<Source, Result extends { action: string }>(
	outcome: Result | RefreshHandoff<Source> | undefined,
): outcome is RefreshHandoff<Source> {
	return outcome?.action === "refresh" && "source" in outcome;
}

async function confirmSourceRefresh<Source extends AnnotationDraftSource>(
	ctx: AnnotationOverlayContext,
	review: AnnotationReviewModel,
	current: Source,
	source: Source,
	completeRefresh: (handoff: RefreshHandoff<Source>) => void,
): Promise<boolean> {
	if (review.finished || !(await review.confirmDiscardForRefresh()) || review.finished) return false;
	const key = annotationDraftKey(source);
	// Read the destination while the old pane is still open: a lookup failure is a canceled refresh.
	const saved =
		key === annotationDraftKey(current)
			? null
			: ((await loadAnnotationDrafts(ctx.sessionManager)).find(draft => draft.key === key) ?? null);
	if (review.finished) return false;
	completeRefresh({ action: "refresh", source, saved });
	return true;
}

async function refreshDiffSource(
	ctx: AnnotationOverlayContext,
	review: AnnotationReviewModel,
	source: DiffAnnotationDraftSource,
	completeRefresh: (handoff: RefreshHandoff<DiffAnnotationDraftSource>) => void,
): Promise<void> {
	const refreshed = await refreshReviewTarget(source.target);
	if (review.finished || source.target.rawDiff === refreshed.rawDiff) return;
	const nextSource: DiffAnnotationDraftSource = {
		kind: "diff",
		target: refreshed,
		focus: source.focus,
	};
	if (await confirmSourceRefresh(ctx, review, source, nextSource, completeRefresh)) {
		const issue = getReviewTargetIssue(refreshed);
		if (issue) ctx.ui.notify(issue, "info");
	}
}

async function refreshTextFileSource(
	ctx: AnnotationOverlayContext,
	review: AnnotationReviewModel,
	source: TextAnnotationDraftSource,
	path: string,
	completeRefresh: (handoff: RefreshHandoff<TextAnnotationDraftSource>) => void,
): Promise<void> {
	const refreshed = await readFileTextReviewSource(
		path,
		ctx.sessionManager.getCwd?.() ?? ctx.cwd,
		source.source.sessionId ?? ctx.sessionManager.getSessionId(),
	);
	if (review.finished || review.textSourceText() === refreshed.text) return;
	const nextSource: TextAnnotationDraftSource = {
		kind: "text",
		source: { ...source.source, text: refreshed.text },
	};
	if ((await confirmSourceRefresh(ctx, review, source, nextSource, completeRefresh)) && !refreshed.text) {
		ctx.ui.notify("The annotation file is now empty.", "info");
	}
}

/**
 * Show the annotation review fullscreen until it completes, resuming `draft`'s saved notes.
 * `callbacks` builds the review's host callbacks once the model exists.
 */
async function showAnnotationReview<Result extends { action: string }, Source>(
	ctx: AnnotationOverlayContext,
	input: AnnotationReviewInput,
	draft: OpenAnnotationDraft,
	callbacks: (
		ui: ExtensionUiHost,
		review: () => AnnotationReviewModel,
		completeRefresh: (handoff: RefreshHandoff<Source>) => void,
	) => Omit<AnnotationReviewCallbacks, "onComplete">,
): Promise<Result | RefreshHandoff<Source> | undefined> {
	let review: AnnotationReviewModel | undefined;
	try {
		return await ctx.ui.custom<Result | RefreshHandoff<Source> | undefined>(
			(ui, _theme, keybindings, done) => {
				review = new AnnotationReviewModel(
					input,
					{
						...callbacks(ui, () => review!, done),
						onComplete: result => done(result as Result | undefined),
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

async function runAnnotationReview<Source extends AnnotationDraftSource, Result extends { action: string }>(
	ctx: AnnotationOverlayContext,
	initialSource: Source,
	resumed: AnnotationDraft | undefined,
	mount: (source: Source, draft: OpenAnnotationDraft) => Promise<Result | RefreshHandoff<Source> | undefined>,
): Promise<{ source: Source; result: Result | undefined }> {
	let source = initialSource;
	let draft = await openAnnotationDraft(ctx.sessionManager, source, resumed);
	if (draft.restored && !resumed) ctx.ui.notify("Restored the saved annotation draft.", "info");

	while (true) {
		let outcome: Result | RefreshHandoff<Source> | undefined;
		try {
			outcome = await mount(source, draft);
		} catch (error) {
			await draft
				.close(undefined)
				.catch(closeError => ctx.ui.notify(`Could not save the annotation draft: ${closeError}`, "warning"));
			throw error;
		}

		if (isRefreshHandoff<Source, Result>(outcome)) {
			// "refresh" explicitly drops this source without saving any notes, even if they still anchor.
			await draft.close(outcome);
			source = outcome.source;
			draft = await openAnnotationDraft(ctx.sessionManager, source, outcome.saved);
			if (draft.restored) ctx.ui.notify("Restored the saved annotation draft.", "info");
			continue;
		}

		await draft
			.close(outcome)
			.catch(error => ctx.ui.notify(`Could not save the annotation draft: ${error}`, "warning"));
		return { source, result: outcome };
	}
}

/** Mount a frozen diff in the review overlay, resuming its saved draft. */
export async function showCodeReviewOverlay(
	ctx: AnnotationOverlayContext,
	target: ResolvedReviewTarget,
	focus?: string,
	resumed?: AnnotationDraft,
): Promise<(CodeReviewOverlayResult & { refreshedTarget?: ResolvedReviewTarget }) | undefined> {
	const initialSource: DiffAnnotationDraftSource = { kind: "diff", target, focus };
	const { source, result } = await runAnnotationReview<DiffAnnotationDraftSource, CodeReviewOverlayResult>(
		ctx,
		initialSource,
		resumed,
		(currentSource, draft) =>
			showAnnotationReview<CodeReviewOverlayResult, DiffAnnotationDraftSource>(
				ctx,
				{ kind: "diff", files: currentSource.target.snapshot.files, mode: currentSource.target.mode },
				draft,
				(ui, review, completeRefresh) => ({
					onAnnotationExternalEditor: (text, commit) => editAnnotationDraft(ui, text, commit),
					onRefresh: currentSource.target.refreshSource
						? () => refreshDiffSource(ctx, review(), currentSource, completeRefresh)
						: undefined,
					// PR and caller-supplied diffs need not match the local checkout, so only local reviews open the working-tree file.
					onExternalEditor:
						currentSource.target.kind === "pr" || currentSource.target.kind === "patch"
							? undefined
							: () => editReviewedFile(ui, ctx, review(), currentSource.target.repository),
				}),
			),
	);
	return result && source.target !== target ? { ...result, refreshedTarget: source.target } : result;
}

/** Mount a frozen text source in the same annotation review, resuming its saved draft. */
export async function showTextReviewOverlay(
	ctx: AnnotationOverlayContext,
	source: TextReviewSource,
	resumed?: AnnotationDraft,
): Promise<TextReviewOverlayResult | undefined> {
	const { source: finalSource, result } = await runAnnotationReview<
		TextAnnotationDraftSource,
		TextReviewOverlayResult
	>(ctx, { kind: "text", source }, resumed, (currentSource, draft) => {
		const provenance = currentSource.source.provenance;
		const editable = provenance?.kind === "file" || provenance?.kind === "prompt" ? provenance : undefined;
		return showAnnotationReview<TextReviewOverlayResult, TextAnnotationDraftSource>(
			ctx,
			{ kind: "text", source: currentSource.source },
			draft,
			(ui, review, completeRefresh) => ({
				onAnnotationExternalEditor: (text, commit) => editAnnotationDraft(ui, text, commit),
				onRefresh:
					provenance?.kind === "file"
						? () => refreshTextFileSource(ctx, review(), currentSource, provenance.path, completeRefresh)
						: undefined,
				onExternalEditor: editable ? () => editTextSource(ui, ctx, review(), editable) : undefined,
			}),
		);
	});
	if (!result) return undefined;
	return result.editedText === undefined && finalSource.source.text !== source.text
		? { ...result, editedText: finalSource.source.text }
		: result;
}
