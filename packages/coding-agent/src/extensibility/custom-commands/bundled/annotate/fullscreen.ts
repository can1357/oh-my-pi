import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import { classifyTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
	TextReviewSourceProvenance,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import { createDefaultTerminalLaunchRequest, getTerminalLaunchPlacement } from "../../../../subprocess/terminal-launch";
import {
	getEditorCommand,
	openEditorOnPath,
	openInEditor,
	resolveEditorSpawnCommand,
} from "../../../../utils/external-editor";
import type { ResolvedReviewTarget } from "../review/target";

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

// Pane launches are detached, so keep the overlay live and the captured source frozen.
type PaneEditorLaunch = "opened" | "fallback" | "cancelled";

async function openFileInPane(
	ctx: CustomCommandContext,
	editor: string,
	filePath: string,
	label: string,
	frozenDescription: string,
	overlayHandle?: OverlayHandle,
): Promise<PaneEditorLaunch> {
	const openTerminal = ctx.ui.openTerminal;
	if (!openTerminal) return "fallback";

	const multiplexer = classifyTerminalMultiplexer(process.env);
	const placementInfo = getTerminalLaunchPlacement(multiplexer, "pane");
	if ("error" in placementInfo) return "fallback";

	if (placementInfo.shellGrammar === "posix") {
		const wasHidden = overlayHandle?.isHidden() ?? false;
		let confirmed: boolean;
		try {
			if (!wasHidden) overlayHandle?.setHidden(true);
			confirmed = await ctx.ui.confirm(
				"Confirm destination shell compatibility",
				"This editor command uses POSIX shell syntax. Continue only if the destination's configured interactive shell accepts POSIX syntax; this cannot be inferred from the current terminal.",
			);
		} finally {
			if (overlayHandle && !wasHidden) overlayHandle.setHidden(false);
		}
		if (!confirmed) {
			ctx.ui.notify(
				"Editor launch cancelled: POSIX shell compatibility was not confirmed for the destination.",
				"warning",
			);
			return "cancelled";
		}
	}

	const spawnCommand = resolveEditorSpawnCommand(editor, filePath);
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const launchPlan = createDefaultTerminalLaunchRequest(
		multiplexer,
		"pane",
		spawnCommand.cmd,
		cwd,
		placementInfo.shellGrammar,
	);
	if ("error" in launchPlan) throw new Error(launchPlan.error);

	const result = await openTerminal.call(ctx.ui, launchPlan.request);
	if (result.warning) {
		ctx.ui.notify(
			`Opened ${label} in ${placementInfo.displayName}, but ${result.warning} The ${frozenDescription} remains frozen.`,
			"warning",
		);
	} else {
		ctx.ui.notify(
			`Opened ${label} in a new ${placementInfo.placementLabel} in ${placementInfo.displayName}. The ${frozenDescription} remains frozen.`,
			"info",
		);
	}
	return "opened";
}

async function requireRegularFile(filePath: string, label: string, context = ""): Promise<void> {
	const suffix = context ? ` ${context}` : "";
	const file = Bun.file(filePath);
	if (!(await file.exists())) throw new Error(`${label} is not on disk.${suffix}`);
	if (!(await file.stat()).isFile()) throw new Error(`${label} is not a regular file.${suffix}`);
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
	ctx: CustomCommandContext,
	overlay: AnnotationOverlay,
	provenance: EditableProvenance,
	overlayHandle?: OverlayHandle,
): Promise<void> {
	const editor = requireEditor();
	const current = overlay.textSourceText() ?? "";
	if (provenance.kind === "file") {
		await requireRegularFile(provenance.path, provenance.path);
		const paneLaunch = await openFileInPane(
			ctx,
			editor,
			provenance.path,
			provenance.path,
			"annotation source",
			overlayHandle,
		);
		if (paneLaunch !== "fallback") return;
	}

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

async function openAssociatedFile(
	tui: TUI,
	ctx: CustomCommandContext,
	filePath: string,
	label: string,
	overlayHandle?: OverlayHandle,
): Promise<void> {
	const editor = requireEditor();
	await requireRegularFile(filePath, label);
	const paneLaunch = await openFileInPane(ctx, editor, filePath, label, "annotation source", overlayHandle);
	if (paneLaunch !== "fallback") return;

	tui.stop();
	let exitCode: number;
	try {
		exitCode = await openEditorOnPath(editor, filePath);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	if (exitCode !== 0) ctx.ui.notify(`Editor exited with code ${exitCode}.`, "warning");
	ctx.ui.notify(`Opened ${label}. The annotation source remains frozen.`, "info");
}

async function editReviewedFile(
	tui: TUI,
	ctx: CustomCommandContext,
	overlay: AnnotationOverlay,
	overlayHandle?: OverlayHandle,
): Promise<void> {
	const relative = overlay.reviewFilePath();
	if (!relative) throw new Error("No file to open.");
	const editor = requireEditor();
	// Diff paths are repository-relative and exact, so resolve them from the repo root, not the session cwd.
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const absolute = path.resolve(vcs.repo(cwd)?.root() ?? cwd, relative);
	await requireRegularFile(absolute, relative, "The review still uses the frozen diff.");
	const paneLaunch = await openFileInPane(ctx, editor, absolute, relative, "review diff", overlayHandle);
	if (paneLaunch !== "fallback") return;

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
	ctx: CustomCommandContext,
	target: ResolvedReviewTarget,
): Promise<CodeReviewOverlayResult | undefined> {
	let overlayHandle: OverlayHandle | undefined;
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
					// A PR diff need not match the local checkout, so only local reviews open the working-tree file.
					onExternalEditor:
						target.kind === "pr" ? undefined : () => editReviewedFile(tui, ctx, overlay, overlayHandle),
				},
			);
			return overlay;
		},
		{
			overlay: true,
			overlayOptions: ANNOTATION_OVERLAY_OPTIONS,
			onHandle: handle => {
				overlayHandle = handle;
			},
		},
	);
}

/** Mount a frozen text source in the same annotation overlay UX. */
export function showTextReviewOverlay(
	ctx: CustomCommandContext,
	source: TextReviewSource,
): Promise<TextReviewOverlayResult | undefined> {
	let overlayHandle: OverlayHandle | undefined;
	return ctx.ui.custom<TextReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const provenance = source.provenance;
			const editable = provenance?.kind === "file" || provenance?.kind === "prompt" ? provenance : undefined;
			const editorFilePath = source.editorFilePath;
			const openSourceEditor = editable
				? () => editTextSource(tui, ctx, overlay, editable, overlayHandle)
				: editorFilePath
					? () => openAssociatedFile(tui, ctx, editorFilePath, editorFilePath, overlayHandle)
					: undefined;
			const overlay: AnnotationOverlay = new AnnotationOverlay(tui, theme, keybindings, source, {
				onComplete: done,
				onWarning: message => ctx.ui.notify(message, "warning"),
				onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
				onExternalEditor: openSourceEditor,
			});
			return overlay;
		},
		{
			overlay: true,
			overlayOptions: ANNOTATION_OVERLAY_OPTIONS,
			onHandle: handle => {
				overlayHandle = handle;
			},
		},
	);
}
