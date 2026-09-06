/**
 * Fuzzy matching utilities for the edit tool.
 *
 * Provides both character-level and line-level fuzzy matching with progressive
 * fallback strategies for finding text in files.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import type { AppliedEditObserver } from "../blackbox";
import { generateDiffString, replaceText } from "../diff";
import {
	countLeadingWhitespace,
	detectLineEnding,
	normalizeForFuzzy,
	normalizeToLF,
	normalizeUnicode,
	restoreLineEndings,
	stripBom,
} from "../normalize";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { EditToolDetails, LspBatchRequest } from "../renderer";
import { createEditResult, toEditToolResult } from "../result";

export interface FuzzyMatch {
	actualText: string;
	startIndex: number;
	startLine: number;
	confidence: number;
}

export interface MatchOutcome {
	match?: FuzzyMatch;
	closest?: FuzzyMatch;
	occurrences?: number;
	occurrenceLines?: number[];
	occurrencePreviews?: string[];
	fuzzyMatches?: number;
	dominantFuzzy?: boolean;
}

export type SequenceMatchStrategy =
	| "exact"
	| "trim-trailing"
	| "trim"
	| "comment-prefix"
	| "unicode"
	| "prefix"
	| "substring"
	| "fuzzy"
	| "fuzzy-dominant"
	| "character";

export interface SequenceSearchResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: SequenceMatchStrategy;
}

export type ContextMatchStrategy = "exact" | "trim" | "unicode" | "prefix" | "substring" | "fuzzy";

export interface ContextLineResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: ContextMatchStrategy;
}

export class EditMatchError extends Error {
	constructor(
		readonly path: string,
		readonly searchText: string,
		readonly closest: FuzzyMatch | undefined,
		readonly options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	) {
		super(EditMatchError.formatMessage(path, searchText, closest, options));
		this.name = "EditMatchError";
	}

	static formatMessage(
		path: string,
		searchText: string,
		closest: FuzzyMatch | undefined,
		options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	): string {
		if (!closest) {
			return options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
		}

		const similarity = Math.round(closest.confidence * 100);
		const searchLines = searchText.split("\n");
		const actualLines = closest.actualText.split("\n");
		const { oldLine, newLine } = findFirstDifferentLine(searchLines, actualLines);
		const thresholdPercent = Math.round(options.threshold * 100);

		const hint = options.allowFuzzy
			? options.fuzzyMatches && options.fuzzyMatches > 1
				? `Found ${options.fuzzyMatches} high-confidence matches. Provide more context to make it unique.`
				: `Closest match was below the ${thresholdPercent}% similarity threshold.`
			: "Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence matches.";

		return [
			options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}.`,
			``,
			`Closest match (${similarity}% similar) at line ${closest.startLine}:`,
			`  - ${oldLine}`,
			`  + ${newLine}`,
			hint,
		].join("\n");
	}
}

function findFirstDifferentLine(oldLines: string[], newLines: string[]): { oldLine: string; newLine: string } {
	const max = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < max; i++) {
		const oldLine = oldLines[i] ?? "";
		const newLine = newLines[i] ?? "";
		if (oldLine !== newLine) {
			return { oldLine, newLine };
		}
	}
	return { oldLine: oldLines[0] ?? "", newLine: newLines[0] ?? "" };
}

function formatOccurrenceError(path: string, matchOutcome: MatchOutcome): string {
	const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
	const moreMsg =
		matchOutcome.occurrences && matchOutcome.occurrences > MAX_RECORDED_MATCHES
			? ` (showing first ${MAX_RECORDED_MATCHES} of ${matchOutcome.occurrences})`
			: "";
	return `Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Default similarity threshold for fuzzy matching */
export const DEFAULT_FUZZY_THRESHOLD = 0.95;

/** Threshold for sequence-based fuzzy matching */
const SEQUENCE_FUZZY_THRESHOLD = 0.92;

/** Fallback threshold for line-based matching */
const FALLBACK_THRESHOLD = 0.8;

/** Threshold for context line matching */
const CONTEXT_FUZZY_THRESHOLD = 0.8;

/** Minimum length for partial/substring matching */
const PARTIAL_MATCH_MIN_LENGTH = 6;

/** Minimum ratio of pattern to line length for substring match */
const PARTIAL_MATCH_MIN_RATIO = 0.3;

/** Context lines to show before/after an ambiguous match preview */
const OCCURRENCE_PREVIEW_CONTEXT = 5;

/** Maximum line length for ambiguous match previews */
const OCCURRENCE_PREVIEW_MAX_LEN = 80;

