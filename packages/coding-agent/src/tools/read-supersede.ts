import type { ShownLines } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { type ReadToolDetails, readSourceFsPath } from "@oh-my-pi/pi-tui/tools/read";

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

/**
 * The file lines a successful `read` result showed (`supersedeShown` for
 * `pruneSupersededToolResults`), from the per-row line numbers the read tool
 * records. Elision rows carry no number and are skipped. Undefined when the
 * result has no numbered rows or no filesystem path (URL and internal reads),
 * or when a line was cut by the column cap: a cut row matches another cut row
 * while the lines behind them may differ.
 */
export function shownReadLines(message: ToolResultMessage): ShownLines | undefined {
	const details = message.details as ReadToolDetails | undefined;
	if (details?.meta?.limits?.columnTruncated) return undefined;
	const target = details?.resolvedPath ?? readSourceFsPath(details);
	const shown = details?.displayContent;
	if (!target || !shown?.lineNumbers) return undefined;
	const rows = shown.text.split("\n");
	const lines = new Map<number, string>();
	shown.lineNumbers.forEach((line, row) => {
		if (line !== null && row < rows.length) lines.set(line, rows[row]);
	});
	return lines.size > 0 ? { target, lines } : undefined;
}
