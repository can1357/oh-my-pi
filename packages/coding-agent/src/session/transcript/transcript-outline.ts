import { type TranscriptEntryLike as TranscriptEntry } from "./transcript-entry";

/** One selectable transcript item: a message entry plus its rendered block range. */
export interface OutlineTarget {
	/** Entry the selection resolves to; extended over trailing componentless tool results. */
	entryId: string;
	/** Entry that opened this turn (pre-fold) — anchor for tree lookups. */
	turnId: string;
	/** Real user prompt — drives user-turn jumps and role-specific actions. */
	isUserTurn: boolean;
	/** First transcript-container child rendered by this entry. */
	start: number;
	/** One past the last child rendered by this entry. */
	end: number;
	/** Entries this target spans: the turn plus any folded tool results. */
	entries: TranscriptEntry[];
}
