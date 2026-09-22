/**
 * Lexical prior: per-file keyword occurrence counts from one native grep pass,
 * turned into IDF weights and a file score that ranks candidates before any
 * judgment is spent.
 */
import * as natives from "@oh-my-pi/pi-natives";
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
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Count keyword occurrences (case-insensitive, any keyword) in every file under
 * `root`. Only lines containing a keyword are inspected, so counts are per
 * matching line rather than per file byte.
 */
export async function grepIndex(
	root: string,
	rawKeywords: readonly string[],
	options: GrepIndexOptions,
): Promise<GrepIndex> {
	const keywords = rawKeywords.map(keyword => keyword.toLowerCase()).filter(keyword => keyword.length > 0);
	const index: GrepIndex = { keywords, perFileKw: new Map(), filesScanned: 0 };
	if (keywords.length === 0) return index;
	const result = await natives.grep({
		pattern: keywords.map(escapeRegex).join("|"),
		path: root,
		ignoreCase: true,
		hidden: options.includeHidden,
		gitignore: true,
		mode: natives.GrepOutputMode.Content,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
	index.filesScanned = result.filesSearched + (result.skippedOversized ?? 0);
	for (const match of result.matches) {
		let counts = index.perFileKw.get(match.path);
		if (!counts) {
			counts = Array.from({ length: keywords.length }, () => 0);
			index.perFileKw.set(match.path, counts);
		}
		const line = match.line.toLowerCase();
		for (let k = 0; k < keywords.length; k++) {
			counts[k]! += countOccurrences(line, keywords[k]!);
		}
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
