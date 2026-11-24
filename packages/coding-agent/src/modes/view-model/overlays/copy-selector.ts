import { type TranscriptEntryLike as TranscriptEntry } from "../../../session/transcript/transcript-entry";

/** Where picked content came from in the transcript. */
export interface CopyPickSource {
	entry: TranscriptEntry;
	/** The inner block, when the pick happened in the descended block view. */
	block?: CopyBlock;
}

/** One copyable inner block of a transcript turn. */
export interface CopyBlock {
	/** Short kind label ("code · ts", "bash command", "read result", …). */
	label: string;
	/** Exact text placed on the clipboard. */
	content: string;
	/** Transcript entry that produced this block. */
	entry: TranscriptEntry;
	/** Markdown code/quote block, or a bash/eval tool-call command. */
	kind?: "code" | "quote" | "command";
	/** Highlight language for the block preview. */
	language?: string;
	/** Set for link blocks: the URL `o` opens. `content` is the same URL. */
	href?: string;
}
