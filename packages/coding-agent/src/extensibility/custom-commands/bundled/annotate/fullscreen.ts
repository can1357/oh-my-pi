import type { TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import type { ResolvedReviewTarget } from "../review/target";
import { getEditorCommand, openInEditor } from "../../../../utils/external-editor";

const ANNOTATION_OVERLAY_OPTIONS = {
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
	mouseTracking: false,
} as const;

async function editAnnotationDraft(tui: TUI, draft: string, commit: (text: string | null) => void): Promise<void> {
	const editor = getEditorCommand();
	if (!editor) throw new Error("Set $VISUAL or $EDITOR to edit an annotation externally.");
	tui.stop();
	try {
		commit(await openInEditor(editor, draft, { extension: ".md" }));
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

/** Mount the frozen diff in the TUI overlay surface owned by the command host. */
export function showCodeReviewOverlay(
	ctx: CustomCommandContext,
	target: ResolvedReviewTarget,
): Promise<CodeReviewOverlayResult | undefined> {
	return ctx.ui.custom<CodeReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) =>
			new AnnotationOverlay(tui, theme, keybindings, target.snapshot.files, target.mode, {
				onComplete: done,
				onWarning: message => ctx.ui.notify(message, "warning"),
				onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
			}),
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}

/** Mount a frozen text source in the same annotation overlay UX. */
export function showTextReviewOverlay(
	ctx: CustomCommandContext,
	source: TextReviewSource,
): Promise<TextReviewOverlayResult | undefined> {
	return ctx.ui.custom<TextReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) =>
			new AnnotationOverlay(tui, theme, keybindings, source, {
				onComplete: done,
				onWarning: message => ctx.ui.notify(message, "warning"),
				onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
			}),
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}
