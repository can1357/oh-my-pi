import { GrepOutputMode, grep, hasMatch } from "@pk-nerdsaver-ai/pi-natives";

export interface LexicalSelectorSpec {
	id: string;
	type: "lexical";
	pattern: string;
	reason: string;
	tags?: string[];
}

export interface SelectorSignal {
	id: string;
	selectorId: string;
	type: "lexical";
	file: string;
	line: number;
	evidence: string;
	reason: string;
	tags: string[];
}

export interface SelectorLedgerItem {
	id: string;
	type: "lexical";
	filesSearched: number;
	filesWithMatches: number;
	/** Matches observed in the returned grep page. Exact only when `limitReached` is false. */
	observedMatches: number;
	returnedMatches: number;
	limitReached: boolean;
	skippedOversized: number;
}

export interface LexicalSelectorRunInput {
	cwd: string;
	includeGlob: string;
	selectors: readonly LexicalSelectorSpec[];
	gitignore?: boolean;
	hidden?: boolean;
	maxMatches?: number;
	maxColumns?: number;
	signal?: AbortSignal;
}

export interface LexicalSelectorRunResult {
	signals: SelectorSignal[];
	selectorLedger: SelectorLedgerItem[];
	filesSearched: number;
	filesWithMatches: number;
	limitReached: boolean;
	skippedOversized: number;
}

const REGEX_META_CHARS = /[\\^$.*+?()[\]{}|]/;

interface SelectorRuntimeEntry {
	selector: LexicalSelectorSpec;
	literalPattern?: string;
}

interface SelectorStats {
	filesWithMatches: Set<string>;
	observedMatches: number;
}

export function selectorLedgerComplete(selectorLedger: readonly SelectorLedgerItem[]): boolean {
	return selectorLedger.every(
		selector =>
			selector.returnedMatches === selector.observedMatches &&
			selector.limitReached === false &&
			selector.skippedOversized === 0,
	);
}

function formatEvidenceLine(line: string, maxColumns: number | undefined, literalPattern: string | undefined): string {
	const limit = maxColumns ?? 500;
	if (limit <= 0 || line.length <= limit) return line;
	if (!literalPattern) return line;

	const matchStart = line.indexOf(literalPattern);
	if (matchStart < 0) return line;
	const matchEnd = matchStart + literalPattern.length;
	const prefix = matchStart > 0 ? "…" : "";
	const suffix = matchEnd < line.length ? "…" : "";
	const contentLimit = Math.max(1, limit - prefix.length - suffix.length);
	if (literalPattern.length >= contentLimit) return line;

	const contextBudget = contentLimit - literalPattern.length;
	const before = Math.min(matchStart, Math.floor(contextBudget / 2));
	const after = Math.min(line.length - matchEnd, contextBudget - before);
	const extraBefore = Math.min(matchStart - before, contextBudget - before - after);
	const start = matchStart - before - extraBefore;
	const end = Math.min(line.length, start + contentLimit);
	return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

export async function runLexicalSelectors(input: LexicalSelectorRunInput): Promise<LexicalSelectorRunResult> {
	if (input.selectors.length === 0) {
		return {
			signals: [],
			selectorLedger: [],
			filesSearched: 0,
			filesWithMatches: 0,
			limitReached: false,
			skippedOversized: 0,
		};
	}

	const selectorEntries: SelectorRuntimeEntry[] = input.selectors.map(selector =>
		REGEX_META_CHARS.test(selector.pattern) ? { selector } : { selector, literalPattern: selector.pattern },
	);
	const combinedSelectorPattern = input.selectors.map(selector => `(?:${selector.pattern})`).join("|");
	const combinedResult = await grep({
		pattern: combinedSelectorPattern,
		path: input.cwd,
		glob: input.includeGlob,
		gitignore: input.gitignore ?? true,
		hidden: input.hidden ?? true,
		maxCount: input.maxMatches ?? 100_000,
		mode: GrepOutputMode.Content,
		signal: input.signal,
	});

	const signals: SelectorSignal[] = [];
	const seenSignalKeys = new Set<string>();
	const selectorStats = new Map<string, SelectorStats>();
	for (const selector of input.selectors) {
		selectorStats.set(selector.id, { filesWithMatches: new Set<string>(), observedMatches: 0 });
	}

	for (const match of combinedResult.matches) {
		for (const entry of selectorEntries) {
			const selector = entry.selector;
			const selectorMatched = entry.literalPattern
				? match.line.includes(entry.literalPattern)
				: hasMatch(match.line, selector.pattern);
			if (!selectorMatched) continue;
			const stats = selectorStats.get(selector.id);
			if (!stats) continue;
			const signalKey = `${selector.id}\0${match.path}\0${match.lineNumber}`;
			if (seenSignalKeys.has(signalKey)) continue;
			seenSignalKeys.add(signalKey);
			stats.filesWithMatches.add(match.path);
			stats.observedMatches += 1;
			signals.push({
				id: `sig_${signals.length.toString().padStart(5, "0")}`,
				selectorId: selector.id,
				type: "lexical",
				file: match.path,
				line: match.lineNumber,
				evidence: formatEvidenceLine(match.line, input.maxColumns, entry.literalPattern),
				reason: selector.reason,
				tags: selector.tags ?? [],
			});
		}
	}

	const selectorLedger = input.selectors.map(selector => {
		const stats = selectorStats.get(selector.id);
		return {
			id: selector.id,
			type: "lexical" as const,
			filesSearched: combinedResult.filesSearched,
			filesWithMatches: stats?.filesWithMatches.size ?? 0,
			observedMatches: stats?.observedMatches ?? 0,
			returnedMatches: stats?.observedMatches ?? 0,
			limitReached: combinedResult.limitReached === true,
			skippedOversized: combinedResult.skippedOversized ?? 0,
		};
	});

	return {
		signals,
		selectorLedger,
		filesSearched: combinedResult.filesSearched,
		filesWithMatches: combinedResult.filesWithMatches,
		limitReached: combinedResult.limitReached === true,
		skippedOversized: combinedResult.skippedOversized ?? 0,
	};
}
