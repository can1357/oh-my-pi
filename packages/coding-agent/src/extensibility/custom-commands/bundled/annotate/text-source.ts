import { transcriptEntryMessage } from "../../../../session/transcript/transcript-entry";
import { jsx } from "@oh-my-pi/pi-tui";
import { CopySelector } from "../../../../ui/overlays/pickers/copy-selector";
import { type CopyPickSource } from "../../../../modes/view-model/overlays/copy-selector";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import { isTranscriptEntry } from "../../../../session/session-context";
import type { TextReviewSource } from "./annotation-types";
import { latestAssistantEntry, latestAssistantTextReviewSource } from "./direct-source";

export type AnnotationSourceKind = "code-review" | "last" | "session" | "file" | "prompt" | "draft";

export const ANNOTATION_SOURCE_CHOICES = [
	{
		kind: "code-review",
		label: "Code review",
		description: "Annotate a local diff before review",
	},
	{
		kind: "last",
		label: "Latest assistant reply",
		description: "Annotate the latest non-empty assistant reply on this branch",
	},
	{
		kind: "session",
		label: "Session message or block",
		description: "Choose a message, code block, quote, or command from this session",
	},
	{
		kind: "file",
		label: "File",
		description: "Read a regular text file from the current working directory",
	},
	{
		kind: "prompt",
		label: "Text prompt",
		description: "Enter text directly for annotation",
	},
	{
		kind: "draft",
		label: "Saved draft",
		description: "Resume notes kept when an annotation was closed without sending them",
	},
] as const satisfies ReadonlyArray<{ kind: AnnotationSourceKind; label: string; description: string }>;

export async function selectAnnotationSourceKind(
	ui: Pick<CustomCommandContext["ui"], "select">,
): Promise<AnnotationSourceKind | undefined> {
	const selected = await ui.select(
		"Select content to annotate",
		ANNOTATION_SOURCE_CHOICES.map(choice => choice.label),
	);
	return ANNOTATION_SOURCE_CHOICES.find(choice => choice.label === selected)?.kind;
}

/** Exact picked content plus the transcript entry/block it came from. */
export interface SessionPick extends CopyPickSource {
	content: string;
	label: string;
}

function sourceKind(selection: SessionPick): TextReviewSource["kind"] {
	if (selection.block?.kind) return selection.block.kind;
	switch (transcriptEntryMessage(selection.entry)?.role) {
		case "toolResult":
			return "code";
		case "bashExecution":
		case "pythonExecution":
			return "command";
		default:
			return "message";
	}
}

function sourceFromSelection(
	ctx: CustomCommandContext,
	selection: SessionPick,
	latestAssistantId: string | undefined,
): TextReviewSource {
	const kind = sourceKind(selection);
	const entryId = selection.entry.id;
	const isLatestWholeAssistant =
		selection.block === undefined &&
		entryId === latestAssistantId &&
		transcriptEntryMessage(selection.entry)?.role === "assistant";
	return {
		id: `${kind}:${entryId}`,
		kind,
		label: selection.label,
		text: selection.content,
		provenance: isLatestWholeAssistant ? { kind: "latest-assistant", entryId } : { kind: "session", entryId },
		sessionId: ctx.sessionManager.getSessionId(),
	};
}

/** Choose exact content through the native copy selector without copying it. */
export async function selectSessionTextReviewSource(
	ctx: CustomCommandContext,
	options?: { autoSelect?: "latest-assistant" },
): Promise<TextReviewSource | undefined> {
	const branch = ctx.sessionManager.getBranch();
	if (options?.autoSelect === "latest-assistant") {
		const source = latestAssistantTextReviewSource(branch, ctx.sessionManager.getSessionId());
		if (!source) ctx.ui.notify("No non-empty assistant reply is available on the active session branch.", "warning");
		return source;
	}
	const latest = latestAssistantEntry(branch);

	const entries = branch.filter(isTranscriptEntry);
	if (entries.length === 0) {
		ctx.ui.notify("No messages to annotate yet.", "warning");
		return undefined;
	}
	const selection = await ctx.ui.custom<SessionPick | undefined>(
		(ui, _theme, _keybindings, done) =>
			jsx(CopySelector, {
				entries,
				terminalRows: () => ui.size().rows,
				title: "Select message to annotate",
				actionLabel: "select",
				onPick: (content: string, label: string, source: CopyPickSource) => done({ content, label, ...source }),
				onCancel: () => done(undefined),
			}),
		{ overlay: true },
	);
	return selection ? sourceFromSelection(ctx, selection, latest?.id) : undefined;
}
