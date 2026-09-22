import type { BackgroundTanDispatchDetails, CustomMessage } from "./messages";
import { replaceTabs } from "../render/render-utils";
import { theme } from "../theme";
import type { TranscriptBlock } from "../chrome/transcript-container";
import { TranscriptStatusBlock } from "../chrome/transcript-status";

const TAN_WORK_PREVIEW_LENGTH = 56;

function previewWork(work: string): string {
	const singleLine = replaceTabs(work).trim().replace(/\s+/g, " ");
	if (singleLine.length <= TAN_WORK_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, TAN_WORK_PREVIEW_LENGTH - 1)}…`;
}

/**
 * Single-line transcript pill for a `/tan` background-dispatch breadcrumb,
 * styled as a sibling of the "Background job completed" line. The full
 * system-notice content (the persisted `content`) is for the model only — the
 * user sees one compact line, not the raw `<system-notice>` block.
 */
export function createBackgroundTanDispatchBlock(message: CustomMessage<unknown>): TranscriptBlock {
	const details = (message as CustomMessage<Partial<BackgroundTanDispatchDetails>>).details;
	const jobId = details?.jobId ?? "unknown";
	const work = details?.work ? previewWork(details.work) : undefined;
	return new TranscriptStatusBlock([
		{
			parts: [
				theme.fg("muted", `${theme.icon.output} Tangent dispatched`),
				theme.fg("dim", "[task]"),
				theme.fg("accent", jobId),
				work ? theme.fg("dim", `${theme.format.dash} ${work}`) : undefined,
			],
		},
	]);
}
