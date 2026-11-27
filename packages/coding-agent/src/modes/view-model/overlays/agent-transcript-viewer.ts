import type { SessionMessageEntryLike } from "../../../session/transcript/transcript-entry";

/** Parsed message and model metadata relevant to a transcript viewer. */
export type AgentTranscriptEntry = SessionMessageEntryLike | { type: "model_change"; model: string };

/** Size and modification time of a stored transcript. */
export interface AgentTranscriptStat {
	size: number;
	mtimeMs: number;
	/**
	 * Filesystem identity, when the host has one. A file-backed transcript
	 * reports the device and inode it was stat'd on, and a change in either is
	 * a different file at the same path — a rotation, which no comparison of
	 * size, time or content can see. A key-indexed host has no identity to
	 * report and omits both.
	 */
	dev?: number;
	ino?: number;
}

/** Transcript reads and session parsing supplied by the host. */
export interface AgentTranscriptSource {
	/**
	 * Size and modification time of the transcript at `path`; throws when there
	 * is none. Every poll calls it, so it must be cheap.
	 */
	stat(path: string): AgentTranscriptStat;
	/**
	 * The UTF-8 text of the transcript at `path` from byte `offset` (a character
	 * boundary) to its end, or, for a transcript too long to read at once, a
	 * window of it holding at least one complete line, which the viewer reads on
	 * from at the next poll; rejects when there is none.
	 */
	readFrom(path: string, offset: number): Promise<string>;
	parseEntries(text: string): AgentTranscriptEntry[];
}
