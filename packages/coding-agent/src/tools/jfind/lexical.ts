/**
 * Lexical prior: per-file keyword occurrence counts from one native grep pass,
 * turned into IDF weights and a file score that ranks candidates before any
 * judgment is spent.
 */
import * as natives from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveSearchResultPath } from "../path-utils";
import { throwIfAborted } from "../tool-errors";
import { countOccurrences } from "./text";

export interface GrepIndex {
	/** Lowercased, non-empty keywords; `perFileKw` vectors align with this. */
	keywords: string[];
	/** rel file path → per-keyword occurrence counts over matching lines. */
	perFileKw: Map<string, number[]>;
	/** Files the walk offered for scanning, including oversized ones. */
	filesScanned: number;
}

/** Regex-escape a literal keyword for the native grep alternation. */
function escapeRegex(keyword: string): string {
	return keyword.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, "\\$&");
}

export interface GrepIndexOptions {
	includeHidden: boolean;
	/** Filesystem URL roots and their entries resolve through. */
	filesystem: natives.ShellFilesystem;
	maxScanFiles?: number;
	maxScanBytes?: number;
	/** Walk-relative globs for files that are neither searched nor counted toward the scan budget. */
	excludeGlobs?: readonly string[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Largest file the truncated-line recount reopens: the native scan's own read window. */
const RECOUNT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Count keyword occurrences (case-insensitive, any keyword) in every file under
 * `root`, keyed like `FileEntry.rel`: root-relative, or a file root's own
 * path. Only lines containing a keyword are inspected, so counts are per
 * matching line rather than per file byte. Matching lines stream from the
 * native scan and are folded into counts as they arrive, so memory stays
 * bounded by the batches in flight however many lines match.
 */
export async function grepIndex(
	root: string,
	rawKeywords: readonly string[],
	options: GrepIndexOptions,
): Promise<GrepIndex> {
	const keywords = rawKeywords.map(keyword => keyword.toLowerCase()).filter(keyword => keyword.length > 0);
	const index: GrepIndex = { keywords, perFileKw: new Map(), filesScanned: 0 };
	if (keywords.length === 0) return index;
	const { perFileKw } = index;
	const pattern = keywords.map(escapeRegex).join("|");
	const truncated = new Set<string>();
	// One deadline covers the initial scan and every recount.
	const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
	const result = await natives.grep({
		pattern,
		path: root,
		ignoreCase: true,
		hidden: options.includeHidden,
		gitignore: true,
		mode: natives.GrepOutputMode.Content,
		filesystem: options.filesystem,
		maxScanFiles: options.maxScanFiles,
		maxScanBytes: options.maxScanBytes,
		excludeGlobs: options.excludeGlobs ? [...options.excludeGlobs] : undefined,
		maxColumns: 512,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		onMatches: matches => {
			for (const match of matches) {
				let counts = perFileKw.get(match.path);
				if (!counts) {
					counts = Array.from({ length: keywords.length }, () => 0);
					perFileKw.set(match.path, counts);
				}
				if (match.truncated) truncated.add(match.path);
				const line = match.line.toLowerCase();
				for (let k = 0; k < keywords.length; k++) {
					counts[k]! += countOccurrences(line, keywords[k]!);
				}
			}
		},
	});
	index.filesScanned = result.filesSearched + (result.skippedOversized ?? 0);
	// A truncated matching line hides occurrences past the retained prefix, so
	// recount the affected files over their untruncated lines. The recount is a
	// best-effort refinement of the prefix counts already folded in: it never
	// reopens a file larger than the native scan's own read window (that would
	// stream the whole file, and a single huge line can fail the grep), it shares
	// the scan's deadline, and a failed recount keeps the lower-bound counts.
	for (const rel of truncated) {
		throwIfAborted(options.signal);
		const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
		if (remaining === 0) break;
		let recount: Awaited<ReturnType<typeof natives.grep>>;
		try {
			recount = await natives.grep({
				pattern,
				path: resolveSearchResultPath(root, rel),
				ignoreCase: true,
				hidden: options.includeHidden,
				gitignore: true,
				mode: natives.GrepOutputMode.Content,
				filesystem: options.filesystem,
				maxScanFiles: 1,
				maxScanBytes: RECOUNT_MAX_BYTES,
				signal: options.signal,
				timeoutMs: remaining,
			});
		} catch (error) {
			throwIfAborted(options.signal);
			logger.debug("jfind: truncated-line recount skipped", { rel, error });
			continue;
		}
		const counts = Array.from({ length: keywords.length }, () => 0);
		for (const match of recount.matches) {
			const line = match.line.toLowerCase();
			for (let k = 0; k < keywords.length; k++) {
				counts[k]! += countOccurrences(line, keywords[k]!);
			}
		}
		perFileKw.set(rel, counts);
	}
	return index;
}

/**
 * Inverse document frequency per keyword, clamped to `[0.5, 6]`: rarity is
 * capped so a word occurring once in a test fixture cannot beat an
 * implementation that contains several query concepts repeatedly.
 */
export function idf(index: GrepIndex): number[] {
	return index.keywords.map((_, k) => {
		let df = 0;
		for (const counts of index.perFileKw.values()) {
			if ((counts[k] ?? 0) > 0) df++;
		}
		const weight = Math.log((index.filesScanned + 1) / (df + 1));
		return Math.min(6, Math.max(0.5, weight));
	});
}

/**
 * Lexical rank of a file: rare query terms count more, log-scaled frequency
 * keeps common words in a giant file from overwhelming a compact
 * implementation with several terms, and a keyword in the path is worth two
 * extra log-units.
 */
export function fileScore(
	counts: readonly number[],
	weights: readonly number[],
	rel: string,
	keywords: readonly string[],
): number {
	const lower = rel.toLowerCase();
	let score = 0;
	for (let k = 0; k < keywords.length; k++) {
		const inPath = lower.includes(keywords[k]!) ? 1 : 0;
		score += weights[k]! * (2 * inPath + Math.log1p(counts[k] ?? 0));
	}
	return score;
}