/** Maximum number of match indices or previews to retain for diagnostics */
const MAX_RECORDED_MATCHES = 5;

/** Minimum confidence for a dominant fuzzy match to be auto-selected */
const DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97;

/** Minimum score gap between the best and second-best fuzzy matches */
const DOMINANT_FUZZY_DELTA = 0.08;

interface IndexedMatches {
	firstMatch: number | undefined;
	matchCount: number;
	matchIndices: number[];
}

interface PreviewWindowOptions {
	context: number;
	maxLen: number;
}

function collectIndexedMatches(
	start: number,
	endInclusive: number,
	predicate: (index: number) => boolean,
): IndexedMatches {
	let firstMatch: number | undefined;
	let matchCount = 0;
	const matchIndices: number[] = [];

	for (let index = start; index <= endInclusive; index++) {
		if (!predicate(index)) continue;
		if (firstMatch === undefined) {
			firstMatch = index;
		}
		matchCount++;
		if (matchIndices.length < MAX_RECORDED_MATCHES) {
			matchIndices.push(index);
		}
	}

	return { firstMatch, matchCount, matchIndices };
}

function toSingleMatchResult<TStrategy extends SequenceMatchStrategy | ContextMatchStrategy>(
	matches: IndexedMatches,
	confidence: number,
	strategy: TStrategy,
): { index: number; confidence: number; strategy: TStrategy } | undefined {
	if (matches.firstMatch === undefined) {
		return undefined;
	}
	return {
		index: matches.firstMatch,
		confidence,
		strategy,
	};
}

function toAmbiguousMatchResult<TStrategy extends SequenceMatchStrategy | ContextMatchStrategy>(
	matches: IndexedMatches,
	confidence: number,
	strategy: TStrategy,
): { index: number; confidence: number; matchCount: number; matchIndices: number[]; strategy: TStrategy } | undefined {
	if (matches.firstMatch === undefined) {
		return undefined;
	}
	return {
		index: matches.firstMatch,
		confidence,
		matchCount: matches.matchCount,
		matchIndices: matches.matchIndices,
		strategy,
	};
}

function formatPreviewWindow(lines: string[], centerIndex: number, options: PreviewWindowOptions): string {
	const start = Math.max(0, centerIndex - options.context);
	const end = Math.min(lines.length, centerIndex + options.context + 1);
	return lines
		.slice(start, end)
		.map((line, index) => {
			const num = start + index + 1;
			const truncated = line.length > options.maxLen ? `${line.slice(0, options.maxLen - 1)}…` : line;
			return `  ${num} | ${truncated}`;
		})
		.join("\n");
}

