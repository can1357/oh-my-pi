import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
	TextReviewSourceProvenance,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import type { ResolvedReviewTarget } from "../review/target";
import { getEditorCommand, openEditorOnPath, openInEditor } from "../../../../utils/external-editor";

/** What the overlay host reads: the UI surface plus the live session cwd for editor paths. */
export type AnnotationOverlayContext = Pick<CustomCommandContext, "ui" | "cwd" | "sessionManager">;

const ANNOTATION_OVERLAY_OPTIONS = {
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
	mouseTracking: false,
} as const;

const MISSING_EDITOR = "Set $VISUAL or $EDITOR to edit in an external editor.";

function requireEditor(): string {
	const editor = getEditorCommand();
	if (!editor) throw new Error(MISSING_EDITOR);
	return editor;
}

async function editAnnotationDraft(tui: TUI, draft: string, commit: (text: string | null) => void): Promise<void> {
	const editor = requireEditor();
	tui.stop();
	try {
		commit(await openInEditor(editor, draft, { extension: ".md" }));
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

/**
 * Only sources whose full text reaches the prompt may be edited: a file (written back in
 * place) or a typed prompt. Session messages are omitted or summarized in the prompt, so
 * notes on edited session text would quote lines the model never sees.
 */
type EditableProvenance = Extract<TextReviewSourceProvenance, { kind: "file" } | { kind: "prompt" }>;

async function editTextSource(
	tui: TUI,
	ctx: AnnotationOverlayContext,
	overlay: AnnotationOverlay,
	provenance: EditableProvenance,
): Promise<void> {
	const editor = requireEditor();
	const current = overlay.textSourceText() ?? "";
	tui.stop();
	let next: string | null;
	let exitCode = 0;
	try {
		if (provenance.kind === "file") {
			exitCode = await openEditorOnPath(editor, provenance.path);
			next = await Bun.file(provenance.path).text();
		} else {
			next = await openInEditor(editor, current, { extension: ".txt", trimTrailingNewline: false });
		}
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	if (exitCode !== 0) ctx.ui.notify(`Editor exited with code ${exitCode}; using what it saved.`, "warning");
	if (next === null || next === current) return;
	const dropped = overlay.replaceTextSource(next);
	if (dropped > 0) {
		ctx.ui.notify(
			dropped === 1
				? "Dropped 1 line note that no longer matches the edited text."
				: `Dropped ${dropped} line notes that no longer match the edited text.`,
			"warning",
		);
	}
}

async function editReviewedFile(tui: TUI, ctx: AnnotationOverlayContext, overlay: AnnotationOverlay): Promise<void> {
	const relative = overlay.reviewFilePath();
	if (!relative) throw new Error("No file to open.");
	const editor = requireEditor();
	// Diff paths are repository-relative and exact, so resolve them from the repo root, not the session cwd.
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const absolute = path.resolve(vcs.repo(cwd)?.root() ?? cwd, relative);
	if (!(await Bun.file(absolute).exists())) {
		throw new Error(`${relative} is not on disk. The review still uses the frozen diff.`);
	}
	tui.stop();
	let exitCode: number;
	try {
		exitCode = await openEditorOnPath(editor, absolute);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	if (exitCode !== 0) ctx.ui.notify(`Editor exited with code ${exitCode}.`, "warning");
	ctx.ui.notify(`Opened ${relative}. The review still uses the frozen diff.`, "info");
}

/** Mount the frozen diff in the TUI overlay surface owned by the command host. */
export function showCodeReviewOverlay(
	ctx: AnnotationOverlayContext,
	target: ResolvedReviewTarget,
): Promise<CodeReviewOverlayResult | undefined> {
	return ctx.ui.custom<CodeReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const overlay: AnnotationOverlay = new AnnotationOverlay(
				tui,
				theme,
				keybindings,
				target.snapshot.files,
				target.mode,
				{
					onComplete: done,
					onWarning: message => ctx.ui.notify(message, "warning"),
					onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
					// PR and caller-supplied diffs need not match the local checkout, so only local reviews open the working-tree file.
					onExternalEditor:
						target.kind === "pr" || target.kind === "patch"
							? undefined
							: () => editReviewedFile(tui, ctx, overlay),
				},
			);
			return overlay;
		},
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}

/** Mount a frozen text source in the same annotation overlay UX. */
export function showTextReviewOverlay(
	ctx: AnnotationOverlayContext,
	source: TextReviewSource,
): Promise<TextReviewOverlayResult | undefined> {
	return ctx.ui.custom<TextReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const provenance = source.provenance;
			const editable = provenance?.kind === "file" || provenance?.kind === "prompt" ? provenance : undefined;
			const overlay: AnnotationOverlay = new AnnotationOverlay(tui, theme, keybindings, source, {
				onComplete: done,
				onWarning: message => ctx.ui.notify(message, "warning"),
				onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
				onExternalEditor: editable ? () => editTextSource(tui, ctx, overlay, editable) : undefined,
			});
			return overlay;
		},
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}
