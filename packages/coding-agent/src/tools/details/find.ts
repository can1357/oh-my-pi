import type { OutputMeta } from "../output-meta-format";

/** A verified line range with its yes-probability and a one-line preview. */
export interface FindRange {
	start: number;
	end: number;
	p: number;
	snippet: string;
}

/** A file whose verified passages cleared the threshold; `ranges` are merged positive spans, strongest first. */
export interface FindHit {
	/** Display path relative to {@link FindToolDetails.cwd}, or an internal URL under URL scopes. */
	rel: string;
	/** Filename judgment, when the name batch answered. */
	nameScore?: number;
	/** Best verified passage probability. */
	contentScore: number;
	ranges: FindRange[];
	/** Lines of content actually judged, and whether the file held more. */
	linesSeen: number;
	truncated: boolean;
}

/** One literal keyword line from a file the lexical pass already read; unranked and not semantically judged. */
export interface FindLexicalMatch {
	/** Display path relative to {@link FindToolDetails.cwd}, or an internal URL under URL scopes. */
	rel: string;
	/** 1-based line number in the file. */
	line: number;
	/** Verbatim source line, trimmed and clipped. */
	snippet: string;
}

/**
 * How much of a search the judge actually covered. `unavailable`: every judge
 * request failed, so an empty result is not evidence of absence. `partial`:
 * some requests failed, or the call's deadline cut verification short.
 * `complete`: none failed (or none were needed).
 */
export type FindCoverage = "complete" | "partial" | "unavailable";

/** Verification cut short by the call's deadline: complete passages verified of those routed to it. */
export interface FindTimeout {
	verified: number;
	passages: number;
}

/** Search accounting reported alongside the hits. */
export interface FindStats {
	/** Eligible files under the root. */
	listed: number;
	requests: number;
	/** Judge requests that failed outright; decides {@link FindCoverage}. */
	failed: number;
	/** Questions a successful response left without a usable answer. */
	unanswered: number;
	/** Entries judged by name. */
	judged: number;
	/** Files whose content was read and sent. */
	filesRead: number;
	fileBytes: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	apiMs: number;
	windowsJudged: number;
	windowsPruned: number;
	mapCards: number;
	/** Distinct request failures, phase-prefixed. */
	failures: string[];
}

/** Display metadata for find tool results. */
export interface FindToolDetails {
	query: string;
	/** Lexical keywords actually used: derived from the query plus `grep_keywords`. */
	keywords: string[];
	/** Verified-passage probability at or above which a file is a hit. */
	threshold: number;
	hits: FindHit[];
	/** Literal keyword lines from the already-read files, present when every judge request failed. */
	lexicalFallback?: FindLexicalMatch[];
	coverage: FindCoverage;
	stats: FindStats;
	/** Set when the deadline ended verification; the hits are those verified before it. */
	timeout?: FindTimeout;
	elapsedMs: number;
	/** Session cwd; hit paths are relative to it. */
	cwd: string;
	/** Display form of the searched directory or file when narrower than cwd. */
	scopePath?: string;
	meta?: OutputMeta;
}