function findExactMatchOutcome(
	content: string,
	target: string,
	excludedRanges: readonly { startIndex: number; endIndex: number }[],
): MatchOutcome | undefined {
	let firstIndex: number | undefined;
	let occurrences = 0;
	const recordedIndices: number[] = [];
	let searchStart = 0;

	while (searchStart <= content.length - target.length) {
		const index = content.indexOf(target, searchStart);
		if (index === -1) break;

		const endIndex = index + target.length;
		if (!excludedRanges.some(range => index < range.endIndex && endIndex > range.startIndex)) {
			firstIndex ??= index;
			occurrences++;
			if (recordedIndices.length < MAX_RECORDED_MATCHES) {
				recordedIndices.push(index);
			}
		}
		searchStart = endIndex;
	}

	if (firstIndex === undefined) {
		return undefined;
	}

	if (occurrences > 1) {
		const contentLines = content.split("\n");
		const occurrenceLines: number[] = [];
		const occurrencePreviews: string[] = [];
		for (const index of recordedIndices) {
			const lineNumber = content.slice(0, index).split("\n").length;
			occurrenceLines.push(lineNumber);
			occurrencePreviews.push(
				formatPreviewWindow(contentLines, lineNumber - 1, {
					context: OCCURRENCE_PREVIEW_CONTEXT,
					maxLen: OCCURRENCE_PREVIEW_MAX_LEN,
				}),
			);
		}

		return { occurrences, occurrenceLines, occurrencePreviews };
	}

	const startLine = content.slice(0, firstIndex).split("\n").length;
	return {
		match: {
			actualText: target,
			startIndex: firstIndex,
			startLine,
			confidence: 1,
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Algorithms
// ═══════════════════════════════════════════════════════════════════════════

/** Compute Levenshtein distance between two strings */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;

	let start = 0;
	const sharedLimit = Math.min(a.length, b.length);
	while (start < sharedLimit && a.charCodeAt(start) === b.charCodeAt(start)) start++;

	let aEnd = a.length;
	let bEnd = b.length;
	while (aEnd > start && bEnd > start && a.charCodeAt(aEnd - 1) === b.charCodeAt(bEnd - 1)) {
		aEnd--;
		bEnd--;
	}

	let aLength = aEnd - start;
	let bLength = bEnd - start;
	if (aLength === 0) return bLength;
	if (bLength === 0) return aLength;

	// Keep the row on the shorter string: one packed allocation and one
	// in-place update replace two boxed-number arrays.
	if (bLength > aLength) {
		const text = a;
		a = b;
		b = text;
		const length = aLength;
		aLength = bLength;
		bLength = length;
	}

	const row = new Uint32Array(bLength + 1);
	for (let column = 1; column <= bLength; column++) row[column] = column;

	for (let line = 1; line <= aLength; line++) {
		let diagonal = row[0];
		row[0] = line;
		const aCode = a.charCodeAt(start + line - 1);
		for (let column = 1; column <= bLength; column++) {
			const above = row[column];
			if (aCode === b.charCodeAt(start + column - 1)) {
				row[column] = diagonal;
			} else {
				const deletion = above + 1;
				const insertion = row[column - 1] + 1;
				const substitution = diagonal + 1;
				let distance = deletion < insertion ? deletion : insertion;
				if (substitution < distance) distance = substitution;
				row[column] = distance;
			}
			diagonal = above;
		}
	}

	return row[bLength];
}

/** Compute similarity score between two strings (0 to 1) */
export function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

// ═══════════════════════════════════════════════════════════════════════════
// Line-Based Utilities
// ═══════════════════════════════════════════════════════════════════════════

/** Compute relative indent depths for lines */
function computeRelativeIndentDepths(lines: string[]): number[] {
	const indents = lines.map(countLeadingWhitespace);
	const nonEmptyIndents: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().length > 0) {
			nonEmptyIndents.push(indents[i]);
		}
	}
	const minIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;
	const indentSteps = nonEmptyIndents.map(indent => indent - minIndent).filter(step => step > 0);
	const indentUnit = indentSteps.length > 0 ? Math.min(...indentSteps) : 1;

	return lines.map((line, index) => {
		if (line.trim().length === 0) return 0;
		if (indentUnit <= 0) return 0;
		const relativeIndent = indents[index] - minIndent;
		return Math.round(relativeIndent / indentUnit);
	});
}

/** Normalize lines for matching, optionally including indent depth */
function normalizeLines(lines: string[], includeDepth = true): string[] {
	const indentDepths = includeDepth ? computeRelativeIndentDepths(lines) : null;
	return lines.map((line, index) => {
		const trimmed = line.trim();
		const prefix = indentDepths ? `${indentDepths[index]}|` : "|";
		if (trimmed.length === 0) return prefix;
		return `${prefix}${normalizeForFuzzy(trimmed)}`;
	});
}

/** Compute character offsets for each line in content */
function computeLineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets.push(offset);
		offset += lines[i].length;
		if (i < lines.length - 1) offset += 1; // newline
	}
	return offsets;
}

// ═══════════════════════════════════════════════════════════════════════════
// Character-Level Fuzzy Match (for replace mode)
// ═══════════════════════════════════════════════════════════════════════════

interface BestFuzzyMatchResult {
	best?: FuzzyMatch;
	aboveThresholdCount: number;
	secondBestScore: number;
}

function findBestFuzzyMatchCore(
	contentLines: string[],
	targetLines: string[],
	offsets: number[],
	threshold: number,
	includeDepth: boolean,
	excludedRanges: readonly { startIndex: number; endIndex: number }[],
): BestFuzzyMatchResult {
	const targetNormalized = normalizeLines(targetLines, includeDepth);

	let best: FuzzyMatch | undefined;
	let bestScore = -1;
	let secondBestScore = -1;
	let aboveThresholdCount = 0;

	for (let start = 0; start <= contentLines.length - targetLines.length; start++) {
		const startIndex = offsets[start];
		const endLine = start + targetLines.length - 1;
		const endIndex = Math.max(startIndex + 1, offsets[endLine] + contentLines[endLine].length);
		if (excludedRanges.some(range => startIndex < range.endIndex && endIndex > range.startIndex)) {
			continue;
		}
		const windowLines = contentLines.slice(start, start + targetLines.length);
		const windowNormalized = normalizeLines(windowLines, includeDepth);
		let score = 0;
		for (let i = 0; i < targetLines.length; i++) {
			score += similarity(targetNormalized[i], windowNormalized[i]);
		}
		score = score / targetLines.length;

		if (score >= threshold) {
			aboveThresholdCount++;
		}

		if (score > bestScore) {
			secondBestScore = bestScore;
			bestScore = score;
			best = {
				actualText: windowLines.join("\n"),
				startIndex,
				startLine: start + 1,
				confidence: score,
			};
		} else if (score > secondBestScore) {
			secondBestScore = score;
		}
	}

	return { best, aboveThresholdCount, secondBestScore };
}

