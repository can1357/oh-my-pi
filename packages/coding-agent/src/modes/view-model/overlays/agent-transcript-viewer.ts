import type * as fs from "node:fs";
import type { EntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";
import type { SessionMessageEntryLike } from "../../../session/transcript/transcript-entry";

/**
 * Parsed message and model metadata relevant to a transcript viewer, and the
 * `entry_patch` records that set fields on messages read before them.
 */
export type AgentTranscriptEntry = SessionMessageEntryLike | { type: "model_change"; model: string } | EntryPatchRecord;

/** Local filesystem and session parsing capabilities supplied by the host. */
export interface AgentTranscriptSource {
	/**
	 * Sync primitives drive the first paint and the incremental tail. When the
	 * host also supplies `promises.readFile` (e.g. passes `node:fs` itself), full
	 * reloads after rotation/rewrite read the file off the UI thread.
	 */
	fs: Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "readFileSync" | "statSync"> & {
		promises?: Pick<typeof fs.promises, "readFile">;
	};
	/**
	 * The entries of `text`, complete lines of a transcript: its messages and
	 * model changes, each carrying the `entry_patch` records of `text`, and
	 * those records, which the viewer applies to messages of earlier reads.
	 */
	parseEntries(text: string): AgentTranscriptEntry[];
}
