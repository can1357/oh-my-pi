/**
 * The fullscreen scrollbar's prompt marks: one per user prompt in the transcript, colored by how
 * its turn went. A turn is the prompt's block and every block up to the next prompt:
 *
 * - `error`: a reply that errored or was aborted, or a `failure` notice (an error that failed the
 *   turn). An auto-retry attempt that recovered or was superseded is not the turn's outcome.
 * - `warning`: a tool call whose final result is an error.
 * - `running`: the last prompt while the session runs.
 * - `success`: otherwise.
 */
import { type Accessor, computed, type UiNode } from "@oh-my-pi/pi-tui";
import type { ScrollMark, ScrollMarkKind } from "@oh-my-pi/pi-tui/term/backend";
import type { TranscriptBlock } from "../../ui/shell";
import type { PendingTool, TranscriptEntry } from "../types";

/** What {@link transcriptMarks} reads. */
export interface TranscriptMarksSource {
	/** The transcript's main nodes, in order (reactive). */
	readonly nodes: Accessor<readonly UiNode[]>;
	/** The block drawing a main node. */
	blockOf(node: UiNode): TranscriptBlock | undefined;
	/** What a block shows; undefined for static blocks. */
	entry(block: TranscriptBlock): TranscriptEntry | undefined;
	/** Whether the session runs a turn (reactive). */
	readonly running: Accessor<boolean>;
}

/** The marks of `source`'s prompts (reactive: follows the blocks, their replies and tool results). */
export function transcriptMarks(source: TranscriptMarksSource): Accessor<readonly ScrollMark[]> {
	return computed(
		() => {
			const marks: { node: UiNode; kind: ScrollMarkKind }[] = [];
			for (const node of source.nodes()) {
				const block = source.blockOf(node);
				const entry = block && source.entry(block);
				if (!entry) continue;
				if (entry.kind === "message" && entry.message.role === "user") {
					marks.push({ node, kind: "success" });
					continue;
				}
				const turn = marks.at(-1);
				if (!turn || turn.kind === "error") continue;
				if (failsTurn(entry)) turn.kind = "error";
				else if (entry.kind === "tool" && toolFailed(entry.tool)) turn.kind = "warning";
			}
			const last = marks.at(-1);
			if (last && source.running()) last.kind = "running";
			return marks;
		},
		// A streaming reply recomputes the marks without changing them: the scrollbar keeps its paint.
		{
			equals: (a, b) =>
				a.length === b.length && a.every((mark, i) => mark.node === b[i]!.node && mark.kind === b[i]!.kind),
		},
	);
}

/** A `failure` notice, or a reply that errored or was aborted and was not retried away. */
function failsTurn(entry: TranscriptEntry): boolean {
	if (entry.kind === "failure") return true;
	if (entry.kind !== "assistant") return false;
	const message = entry.view.message();
	return (
		message !== undefined &&
		(message.stopReason === "error" || message.stopReason === "aborted") &&
		message.retryRecovery === undefined
	);
}

/** A tool card whose final result is an error, or a read group with a failed read. */
function toolFailed(tool: PendingTool): boolean {
	if (tool.call) return tool.call.status() === "error";
	return tool.group?.entries().some(read => read.status === "error") ?? false;
}