function findBestFuzzyMatch(
	content: string,
	target: string,
	threshold: number,
	excludedRanges: readonly { startIndex: number; endIndex: number }[],
): BestFuzzyMatchResult {
	const contentLines = content.split("\n");
	const targetLines = target.split("\n");

	if (targetLines.length === 0 || target.length === 0) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}
	if (targetLines.length > contentLines.length) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}

	const offsets = computeLineOffsets(contentLines);
	let result = findBestFuzzyMatchCore(contentLines, targetLines, offsets, threshold, true, excludedRanges);

	// Retry without indent depth if match is close but below threshold
	if (result.best && result.best.confidence < threshold && result.best.confidence >= FALLBACK_THRESHOLD) {
		const noDepthResult = findBestFuzzyMatchCore(
			contentLines,
			targetLines,
			offsets,
			threshold,
			false,
			excludedRanges,
		);
		if (noDepthResult.best && noDepthResult.best.confidence > result.best.confidence) {
			result = noDepthResult;
		}
	}

	return result;
}

/**
 * Find a match for target text within content.
 * Used primarily for replace-mode edits; excluded ranges remain invisible to exact and fuzzy matching.
 */
export function findMatch(
	content: string,
	target: string,
	options: {
		allowFuzzy: boolean;
		threshold?: number;
		excludedRanges?: readonly { startIndex: number; endIndex: number }[];
	},
): MatchOutcome {
	if (target.length === 0) {
		return {};
	}
	const excludedRanges = options.excludedRanges ?? [];

	const exactMatch = findExactMatchOutcome(content, target, excludedRanges);
	if (exactMatch) {
		return exactMatch;
	}

	// Try fuzzy match
	const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
	const { best, aboveThresholdCount, secondBestScore } = findBestFuzzyMatch(
		content,
		target,
		threshold,
		excludedRanges,
	);

	if (!best) {
		return {};
	}

	if (options.allowFuzzy && best.confidence >= threshold) {
		if (aboveThresholdCount === 1) {
			return { match: best, closest: best };
		}
		if (
			aboveThresholdCount > 1 &&
			best.confidence >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
			best.confidence - secondBestScore >= DOMINANT_FUZZY_DELTA
		) {
			return { match: best, closest: best, fuzzyMatches: aboveThresholdCount, dominantFuzzy: true };
		}
	}

	return { closest: best, fuzzyMatches: aboveThresholdCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// Line-Based Sequence Match (for patch mode)
// ═══════════════════════════════════════════════════════════════════════════

/** Check if pattern matches lines starting at index using comparison function */
function matchesAt(lines: string[], pattern: string[], i: number, compare: (a: string, b: string) => boolean): boolean {
	for (let j = 0; j < pattern.length; j++) {
		if (!compare(lines[i + j], pattern[j])) {
			return false;
		}
	}
	return true;
}

/**
 * Compute average similarity score for pre-normalized pattern lines at
 * position `i` of pre-normalized file lines.
 *
 * `minScore` is a bail threshold: when even perfect similarity on the
 * remaining lines cannot lift the average to `minScore`, returns the partial
 * average early (always ≤ the true score). The length-difference lower bound
 * on Levenshtein distance is used to skip the DP entirely for line pairs the
 * bail test already rules out.
 */
function fuzzyScoreAt(linesNorm: string[], patternNorm: string[], i: number, minScore = 0): number {
	const count = patternNorm.length;
	let totalScore = 0;
	for (let j = 0; j < count; j++) {
		const lineNorm = linesNorm[i + j];
		const patNorm = patternNorm[j];
		if (lineNorm === patNorm) {
			totalScore += 1;
			continue;
		}
		const remaining = count - j - 1;
		const maxLen = Math.max(lineNorm.length, patNorm.length);
		// similarity ≤ 1 − |lenA−lenB|/maxLen: test the bound before the DP.
		const upperBound = 1 - Math.abs(lineNorm.length - patNorm.length) / maxLen;
		if ((totalScore + upperBound + remaining) / count < minScore) return totalScore / count;
		if (upperBound > 0) totalScore += similarity(lineNorm, patNorm);
		if ((totalScore + remaining) / count < minScore) return totalScore / count;
	}
	return totalScore / count;
}

/** Check if pre-normalized line starts with pre-normalized pattern */
function normStartsWith(lineNorm: string, patternNorm: string): boolean {
	if (patternNorm.length === 0) return lineNorm.length === 0;
	return lineNorm.startsWith(patternNorm);
}

/** Check if pre-normalized line contains pre-normalized pattern as significant substring */
function normIncludes(lineNorm: string, patternNorm: string): boolean {
	if (patternNorm.length === 0) return lineNorm.length === 0;
	if (patternNorm.length < PARTIAL_MATCH_MIN_LENGTH) return false;
	if (!lineNorm.includes(patternNorm)) return false;
	return patternNorm.length / Math.max(1, lineNorm.length) >= PARTIAL_MATCH_MIN_RATIO;
}

function stripCommentPrefix(line: string): string {
	let trimmed = line.trimStart();
	if (trimmed.startsWith("/*")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("*/")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("//")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("*")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith(";")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith("/") && trimmed[1] === " ") {
		trimmed = trimmed.slice(1);
	}
	return trimmed.trimStart();
}

/**
 * Find a sequence of pattern lines within content lines.
 *
 * Attempts matches with decreasing strictness:
 * 1. Exact match
 * 2. Trailing whitespace ignored
 * 3. All whitespace trimmed
 * 4. Unicode punctuation normalized
 * 5. Prefix match (pattern is prefix of line)
 * 6. Substring match (pattern is substring of line)
 * 7. Fuzzy similarity match
 *
 * @param lines - The lines of the file content
 * @param pattern - The lines to search for
 * @param start - Starting index for the search
 * @param eof - If true, prefer matching at end of file first
 */
export function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
	options?: { allowFuzzy?: boolean },
): SequenceSearchResult {
	const allowFuzzy = options?.allowFuzzy ?? true;
	// Empty pattern matches immediately
	if (pattern.length === 0) {
		return { index: start, confidence: 1.0, strategy: "exact" };
	}

	// Pattern longer than available content cannot match
	if (pattern.length > lines.length) {
		return { index: undefined, confidence: 0 };
	}

	// Determine search start position
	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const maxStart = lines.length - pattern.length;

	// Fuzzy and partial passes compare normalizeForFuzzy forms; normalize the
	// file and pattern once per call instead of once per candidate position.
	let linesNormCache: string[] | undefined;
	let patternNormCache: string[] | undefined;
	const getLinesNorm = () => (linesNormCache ??= lines.map(normalizeForFuzzy));
	const getPatternNorm = () => (patternNormCache ??= pattern.map(normalizeForFuzzy));

	const runExactPasses = (from: number, to: number): SequenceSearchResult | undefined => {
		const comparisonPasses: Array<{
			compare: (a: string, b: string) => boolean;
			confidence: number;
			strategy: SequenceMatchStrategy;
		}> = [
			{ compare: (a, b) => a === b, confidence: 1.0, strategy: "exact" },
			{ compare: (a, b) => a.trimEnd() === b.trimEnd(), confidence: 0.99, strategy: "trim-trailing" },
			{ compare: (a, b) => a.trim() === b.trim(), confidence: 0.98, strategy: "trim" },
			{
				compare: (a, b) => stripCommentPrefix(a) === stripCommentPrefix(b),
				confidence: 0.975,
				strategy: "comment-prefix",
			},
			{
				compare: (a, b) => normalizeUnicode(a) === normalizeUnicode(b),
				confidence: 0.97,
				strategy: "unicode",
			},
		];

		for (const pass of comparisonPasses) {
			const matches = collectIndexedMatches(from, to, i => matchesAt(lines, pattern, i, pass.compare));
			const result = toSingleMatchResult(matches, pass.confidence, pass.strategy);
			if (result) {
				return result;
			}
		}

		if (!allowFuzzy) {
			return undefined;
		}

		const linesNorm = getLinesNorm();
		const patternNorm = getPatternNorm();
		const partialPasses: Array<{
			compare: (lineNorm: string, patternLineNorm: string) => boolean;
			confidence: number;
			strategy: SequenceMatchStrategy;
		}> = [
			{ compare: normStartsWith, confidence: 0.965, strategy: "prefix" },
			{ compare: normIncludes, confidence: 0.94, strategy: "substring" },
		];

		for (const pass of partialPasses) {
			const matches = collectIndexedMatches(from, to, i => matchesAt(linesNorm, patternNorm, i, pass.compare));
			const result = toAmbiguousMatchResult(matches, pass.confidence, pass.strategy);
			if (result) {
				return result;
			}
		}

		return undefined;
	};

	const primaryPassResult = runExactPasses(searchStart, maxStart);
	if (primaryPassResult) {
		return primaryPassResult;
	}

	if (eof && searchStart > start) {
		const fromStartResult = runExactPasses(start, maxStart);
		if (fromStartResult) {
			return fromStartResult;
		}
	}

	if (!allowFuzzy) {
		return { index: undefined, confidence: 0 };
	}

	// Pass 7: Fuzzy matching - find best match above threshold
	let bestScore = 0;
	let secondBestScore = 0;
	let bestIndex: number | undefined;
	const fuzzyMatches: IndexedMatches = {
		firstMatch: undefined,
		matchCount: 0,
		matchIndices: [],
	};

	const fuzzyLinesNorm = getLinesNorm();
	const fuzzyPatternNorm = getPatternNorm();
	// Positions scoring below this can neither become a fuzzy match nor affect
	// the dominant-fuzzy gap test; let fuzzyScoreAt bail early on them.
	const fuzzyBail = SEQUENCE_FUZZY_THRESHOLD - DOMINANT_FUZZY_DELTA;
	const scoreFuzzyRange = (from: number, to: number): void => {
		for (let i = from; i <= to; i++) {
			const score = fuzzyScoreAt(fuzzyLinesNorm, fuzzyPatternNorm, i, fuzzyBail);
			if (score >= SEQUENCE_FUZZY_THRESHOLD) {
				if (fuzzyMatches.firstMatch === undefined) {
					fuzzyMatches.firstMatch = i;
				}
				fuzzyMatches.matchCount++;
				if (fuzzyMatches.matchIndices.length < MAX_RECORDED_MATCHES) {
					fuzzyMatches.matchIndices.push(i);
				}
			}
			if (score > bestScore) {
				secondBestScore = bestScore;
				bestScore = score;
				bestIndex = i;
			} else if (score > secondBestScore) {
				secondBestScore = score;
			}
		}
	};

	scoreFuzzyRange(searchStart, maxStart);

	// Also search from start if eof mode started from end
	if (eof && searchStart > start) {
		scoreFuzzyRange(start, searchStart - 1);
	}

	if (bestIndex !== undefined && bestScore >= SEQUENCE_FUZZY_THRESHOLD) {
		if (
			fuzzyMatches.matchCount > 1 &&
			bestScore >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
			bestScore - secondBestScore >= DOMINANT_FUZZY_DELTA
		) {
			return {
				index: bestIndex,
				confidence: bestScore,
				matchCount: 1,
				matchIndices: fuzzyMatches.matchIndices,
				strategy: "fuzzy-dominant",
			};
		}
		return {
			index: bestIndex,
			confidence: bestScore,
			matchCount: fuzzyMatches.matchCount,
			matchIndices: fuzzyMatches.matchIndices,
			strategy: "fuzzy",
		};
	}

	// Pass 8: Character-based fuzzy matching via findMatch
	// This is the final fallback for when line-based matching fails
	const CHARACTER_MATCH_THRESHOLD = 0.92;
	const patternText = pattern.join("\n");
	const contentText = lines.slice(start).join("\n");
	const matchOutcome = findMatch(contentText, patternText, {
		allowFuzzy: true,
		threshold: CHARACTER_MATCH_THRESHOLD,
	});

	if (matchOutcome.match) {
		// Convert character index back to line index
		const matchedContent = contentText.substring(0, matchOutcome.match.startIndex);
		const lineIndex = start + matchedContent.split("\n").length - 1;
		const fallbackMatchCount = matchOutcome.occurrences ?? matchOutcome.fuzzyMatches ?? 1;
		return {
			index: lineIndex,
			confidence: matchOutcome.match.confidence,
			matchCount: fallbackMatchCount,
			strategy: "character",
		};
	}

	const fallbackMatchCount = matchOutcome.occurrences ?? matchOutcome.fuzzyMatches;
	return { index: undefined, confidence: bestScore, matchCount: fallbackMatchCount };
}

export function findClosestSequenceMatch(
	lines: string[],
	pattern: string[],
	options?: { start?: number; eof?: boolean },
): { index: number | undefined; confidence: number; strategy: SequenceMatchStrategy } {
	if (pattern.length === 0) {
		return { index: options?.start ?? 0, confidence: 1, strategy: "exact" };
	}
	if (pattern.length > lines.length) {
		return { index: undefined, confidence: 0, strategy: "fuzzy" };
	}

	const start = options?.start ?? 0;
	const eof = options?.eof ?? false;
	const maxStart = lines.length - pattern.length;
	const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
	const linesNorm = lines.map(normalizeForFuzzy);
	const patternNorm = pattern.map(normalizeForFuzzy);

	let bestIndex: number | undefined;
	let bestScore = 0;

	// Passing the running best as the bail threshold is exact: a bailed
	// position returns a value strictly below it, so it can never win.
	for (let i = searchStart; i <= maxStart; i++) {
		const score = fuzzyScoreAt(linesNorm, patternNorm, i, bestScore);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (eof && searchStart > start) {
		for (let i = start; i < searchStart; i++) {
			const score = fuzzyScoreAt(linesNorm, patternNorm, i, bestScore);
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}
	}

	return { index: bestIndex, confidence: bestScore, strategy: "fuzzy" };
}

/**
 * Find a context line in the file using progressive matching strategies.
 *
 * @param lines - The lines of the file content
 * @param context - The context line to search for
 * @param startFrom - Starting index for the search
 */
export function findContextLine(
	lines: string[],
	context: string,
	startFrom: number,
	options?: { allowFuzzy?: boolean; skipFunctionFallback?: boolean },
): ContextLineResult {
	const allowFuzzy = options?.allowFuzzy ?? true;
	const trimmedContext = context.trim();

	const endIndex = lines.length - 1;
	const exactPasses: Array<{
		confidence: number;
		strategy: ContextMatchStrategy;
		predicate: (index: number) => boolean;
	}> = [
		{ confidence: 1.0, strategy: "exact", predicate: i => lines[i] === context },
		{ confidence: 0.99, strategy: "trim", predicate: i => lines[i].trim() === trimmedContext },
	];

	for (const pass of exactPasses) {
		const matches = collectIndexedMatches(startFrom, endIndex, pass.predicate);
		const result = toAmbiguousMatchResult(matches, pass.confidence, pass.strategy);
		if (result) {
			return result;
		}
	}

	// Pass 3: Unicode normalization match
	const normalizedContext = normalizeUnicode(context);
	const unicodeMatches = collectIndexedMatches(
		startFrom,
		endIndex,
		i => normalizeUnicode(lines[i]) === normalizedContext,
	);
	const unicodeResult = toAmbiguousMatchResult(unicodeMatches, 0.98, "unicode");
	if (unicodeResult) {
		return unicodeResult;
	}

	if (!allowFuzzy) {
		return { index: undefined, confidence: 0 };
	}

	// Pass 4: Prefix match (file line starts with context)
	const contextNorm = normalizeForFuzzy(context);
	if (contextNorm.length > 0) {
		const prefixMatches = collectIndexedMatches(startFrom, endIndex, i =>
			normalizeForFuzzy(lines[i]).startsWith(contextNorm),
		);
		const prefixResult = toAmbiguousMatchResult(prefixMatches, 0.96, "prefix");
		if (prefixResult) {
			return prefixResult;
		}
	}

	// Pass 5: Substring match (file line contains context)
	// First pass: find all substring matches (ignoring ratio)
	// If exactly one match exists, accept it (uniqueness is sufficient)
	// If multiple matches, apply ratio filter to disambiguate
	if (contextNorm.length >= PARTIAL_MATCH_MIN_LENGTH) {
		const allSubstringMatches: Array<{ index: number; ratio: number }> = [];
		for (let i = startFrom; i < lines.length; i++) {
			const lineNorm = normalizeForFuzzy(lines[i]);
			if (lineNorm.includes(contextNorm)) {
				const ratio = contextNorm.length / Math.max(1, lineNorm.length);
				allSubstringMatches.push({ index: i, ratio });
			}
		}
		const matchIndices = allSubstringMatches.slice(0, 5).map(match => match.index);

		// If exactly one substring match, accept it regardless of ratio
		if (allSubstringMatches.length === 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: 1,
				matchIndices,
				strategy: "substring",
			};
		}

		// Multiple matches: filter by ratio to disambiguate
		let firstMatch: number | undefined;
		let matchCount = 0;
		for (const match of allSubstringMatches) {
			if (match.ratio >= PARTIAL_MATCH_MIN_RATIO) {
				if (firstMatch === undefined) firstMatch = match.index;
				matchCount++;
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 0.94, matchCount, matchIndices, strategy: "substring" };
		}

		// If we had substring matches but none passed ratio filter,
		// return ambiguous result so caller knows matches exist
		if (allSubstringMatches.length > 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: allSubstringMatches.length,
				matchIndices,
				strategy: "substring",
			};
		}
	}

	// Pass 6: Fuzzy match using similarity
	let bestIndex: number | undefined;
	let bestScore = 0;
	const fuzzyMatches: IndexedMatches = {
		firstMatch: undefined,
		matchCount: 0,
		matchIndices: [],
	};

	for (let i = startFrom; i < lines.length; i++) {
		const lineNorm = normalizeForFuzzy(lines[i]);
		const score = similarity(lineNorm, contextNorm);
		if (score >= CONTEXT_FUZZY_THRESHOLD) {
			if (fuzzyMatches.firstMatch === undefined) {
				fuzzyMatches.firstMatch = i;
			}
			fuzzyMatches.matchCount++;
			if (fuzzyMatches.matchIndices.length < MAX_RECORDED_MATCHES) {
				fuzzyMatches.matchIndices.push(i);
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (bestIndex !== undefined && bestScore >= CONTEXT_FUZZY_THRESHOLD) {
		return {
			index: bestIndex,
			confidence: bestScore,
			matchCount: fuzzyMatches.matchCount,
			matchIndices: fuzzyMatches.matchIndices,
			strategy: "fuzzy",
		};
	}

	if (!options?.skipFunctionFallback && trimmedContext.endsWith("()")) {
		const withParen = trimmedContext.replace(/\(\)\s*$/u, "(");
		const withoutParen = trimmedContext.replace(/\(\)\s*$/u, "");
		const parenResult = findContextLine(lines, withParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
		if (parenResult.index !== undefined || (parenResult.matchCount ?? 0) > 0) {
			return parenResult;
		}
		return findContextLine(lines, withoutParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
	}

	return { index: undefined, confidence: bestScore };
}

export const replaceEditSchema = type({
	path: "string",
	old_string: "string",
	new_string: "string",
	"replace_all?": "boolean",
});

export type ReplaceParams = typeof replaceEditSchema.infer;

/**
 * Internal batch form of {@link ReplaceParams}, produced only by the Cursor
 * exec bridge: a `pi_edit` frame carries several replacements against one
 * path but must run as a single tool lifecycle with one aggregate result.
 * Never advertised to the model — the agent loop validates model calls
 * against {@link replaceEditSchema}, which has no `edits` field.
 */
export interface ReplaceBatchParams {
	path: string;
	edits: Omit<ReplaceParams, "path">[];
}

export interface ExecuteReplaceOptions {
	session: ToolSession;
	path: string;
	params: Omit<ReplaceParams, "path">;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	/** Observes a committed content transition before result snapshots are pruned. */
	onApplied?: AppliedEditObserver;
}

export async function executeReplace(
	options: ExecuteReplaceOptions,
): Promise<AgentToolResult<EditToolDetails, ReplaceParams>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
		onApplied,
	} = options;
	const { old_string, new_string, replace_all } = params;

	enforcePlanModeWrite(session, path);

	if (old_string.length === 0) {
		throw new Error("old_string must not be empty.");
	}

	const absolutePath = resolvePlanPath(session, path);
	const rawContent = await readEditFileText(absolutePath, path);
	const { bom, text: content } = stripBom(rawContent);
	const originalEnding = detectLineEnding(content);
	const normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(old_string);
	const normalizedNewText = normalizeToLF(new_string);

	const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
		fuzzy: allowFuzzy,
		all: replace_all ?? false,
		threshold: fuzzyThreshold,
	});

	if (result.count === 0) {
		const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
			allowFuzzy,
			threshold: fuzzyThreshold,
		});

		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			throw new Error(formatOccurrenceError(path, matchOutcome));
		}

		throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
			allowFuzzy,
			threshold: fuzzyThreshold,
			fuzzyMatches: matchOutcome.fuzzyMatches,
		});
	}

	if (normalizedContent === result.content) {
		throw new Error(`Edits to ${path} resulted in no changes being made.`);
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		path,
		bom + restoreLineEndings(result.content, originalEnding),
	);

	// Route through ACP bridge when available; skips internal artifacts.
	let diagnostics: FileDiagnosticsResult | undefined;
	if (await routeWriteThroughBridge(session, path, absolutePath, finalContent, signal)) {
		// bridge handled the write; diagnostics not available via writethrough
	} else {
		diagnostics = await writethrough(absolutePath, finalContent, signal, Bun.file(absolutePath), batchRequest, dst =>
			dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined,
		);
		invalidateFsScanAfterWrite(absolutePath);
	}

	const diffResult = generateDiffString(normalizedContent, result.content, undefined, { path });
	await onApplied?.({ path: absolutePath, prev: rawContent, next: finalContent });
	const editResult = createEditResult({
		displayPath: path,
		resultPath: absolutePath,
		diff: diffResult.diff,
		firstChangedLine: diffResult.firstChangedLine,
		diagnostics,
		oldText: rawContent,
		newText: finalContent,
	});
	return toEditToolResult(editResult);
}
