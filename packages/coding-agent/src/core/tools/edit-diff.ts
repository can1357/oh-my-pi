/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.js";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

export const DEFAULT_FUZZY_THRESHOLD = 0.95;

export interface EditMatch {
	actualText: string;
	startIndex: number;
	startLine: number;
	confidence: number;
}

export interface EditMatchOutcome {
	match?: EditMatch;
	closest?: EditMatch;
	occurrences?: number;
	fuzzyMatches?: number;
}

function countLeadingWhitespace(line: string): number {
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === " " || char === "\t") {
			count++;
			continue;
		}
		break;
	}
	return count;
}

function computeRelativeIndentDepths(lines: string[]): number[] {
	const indents = lines.map(countLeadingWhitespace);
	const nonEmptyIndents: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().length > 0) {
			nonEmptyIndents.push(indents[i]);
		}
	}
	const minIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;
	const indentSteps = nonEmptyIndents.map((indent) => indent - minIndent).filter((step) => step > 0);
	const indentUnit = indentSteps.length > 0 ? Math.min(...indentSteps) : 1;

	return lines.map((line, index) => {
		if (line.trim().length === 0) {
			return 0;
		}
		if (indentUnit <= 0) {
			return 0;
		}
		const relativeIndent = indents[index] - minIndent;
		return Math.round(relativeIndent / indentUnit);
	});
}

function normalizeLinesForMatch(lines: string[]): string[] {
	const indentDepths = computeRelativeIndentDepths(lines);
	return lines.map((line, index) => {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			return `${indentDepths[index]}|`;
		}
		const collapsed = trimmed.replace(/[ \t]+/g, " ");
		return `${indentDepths[index]}|${collapsed}`;
	});
}

function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

function similarityScore(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) {
		return 1;
	}
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

function computeLineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets.push(offset);
		offset += lines[i].length;
		if (i < lines.length - 1) {
			offset += 1;
		}
	}
	return offsets;
}

function findBestFuzzyMatch(
	content: string,
	target: string,
	threshold: number,
): { best?: EditMatch; aboveThresholdCount: number } {
	const contentLines = content.split("\n");
	const targetLines = target.split("\n");
	if (targetLines.length === 0 || target.length === 0) {
		return { aboveThresholdCount: 0 };
	}
	if (targetLines.length > contentLines.length) {
		return { aboveThresholdCount: 0 };
	}

	const targetNormalized = normalizeLinesForMatch(targetLines);
	const offsets = computeLineOffsets(contentLines);

	let best: EditMatch | undefined;
	let bestScore = -1;
	let aboveThresholdCount = 0;

	for (let start = 0; start <= contentLines.length - targetLines.length; start++) {
		const windowLines = contentLines.slice(start, start + targetLines.length);
		const windowNormalized = normalizeLinesForMatch(windowLines);
		let score = 0;
		for (let i = 0; i < targetLines.length; i++) {
			score += similarityScore(targetNormalized[i], windowNormalized[i]);
		}
		score = score / targetLines.length;

		if (score >= threshold) {
			aboveThresholdCount++;
		}

		if (score > bestScore) {
			bestScore = score;
			best = {
				actualText: windowLines.join("\n"),
				startIndex: offsets[start],
				startLine: start + 1,
				confidence: score,
			};
		}
	}

	return { best, aboveThresholdCount };
}

export function findEditMatch(
	content: string,
	target: string,
	options: { allowFuzzy: boolean; similarityThreshold?: number },
): EditMatchOutcome {
	if (target.length === 0) {
		return {};
	}

	const exactIndex = content.indexOf(target);
	if (exactIndex !== -1) {
		const occurrences = content.split(target).length - 1;
		if (occurrences > 1) {
			return { occurrences };
		}
		const startLine = content.slice(0, exactIndex).split("\n").length;
		return {
			match: {
				actualText: target,
				startIndex: exactIndex,
				startLine,
				confidence: 1,
			},
		};
	}

	const threshold = options.similarityThreshold ?? DEFAULT_FUZZY_THRESHOLD;
	const { best, aboveThresholdCount } = findBestFuzzyMatch(content, target, threshold);
	if (!best) {
		return {};
	}

	if (options.allowFuzzy && best.confidence >= threshold && aboveThresholdCount === 1) {
		return { match: best, closest: best };
	}

	return { closest: best, fuzzyMatches: aboveThresholdCount };
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

export function formatEditMatchError(
	path: string,
	normalizedOldText: string,
	closest: EditMatch | undefined,
	options: { allowFuzzy: boolean; similarityThreshold: number; fuzzyMatches?: number },
): string {
	if (!closest) {
		return options.allowFuzzy
			? `Could not find a close enough match in ${path}.`
			: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
	}

	const similarity = Math.round(closest.confidence * 100);
	const oldLines = normalizedOldText.split("\n");
	const actualLines = closest.actualText.split("\n");
	const { oldLine, newLine } = findFirstDifferentLine(oldLines, actualLines);
	const thresholdPercent = Math.round(options.similarityThreshold * 100);

	const hint = options.allowFuzzy
		? options.fuzzyMatches && options.fuzzyMatches > 1
			? `Found ${options.fuzzyMatches} high-confidence matches. Provide more context to make it unique.`
			: `Closest match was below the ${thresholdPercent}% similarity threshold.`
		: "Hint: Use fuzzy=true to accept high-confidence matches.";

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

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				// Show context
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					// Show only last N lines as leading context
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					// Show only first N lines as trailing context
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				// Add ellipsis if we skipped lines at start
				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// Update line numbers for the skipped leading context
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				// Add ellipsis if we skipped lines at end
				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// Update line numbers for the skipped trailing context
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for an edit operation without applying it.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
	fuzzy = false,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			return { error: `File not found: ${path}` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);

		const normalizedContent = normalizeToLF(content);
		const normalizedOldText = normalizeToLF(oldText);
		const normalizedNewText = normalizeToLF(newText);

		const matchOutcome = findEditMatch(normalizedContent, normalizedOldText, {
			allowFuzzy: fuzzy,
			similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
		});

		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			return {
				error: `Found ${matchOutcome.occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
			};
		}

		if (!matchOutcome.match) {
			return {
				error: formatEditMatchError(path, normalizedOldText, matchOutcome.closest, {
					allowFuzzy: fuzzy,
					similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
					fuzzyMatches: matchOutcome.fuzzyMatches,
				}),
			};
		}

		const match = matchOutcome.match;

		// Compute the new content
		const normalizedNewContent =
			normalizedContent.substring(0, match.startIndex) +
			normalizedNewText +
			normalizedContent.substring(match.startIndex + match.actualText.length);

		// Check if it would actually change anything
		if (normalizedContent === normalizedNewContent) {
			return {
				error: `No changes would be made to ${path}. The replacement produces identical content.`,
			};
		}

		// Generate the diff
		return generateDiffString(normalizedContent, normalizedNewContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
