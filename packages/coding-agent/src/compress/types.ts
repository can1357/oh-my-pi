/** One piece of source content a draft knowingly does not carry over. */
export interface CompressLoss {
	/** The dropped content, quoted from the source or described precisely. */
	content: string;
	/** Why the draft is still correct without it. */
	reason: string;
}

/** One submitted compression attempt. */
export interface CompressDraft {
	/** 1-based submission counter. */
	round: number;
	/** Complete compressed text, ready to ship as-is. */
	text: string;
	/** Everything the agent declared it dropped, possibly empty. */
	losses: CompressLoss[];
}

/** Measured size of a draft against its source. */
export interface CompressMetrics {
	sourceWords: number;
	draftWords: number;
	sourceTokens: number;
	draftTokens: number;
	/** Token reduction as a fraction of the source; negative when a draft grew. */
	ratio: number;
}

/** Why a run ended. `stalled` means the agent neither resubmitted nor approved. */
export type CompressStatus = "approved" | "unapproved" | "stalled" | "cancelled";

/** Observable completion state for one compressed file. */
export interface CompressFileResult {
	/** Absolute path of the source file. */
	path: string;
	status: CompressStatus;
	/** Newest draft, present whenever `rewrite` was called at least once. */
	draft?: CompressDraft;
	metrics?: CompressMetrics;
	/** The agent's stated reason for accepting the final draft. */
	verdict?: string;
	/** Number of drafts submitted. */
	rounds: number;
	/** Where the approved text was written; absent when it went to stdout. */
	outputPath?: string;
	sessionFile?: string;
	/** Set when the file could not be processed at all (unreadable, session failure). */
	error?: string;
}

/** Aggregate result returned to the CLI adapter. */
export interface CompressResult {
	exitCode: number;
	files: CompressFileResult[];
	/** Source tokens across every file that produced a draft. */
	sourceTokens: number;
	/** Draft tokens across every file that produced a draft. */
	draftTokens: number;
}
