import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";

/**
 * Whether a successful `read` result shows its whole file, so a bare-path read
 * may supersede earlier range reads of that file (`supersedeComplete` for
 * `pruneSupersededToolResults`). Complete needs positive proof: a scanned line
 * count or a returned image, with no summary, truncation, or column cap.
 * Summaries, partial pages, and notices (binary file, directory, metadata) are
 * not complete.
 */
export function isCompleteReadResult(message: ToolResultMessage): boolean {
	// Typed through the producer's details so a renamed field is a compile error.
	const details = message.details as ReadToolDetails | undefined;
	if (!details || details.summary || details.truncation?.truncated) return false;
	if (details.meta?.truncation || details.meta?.limits?.columnTruncated) return false;
	return details.totalLines !== undefined || message.content.some(block => block.type === "image");
}
