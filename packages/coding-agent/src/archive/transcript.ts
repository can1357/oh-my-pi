/**
 * The `archive.transcript` view: one session file rendered within a character
 * budget by the shared transcript view (`session/transcript-view.ts`), from
 * the native scanner's records.
 */
import type { TimeWindow } from "../session/time-window";
import { renderTranscriptRecords, type TranscriptDetailRequest, type TranscriptView } from "../session/transcript-view";
import { readTranscript } from "./activity";
import type { ArchiveView } from "./archive";

/** One rendered transcript and the file it came from. */
export interface ArchiveTranscript extends TranscriptView {
	/** Transcript JSONL file. */
	file: string;
}

/** What {@link archiveTranscript} renders. */
export interface ArchiveTranscriptOptions {
	/** Most characters of the rendering. */
	budget: number;
	detail: TranscriptDetailRequest;
	/** One turn or an inclusive range; negative turns count back from the last (`-1`). Every turn when omitted. */
	turns: number | readonly [number, number] | undefined;
	/** Keeps the turns active in it. */
	window: TimeWindow | undefined;
	signal?: AbortSignal;
}

/** The scanner's `limit` is a u32; this reads every record. */
const ALL_RECORDS = 0xffff_ffff;

/**
 * One transcript, a session by id prefix or any transcript file, rendered
 * within `options.budget` characters.
 *
 * @throws {ToolError} when no session or several match, or the file is not readable.
 */
export async function archiveTranscript(
	idOrFile: string,
	options: ArchiveTranscriptOptions,
): Promise<ArchiveView<ArchiveTranscript>> {
	const { file, records } = await readTranscript(idOrFile, { limit: ALL_RECORDS, signal: options.signal });
	const view = renderTranscriptRecords(records, { ...options, title: "Transcript" });
	return { text: view.text, records: { file, ...view } };
}
