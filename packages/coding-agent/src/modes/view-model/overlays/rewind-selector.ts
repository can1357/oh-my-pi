import { type TranscriptEntryLike as TranscriptEntry } from "../../../session/transcript/transcript-entry";

/** One alternate branch at a divergence: its root and message path root → most-recent leaf. */
export interface BranchVariantPath {
	rootId: string;
	entries: TranscriptEntry[];
}
