/**
 * Patch application logic for the edit tool.
 *
 * Applies parsed diff hunks to file content using fuzzy matching
 * for robust handling of whitespace and formatting differences.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import {
	type FileDiagnosticsResult,
	flushLspWritethroughBatch,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
} from "../../lsp";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../../lsp/client";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { assertEditableFile } from "../../tools/auto-generated-guard";
import {
	deleteFileWithFallback,
	hasFileWriteFallback,
	isPermissionDeniedError,
	writeFileWithFallback,
} from "../../tools/file-write-fallback";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../../tools/fs-cache-invalidation";
import { resolveToCwd } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { ToolError } from "../../tools/tool-errors";
import type { AppliedEditObserver } from "../blackbox";
import {
	ApplyPatchError,
	type DiffHunk,
	generateUnifiedDiffString,
	normalizeCreateContent,
	parseDiffHunks,
} from "../diff";
import {
	adjustIndentation,
	convertLeadingTabsToSpaces,
	countLeadingWhitespace,
	detectLineEnding,
	getLeadingWhitespace,
	normalizeForFuzzy,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../normalize";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { EditToolDetails, LspBatchRequest } from "../renderer";
import { createEditResult, type EditPreviewSource, toEditToolResult } from "../result";
import {
	type ContextLineResult,
	DEFAULT_FUZZY_THRESHOLD,
	findClosestSequenceMatch,
	findContextLine,
	findMatch,
	type SequenceSearchResult,
	seekSequence,
} from "./replace";

export type Operation = "create" | "delete" | "update";

export interface PatchInput {
	path: string;
	op: Operation;
	rename?: string;
	diff?: string;
}

export interface FileSystem {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	readBinary?: (path: string) => Promise<Uint8Array>;
	write(path: string, content: string): Promise<void>;
	delete(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

interface FileChange {
	type: Operation;
	path: string;
	newPath?: string;
	oldContent?: string;
	newContent?: string;
}

export interface ApplyPatchResult {
	change: FileChange;
	warnings?: string[];
}

export interface ApplyPatchOptions {
	cwd: string;
	dryRun?: boolean;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	fs?: FileSystem;
	/**
	 * Permit `op: "create"` to replace an existing file (full-file overwrite).
	 * The JSON `patch` edit mode sanctions create-as-overwrite for major
	 * restructures (see prompts/tools/patch.md); the Codex `apply_patch`
	 * envelope documents `*** Add File` as strictly non-overwriting and must
	 * leave this unset.
	 */
	allowCreateOverwrite?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Default File System
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a patch target's parent directory, tolerating a permission denial when a
 * file-write fallback is registered.
 *
 * `apply_patch` mkdirs the parent before writing, so under a sandbox that denies
 * the out-of-tree path this throws before the write — and therefore before
 * {@link writeFileWithFallback} — is ever reached, leaving the fallback unable to
 * broker a `create` or a rename-move into a new directory. Swallowing only a
 * permission denial, and only with a handler installed, hands control to the write,
 * which reports the denial through the seam. Without a handler the error propagates
 * exactly as before.
 */
async function mkdirAllowingFallback(dir: string): Promise<void> {
	try {
		await fs.promises.mkdir(dir, { recursive: true });
	} catch (error) {
		if (!hasFileWriteFallback() || !isPermissionDeniedError(error)) throw error;
	}
}

/** Default filesystem implementation using Bun APIs */
export const defaultFileSystem: FileSystem = {
	async exists(path: string): Promise<boolean> {
		return Bun.file(path).exists();
	},
	async read(path: string): Promise<string> {
		return readEditFileText(path, path);
	},
	async readBinary(path: string): Promise<Uint8Array> {
		return fs.promises.readFile(path);
	},
	async write(path: string, content: string): Promise<void> {
		await writeFileWithFallback(path, await serializeEditFileText(path, path, content));
	},
	async delete(path: string): Promise<void> {
		await deleteFileWithFallback(path);
	},
	async mkdir(path: string): Promise<void> {
		await mkdirAllowingFallback(path);
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Internal Types
// ═══════════════════════════════════════════════════════════════════════════

interface Replacement {
	startIndex: number;
	oldLen: number;
	newLines: string[];
}

type HunkVariantKind = "trim-common" | "dedupe-shared" | "collapse-repeated" | "single-line";

interface HunkVariant {
	oldLines: string[];
	newLines: string[];
	kind: HunkVariantKind;
}

function isBlankLine(line: string): boolean {
	return line.trim().length === 0;
}

function areEqualLines(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function areEqualTrimmedLines(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i].trim() !== right[i].trim()) return false;
	}
	return true;
}

function getIndentChar(lines: string[]): string {
	for (const line of lines) {
		const ws = getLeadingWhitespace(line);
		if (ws.length > 0) return ws[0];
	}
	return " ";
}

function collectIndentDeltas(oldLines: string[], actualLines: string[]): number[] {
	const deltas: number[] = [];
	const lineCount = Math.min(oldLines.length, actualLines.length);
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldLines[i];
		const actualLine = actualLines[i];
		if (isBlankLine(oldLine) || isBlankLine(actualLine)) continue;
		deltas.push(countLeadingWhitespace(actualLine) - countLeadingWhitespace(oldLine));
	}
	return deltas;
}

function applyIndentDelta(lines: string[], delta: number, indentChar: string): string[] {
	return lines.map(line => {
		if (isBlankLine(line)) return line;
		if (delta > 0) return indentChar.repeat(delta) + line;
		const toRemove = Math.min(-delta, countLeadingWhitespace(line));
		return line.slice(toRemove);
	});
}

function canConvertTabsToSpaces(oldLines: string[], actualLines: string[], spacesPerTab: number): boolean {
	const lineCount = Math.min(oldLines.length, actualLines.length);
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldLines[i];
		const actualLine = actualLines[i];
		if (isBlankLine(oldLine) || isBlankLine(actualLine)) continue;
		const oldIndent = getLeadingWhitespace(oldLine);
		const actualIndent = getLeadingWhitespace(actualLine);
		if (oldIndent.length === 0) continue;
		if (actualIndent.length !== oldIndent.length * spacesPerTab) {
			return false;
		}
	}
	return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Replacement Computation
// ═══════════════════════════════════════════════════════════════════════════

/** Adjust indentation of newLines to match the delta between patternLines and actualLines */
function adjustLinesIndentation(patternLines: string[], actualLines: string[], newLines: string[]): string[] {
	if (patternLines.length === 0 || actualLines.length === 0 || newLines.length === 0) {
		return newLines;
	}

	// If pattern already matches actual exactly (including indentation), preserve agent's intended changes
	if (areEqualLines(patternLines, actualLines)) {
		return newLines;
	}

	// If the patch is purely an indentation change (same trimmed content), apply exactly as specified
	if (areEqualTrimmedLines(patternLines, newLines)) {
		return newLines;
	}

	// Detect indent character from actual content
	const indentChar = getIndentChar(actualLines);

	let patternTabOnly = true;
	let actualSpaceOnly = true;
	let patternSpaceOnly = true;
	let actualTabOnly = true;
	let patternMixed = false;
	let actualMixed = false;

	for (const line of patternLines) {
		if (line.trim().length === 0) continue;
		const ws = getLeadingWhitespace(line);
		if (ws.includes(" ")) patternTabOnly = false;
		if (ws.includes("\t")) patternSpaceOnly = false;
		if (ws.includes(" ") && ws.includes("\t")) patternMixed = true;
	}

	for (const line of actualLines) {
		if (line.trim().length === 0) continue;
		const ws = getLeadingWhitespace(line);
		if (ws.includes("\t")) actualSpaceOnly = false;
		if (ws.includes(" ")) actualTabOnly = false;
		if (ws.includes(" ") && ws.includes("\t")) actualMixed = true;
	}

	if (!patternMixed && !actualMixed && patternTabOnly && actualSpaceOnly) {
		let ratio: number | undefined;
		const lineCount = Math.min(patternLines.length, actualLines.length);
		let consistent = true;
		for (let i = 0; i < lineCount; i++) {
			const patternLine = patternLines[i];
			const actualLine = actualLines[i];
			if (patternLine.trim().length === 0 || actualLine.trim().length === 0) continue;
			const patternIndent = countLeadingWhitespace(patternLine);
			const actualIndent = countLeadingWhitespace(actualLine);
			if (patternIndent === 0) continue;
			if (actualIndent % patternIndent !== 0) {
				consistent = false;
				break;
			}
			const nextRatio = actualIndent / patternIndent;
			if (!ratio) {
				ratio = nextRatio;
			} else if (ratio !== nextRatio) {
				consistent = false;
				break;
			}
		}

		if (consistent && ratio && canConvertTabsToSpaces(patternLines, actualLines, ratio)) {
			return convertLeadingTabsToSpaces(newLines.join("\n"), ratio).split("\n");
		}
	}

	// Reverse: pattern uses spaces, actual uses tabs — infer spaces = tabs * width + offset
	// Collect (tabs, spaces) pairs from matched lines to solve for the model's tab rendering.
	// With one data point: spaces = tabs * width (offset=0).
	// With two+: solve ax + b via pairs with distinct tab counts.
	if (!patternMixed && !actualMixed && patternSpaceOnly && actualTabOnly) {
		const samples = new Map<number, number>(); // tabs -> spaces
		const lineCount = Math.min(patternLines.length, actualLines.length);
		let consistent = true;
		for (let i = 0; i < lineCount; i++) {
			const patternLine = patternLines[i];
			const actualLine = actualLines[i];
			if (patternLine.trim().length === 0 || actualLine.trim().length === 0) continue;
			const spaces = countLeadingWhitespace(patternLine);
			const tabs = countLeadingWhitespace(actualLine);
			if (tabs === 0) continue;
			const existing = samples.get(tabs);
			if (existing !== undefined && existing !== spaces) {
				consistent = false;
				break;
			}
			samples.set(tabs, spaces);
		}

		if (consistent && samples.size > 0) {
			let tabWidth: number | undefined;
			let offset = 0;

			if (samples.size === 1) {
				// One level: assume offset=0, width = spaces / tabs
				const [[tabs, spaces]] = samples;
				if (spaces % tabs === 0) {
					tabWidth = spaces / tabs;
				}
			} else {
				// Two+ levels: solve via any two distinct pairs
				// spaces = tabs * width + offset  =>  width = (s2 - s1) / (t2 - t1)
				const entries = [...samples.entries()];
				const [t1, s1] = entries[0];
				const [t2, s2] = entries[1];
				if (t1 !== t2) {
					const w = (s2 - s1) / (t2 - t1);
					if (w > 0 && Number.isInteger(w)) {
						const b = s1 - t1 * w;
						// Validate all samples against this model
						let valid = true;
						for (const [t, s] of samples) {
							if (t * w + b !== s) {
								valid = false;
								break;
							}
						}
						if (valid) {
							tabWidth = w;
							offset = b;
						}
					}
				}
			}

			if (tabWidth !== undefined && tabWidth > 0) {
				const converted = newLines.map(line => {
					if (line.trim().length === 0) return line;
					const ws = countLeadingWhitespace(line);
					if (ws === 0) return line;
					// Reverse: tabs = (spaces - offset) / width
					const adjusted = ws - offset;
					if (adjusted >= 0 && adjusted % tabWidth! === 0) {
						return "\t".repeat(adjusted / tabWidth!) + line.slice(ws);
					}
					// Partial tab — keep remainder as spaces
					const tabCount = Math.floor(adjusted / tabWidth!);
					const remainder = adjusted - tabCount * tabWidth!;
					if (tabCount >= 0) {
						return "\t".repeat(tabCount) + " ".repeat(remainder) + line.slice(ws);
					}
					return line;
				});
				return converted;
			}
		}
	}

	// Build a map from trimmed content to actual lines (by content, not position)
	// This handles fuzzy matches where pattern and actual may not be positionally aligned
	const contentToActualLines = new Map<string, string[]>();
	for (const line of actualLines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const arr = contentToActualLines.get(trimmed);
		if (arr) {
			arr.push(line);
		} else {
			contentToActualLines.set(trimmed, [line]);
		}
	}

	let patternMin = Infinity;
	for (const line of patternLines) {
		if (line.trim().length === 0) continue;
		patternMin = Math.min(patternMin, countLeadingWhitespace(line));
	}
	if (patternMin === Infinity) {
		patternMin = 0;
	}

	const deltas = collectIndentDeltas(patternLines, actualLines);
	const delta = deltas.length > 0 && deltas.every(value => value === deltas[0]) ? deltas[0] : undefined;

	// Track which actual lines we've used to handle duplicate content correctly
	const usedActualLines = new Map<string, number>(); // trimmed content -> count used

	return newLines.map(newLine => {
		if (newLine.trim().length === 0) {
			return newLine;
		}

		const trimmed = newLine.trim();
		const matchingActualLines = contentToActualLines.get(trimmed);

		// Check if this is a context line (same trimmed content exists in actual)
		if (matchingActualLines && matchingActualLines.length > 0) {
			if (matchingActualLines.length === 1) {
				return matchingActualLines[0];
			}
			if (matchingActualLines.includes(newLine)) {
				return newLine;
			}
			const usedCount = usedActualLines.get(trimmed) ?? 0;
			if (usedCount < matchingActualLines.length) {
				usedActualLines.set(trimmed, usedCount + 1);
				// Use actual file content directly for context lines
				return matchingActualLines[usedCount];
			}
		}

		// This is a new/added line - apply consistent delta if safe
		if (delta && delta !== 0) {
			const newIndent = countLeadingWhitespace(newLine);
			if (newIndent === patternMin) {
				return applyIndentDelta([newLine], delta, indentChar)[0];
			}
		}
		return newLine;
	});
}

function trimCommonContext(oldLines: string[], newLines: string[]): HunkVariant | undefined {
	let start = 0;
	let endOld = oldLines.length;
	let endNew = newLines.length;

	while (start < endOld && start < endNew && oldLines[start] === newLines[start]) {
		start++;
	}

	while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
		endOld--;
		endNew--;
	}

	if (start === 0 && endOld === oldLines.length && endNew === newLines.length) {
		return undefined;
	}

	const trimmedOld = oldLines.slice(start, endOld);
	const trimmedNew = newLines.slice(start, endNew);
	if (trimmedOld.length === 0 && trimmedNew.length === 0) {
		return undefined;
	}
	return { oldLines: trimmedOld, newLines: trimmedNew, kind: "trim-common" };
}

function collapseConsecutiveSharedLines(oldLines: string[], newLines: string[]): HunkVariant | undefined {
	const newSet = new Set(newLines);
	const shared = new Set(oldLines.filter(line => newSet.has(line)));
	const collapse = (lines: string[]): string[] => {
		const out: string[] = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			out.push(line);
			let j = i + 1;
			while (j < lines.length && lines[j] === line && shared.has(line)) {
				j++;
			}
			i = j;
		}
		return out;
	};

	const collapsedOld = collapse(oldLines);
	const collapsedNew = collapse(newLines);
	if (collapsedOld.length === oldLines.length && collapsedNew.length === newLines.length) {
		return undefined;
	}
	return { oldLines: collapsedOld, newLines: collapsedNew, kind: "dedupe-shared" };
}

function collapseRepeatedBlocks(oldLines: string[], newLines: string[]): HunkVariant | undefined {
	const newSet = new Set(newLines);
	const shared = new Set(oldLines.filter(line => newSet.has(line)));
	const collapse = (lines: string[]): string[] => {
		const output = [...lines];
		let changed = false;
		let i = 0;
		while (i < output.length) {
			let collapsed = false;
			// Only blocks whose lines are all shared are collapsible; if the first line
			// is not shared no size can match, so skip the size search entirely.
			if (shared.has(output[i])) {
				for (let size = Math.floor((output.length - i) / 2); size >= 2; size--) {
					let same = true;
					for (let idx = 0; idx < size; idx++) {
						if (output[i + idx] !== output[i + size + idx] || !shared.has(output[i + idx])) {
							same = false;
							break;
						}
					}
					if (same) {
						output.splice(i + size, size);
						changed = true;
						collapsed = true;
						break;
					}
				}
			}
			if (!collapsed) {
				i++;
			}
		}
		return changed ? output : lines;
	};

	const collapsedOld = collapse(oldLines);
	const collapsedNew = collapse(newLines);
	if (collapsedOld.length === oldLines.length && collapsedNew.length === newLines.length) {
		return undefined;
	}
	return { oldLines: collapsedOld, newLines: collapsedNew, kind: "collapse-repeated" };
}

function reduceToSingleLineChange(oldLines: string[], newLines: string[]): HunkVariant | undefined {
	if (oldLines.length !== newLines.length || oldLines.length === 0) return undefined;
	let changedIndex: number | undefined;
	for (let i = 0; i < oldLines.length; i++) {
		if (oldLines[i] !== newLines[i]) {
			if (changedIndex !== undefined) return undefined;
			changedIndex = i;
		}
	}
	if (changedIndex === undefined) return undefined;
	return { oldLines: [oldLines[changedIndex]], newLines: [newLines[changedIndex]], kind: "single-line" };
}

function buildFallbackVariants(hunk: DiffHunk): HunkVariant[] {
	const variants: HunkVariant[] = [];
	const base: HunkVariant = { oldLines: hunk.oldLines, newLines: hunk.newLines, kind: "trim-common" };

	const trimmed = trimCommonContext(base.oldLines, base.newLines);
	if (trimmed) variants.push(trimmed);

	const deduped = collapseConsecutiveSharedLines(
		trimmed?.oldLines ?? base.oldLines,
		trimmed?.newLines ?? base.newLines,
	);
	if (deduped) variants.push(deduped);

	const collapsed = collapseRepeatedBlocks(
		deduped?.oldLines ?? trimmed?.oldLines ?? base.oldLines,
		deduped?.newLines ?? trimmed?.newLines ?? base.newLines,
	);
	if (collapsed) variants.push(collapsed);

	const singleLine = reduceToSingleLineChange(trimmed?.oldLines ?? base.oldLines, trimmed?.newLines ?? base.newLines);
	if (singleLine) variants.push(singleLine);

	const seen = new Set<string>();
	return variants.filter(variant => {
		if (variant.oldLines.length === 0 && variant.newLines.length === 0) return false;
		const key = `${variant.oldLines.join("\n")}||${variant.newLines.join("\n")}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function filterFallbackVariants(variants: HunkVariant[], allowAggressive: boolean): HunkVariant[] {
	if (allowAggressive) return variants;
	return variants.filter(variant => variant.kind !== "collapse-repeated" && variant.kind !== "single-line");
}

function findContextRelativeMatch(
	lines: string[],
	patternLine: string,
	contextIndex: number,
	preferSecondForwardMatch: boolean,
): number | undefined {
	const trimmed = patternLine.trim();
	const forwardMatches: number[] = [];
	for (let i = contextIndex + 1; i < lines.length; i++) {
		if (lines[i].trim() === trimmed) {
			forwardMatches.push(i);
		}
	}
	if (forwardMatches.length > 0) {
		if (preferSecondForwardMatch && forwardMatches.length > 1) {
			return forwardMatches[1];
		}
		return forwardMatches[0];
	}
	for (let i = contextIndex - 1; i >= 0; i--) {
		if (lines[i].trim() === trimmed) {
			return i;
		}
	}
	return undefined;
}

const AMBIGUITY_HINT_WINDOW = 200;
const MATCH_PREVIEW_CONTEXT = 2;
const MATCH_PREVIEW_MAX_LEN = 80;

function formatSequenceMatchPreview(lines: string[], startIdx: number): string {
	const start = Math.max(0, startIdx - MATCH_PREVIEW_CONTEXT);
	const end = Math.min(lines.length, startIdx + MATCH_PREVIEW_CONTEXT + 1);
	const previewLines = lines.slice(start, end);
	return previewLines
		.map((line, i) => {
			const num = start + i + 1;
			const truncated = line.length > MATCH_PREVIEW_MAX_LEN ? `${line.slice(0, MATCH_PREVIEW_MAX_LEN - 1)}…` : line;
			return `  ${num} | ${truncated}`;
		})
		.join("\n");
}

function formatSequenceMatchPreviews(
	lines: string[],
	matchIndices: number[] | undefined,
	matchCount: number | undefined,
): string | undefined {
	if (!matchIndices || matchIndices.length === 0) return undefined;
	const previews = matchIndices.map(index => formatSequenceMatchPreview(lines, index));
	const moreMsg =
		matchCount && matchCount > matchIndices.length ? ` (showing first ${matchIndices.length} of ${matchCount})` : "";
	return `${previews.join("\n\n")}${moreMsg}`;
}

function chooseHintedMatch(
	matchIndices: number[] | undefined,
	hintIndex: number | undefined,
	window: number,
): number | undefined {
	if (!matchIndices || matchIndices.length === 0 || hintIndex === undefined) return undefined;
	const candidates = matchIndices.filter(index => Math.abs(index - hintIndex) <= window);
	if (candidates.length === 1) return candidates[0];
	return undefined;
}

/** Get hint index from hunk's line number */
function getHunkHintIndex(hunk: DiffHunk, currentIndex: number): number | undefined {
	if (hunk.oldStartLine === undefined) return undefined;
	const hintIndex = Math.max(0, hunk.oldStartLine - 1);
	return hintIndex >= currentIndex ? hintIndex : undefined;
}

/**
 * Find hierarchical context in file lines.
 *
 * Handles three formats:
 * 1. Simple context: "function foo" - find this line
 * 2. Hierarchical (newline): "class Foo\nmethod" - find class, then method after it
 * 3. Hierarchical (space): "class Foo method" - try as literal first, then split and search
 *
 * @returns The result from finding the final (innermost) context, or undefined if not found
 */
function findHierarchicalContext(
	lines: string[],
	context: string,
	startFrom: number,
	lineHint: number | undefined,
	allowFuzzy: boolean,
): ContextLineResult {
	// Check for newline-separated hierarchical contexts (from nested @@ anchors)
	if (context.includes("\n")) {
		const parts = context
			.split("\n")
			.map(p => p.trim())
			.filter(p => p.length > 0);
		let currentStart = startFrom;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;

			const result = findContextLine(lines, part, currentStart, { allowFuzzy });

			if (result.matchCount !== undefined && result.matchCount > 1) {
				if (isLast && lineHint !== undefined) {
					const hintStart = Math.max(0, lineHint - 1);
					if (hintStart >= currentStart) {
						const hintedResult = findContextLine(lines, part, hintStart, { allowFuzzy });
						if (hintedResult.index !== undefined) {
							return { ...hintedResult, matchCount: 1, matchIndices: [hintedResult.index] };
						}
					}
				}
				return {
					index: undefined,
					confidence: result.confidence,
					matchCount: result.matchCount,
					matchIndices: result.matchIndices,
					strategy: result.strategy,
				};
			}

			if (result.index === undefined) {
				if (isLast && lineHint !== undefined) {
					const hintStart = Math.max(0, lineHint - 1);
					if (hintStart >= currentStart) {
						const hintedResult = findContextLine(lines, part, hintStart, { allowFuzzy });
						if (hintedResult.index !== undefined) {
							return { ...hintedResult, matchCount: 1, matchIndices: [hintedResult.index] };
						}
					}
				}
				return { index: undefined, confidence: result.confidence };
			}

			if (isLast) {
				return result;
			}
			currentStart = result.index + 1;
		}
		return { index: undefined, confidence: 0 };
	}

	// Try literal context first
	const spaceParts = context.split(/\s+/).filter(p => p.length > 0);
	const hasSignatureChars = /[(){}[\]]/.test(context);
	if (!hasSignatureChars && spaceParts.length > 2) {
		const outer = spaceParts.slice(0, -1).join(" ");
		const inner = spaceParts[spaceParts.length - 1];
		const outerResult = findContextLine(lines, outer, startFrom, { allowFuzzy });
		if (outerResult.matchCount !== undefined && outerResult.matchCount > 1) {
			return {
				index: undefined,
				confidence: outerResult.confidence,
				matchCount: outerResult.matchCount,
				matchIndices: outerResult.matchIndices,
				strategy: outerResult.strategy,
			};
		}
		if (outerResult.index !== undefined) {
			const innerResult = findContextLine(lines, inner, outerResult.index + 1, { allowFuzzy });
			if (innerResult.index !== undefined) {
				return innerResult.matchCount && innerResult.matchCount > 1
					? { ...innerResult, matchCount: 1, matchIndices: [innerResult.index] }
					: innerResult;
			}
			if (innerResult.matchCount !== undefined && innerResult.matchCount > 1) {
				return {
					...innerResult,
					matchCount: 1,
					matchIndices: innerResult.index !== undefined ? [innerResult.index] : innerResult.matchIndices,
				};
			}
		}
	}

	const result = findContextLine(lines, context, startFrom, { allowFuzzy });

	// If line hint exists and result is ambiguous or missing, try from hint
	if ((result.index === undefined || (result.matchCount ?? 0) > 1) && lineHint !== undefined) {
		const hintStart = Math.max(0, lineHint - 1);
		const hintedResult = findContextLine(lines, context, hintStart, { allowFuzzy });
		if (hintedResult.index !== undefined) {
			return { ...hintedResult, matchCount: 1, matchIndices: [hintedResult.index] };
		}
	}

	// If found uniquely, return it
	if (result.index !== undefined && (result.matchCount ?? 0) <= 1) {
		return result;
	}
	if (result.matchCount !== undefined && result.matchCount > 1) {
		return result;
	}

	// Try from beginning if not found from current position
	if (result.index === undefined && startFrom !== 0) {
		const fromStartResult = findContextLine(lines, context, 0, { allowFuzzy });
		if (fromStartResult.index !== undefined && (fromStartResult.matchCount ?? 0) <= 1) {
			return fromStartResult;
		}
		if (fromStartResult.matchCount !== undefined && fromStartResult.matchCount > 1) {
			return fromStartResult;
		}
	}

	// Fallback: try space-separated hierarchical matching
	// e.g., "class PatchTool constructor" -> find "class PatchTool", then "constructor" after it
	if (!hasSignatureChars && spaceParts.length > 1) {
		const outer = spaceParts.slice(0, -1).join(" ");
		const inner = spaceParts[spaceParts.length - 1];
		const outerResult = findContextLine(lines, outer, startFrom, { allowFuzzy });

		if (outerResult.matchCount !== undefined && outerResult.matchCount > 1) {
			return {
				index: undefined,
				confidence: outerResult.confidence,
				matchCount: outerResult.matchCount,
				matchIndices: outerResult.matchIndices,
				strategy: outerResult.strategy,
			};
		}

		if (outerResult.index === undefined) {
			return { index: undefined, confidence: outerResult.confidence };
		}

		const innerResult = findContextLine(lines, inner, outerResult.index + 1, { allowFuzzy });
		if (innerResult.index !== undefined) {
			return innerResult.matchCount && innerResult.matchCount > 1
				? { ...innerResult, matchCount: 1, matchIndices: [innerResult.index] }
				: innerResult;
		}
		if (innerResult.matchCount !== undefined && innerResult.matchCount > 1) {
			return {
				...innerResult,
				matchCount: 1,
				matchIndices: innerResult.index !== undefined ? [innerResult.index] : innerResult.matchIndices,
			};
		}
	}

	return result;
}

/** Find sequence with optional hint position, returning full search result */
function findSequenceWithHint(
	lines: string[],
	pattern: string[],
	currentIndex: number,
	hintIndex: number | undefined,
	eof: boolean,
	allowFuzzy: boolean,
): SequenceSearchResult {
	// Prefer content-based search starting from currentIndex
	const primaryResult = seekSequence(lines, pattern, currentIndex, eof, { allowFuzzy });
	if (
		primaryResult.matchCount &&
		primaryResult.matchCount > 1 &&
		hintIndex !== undefined &&
		hintIndex !== currentIndex
	) {
		const hintedResult = seekSequence(lines, pattern, hintIndex, eof, { allowFuzzy });
		if (hintedResult.index !== undefined && (hintedResult.matchCount ?? 1) <= 1) {
			return hintedResult;
		}
		if (hintedResult.matchCount && hintedResult.matchCount > 1) {
			return hintedResult;
		}
	}
	if (primaryResult.index !== undefined || (primaryResult.matchCount && primaryResult.matchCount > 1)) {
		return primaryResult;
	}

	// Use line hint as a secondary bias only if needed
	if (hintIndex !== undefined && hintIndex !== currentIndex) {
		const hintedResult = seekSequence(lines, pattern, hintIndex, eof, { allowFuzzy });
		if (hintedResult.index !== undefined || (hintedResult.matchCount && hintedResult.matchCount > 1)) {
			return hintedResult;
		}
	}

	// Last resort: search from beginning (handles out-of-order hunks)
	if (currentIndex !== 0) {
		const fromStartResult = seekSequence(lines, pattern, 0, eof, { allowFuzzy });
		if (fromStartResult.index !== undefined || (fromStartResult.matchCount && fromStartResult.matchCount > 1)) {
			return fromStartResult;
		}
	}

	return primaryResult;
}

function attemptSequenceFallback(
	lines: string[],
	hunk: DiffHunk,
	currentIndex: number,
	lineHint: number | undefined,
	allowFuzzy: boolean,
	allowAggressiveFallbacks: boolean,
): number | undefined {
	if (hunk.oldLines.length === 0) return undefined;
	const matchHint = getHunkHintIndex(hunk, currentIndex);
	const fallbackResult = findSequenceWithHint(
		lines,
		hunk.oldLines,
		currentIndex,
		matchHint ?? lineHint,
		false,
		allowFuzzy,
	);
	if (fallbackResult.index !== undefined && (fallbackResult.matchCount ?? 1) <= 1) {
		const nextIndex = fallbackResult.index + 1;
		if (nextIndex <= lines.length - hunk.oldLines.length) {
			const secondMatch = seekSequence(lines, hunk.oldLines, nextIndex, false, { allowFuzzy });
			if (secondMatch.index !== undefined) {
				return undefined;
			}
		}
		return fallbackResult.index;
	}

	for (const variant of filterFallbackVariants(buildFallbackVariants(hunk), allowAggressiveFallbacks)) {
		if (variant.oldLines.length === 0) continue;
		const variantResult = findSequenceWithHint(
			lines,
			variant.oldLines,
			currentIndex,
			matchHint ?? lineHint,
			false,
			allowFuzzy,
		);
		if (variantResult.index !== undefined && (variantResult.matchCount ?? 1) <= 1) {
			return variantResult.index;
		}
	}
	return undefined;
}

/**
 * Apply a hunk using character-based fuzzy matching.
 * Used when the hunk contains only -/+ lines without context.
 */
function applyCharacterMatch(
	originalContent: string,
	path: string,
	hunk: DiffHunk,
	fuzzyThreshold: number,
	allowFuzzy: boolean,
): { content: string; warnings: string[] } {
	const oldText = hunk.oldLines.join("\n");
	const newText = hunk.newLines.join("\n");

	const normalizedContent = normalizeToLF(originalContent);
	const normalizedOldText = normalizeToLF(oldText);

	let matchOutcome = findMatch(normalizedContent, normalizedOldText, {
		allowFuzzy,
		threshold: fuzzyThreshold,
	});
	if (!matchOutcome.match && allowFuzzy) {
		const relaxedThreshold = Math.min(fuzzyThreshold, 0.92);
		if (relaxedThreshold < fuzzyThreshold) {
			const relaxedOutcome = findMatch(normalizedContent, normalizedOldText, {
				allowFuzzy,
				threshold: relaxedThreshold,
			});
			if (relaxedOutcome.match) {
				matchOutcome = relaxedOutcome;
			}
		}
	}

	// Check for multiple exact occurrences
	if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
		const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
		const moreMsg = matchOutcome.occurrences > 5 ? ` (showing first 5 of ${matchOutcome.occurrences})` : "";
		throw new ApplyPatchError(
			`Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\n` +
				`Add more context lines to disambiguate.`,
		);
	}

	if (matchOutcome.fuzzyMatches && matchOutcome.fuzzyMatches > 1) {
		throw new ApplyPatchError(
			`Found ${matchOutcome.fuzzyMatches} high-confidence matches in ${path}. ` +
				`The text must be unique. Please provide more context to make it unique.`,
		);
	}

	if (!matchOutcome.match) {
		const closest = matchOutcome.closest;
		if (closest) {
			const similarity = Math.round(closest.confidence * 100);
			throw new ApplyPatchError(
				`Could not find a close enough match in ${path}. ` +
					`Closest match (${similarity}% similar) at line ${closest.startLine}.`,
			);
		}
		throw new ApplyPatchError(`Failed to find expected lines in ${path}:\n${oldText}`);
	}

	// Adjust indentation to match what was actually found
	const adjustedNewText = adjustIndentation(normalizedOldText, matchOutcome.match.actualText, newText);

	const warnings: string[] = [];
	if (matchOutcome.dominantFuzzy && matchOutcome.match) {
		const similarity = Math.round(matchOutcome.match.confidence * 100);
		warnings.push(
			`Dominant fuzzy match selected in ${path} near line ${matchOutcome.match.startLine} (${similarity}% similar).`,
		);
	}

	// Apply the replacement
	const before = normalizedContent.substring(0, matchOutcome.match.startIndex);
	const after = normalizedContent.substring(matchOutcome.match.startIndex + matchOutcome.match.actualText.length);
	return { content: before + adjustedNewText + after, warnings };
}

function applyTrailingNewlinePolicy(content: string, hadFinalNewline: boolean): string {
	if (hadFinalNewline) {
		return content.endsWith("\n") ? content : `${content}\n`;
	}
	return content.replace(/\n+$/u, "");
}

async function readExistingPatchFile(fileSystem: FileSystem, absolutePath: string, path: string): Promise<string> {
	try {
		return await fileSystem.read(absolutePath);
	} catch (error) {
		if (isEnoent(error) || (error instanceof Error && error.message.startsWith("File not found:"))) {
			throw new ApplyPatchError(`File not found: ${path}`);
		}
		throw error;
	}
}

/**
 * A prefix/substring strategy matched pattern lines that cover only part of
 * the corresponding file lines; replacing whole lines would silently drop the
 * uncovered text the model never saw. Allow the replacement only when every
 * discarded piece (normalized) survives somewhere in the hunk's new lines.
 */
function assertPartialMatchPreservesDiscardedText(
	path: string,
	pattern: string[],
	matchedLines: string[],
	newLines: string[],
	matchStartIndex: number,
): void {
	let newLinesNorm: string | undefined;
	for (let j = 0; j < pattern.length; j++) {
		const lineNorm = normalizeForFuzzy(matchedLines[j]);
		const patternNorm = normalizeForFuzzy(pattern[j]);
		if (lineNorm === patternNorm) continue;
		const at = lineNorm.indexOf(patternNorm);
		if (at === -1) continue;
		const discardedParts = [lineNorm.slice(0, at).trim(), lineNorm.slice(at + patternNorm.length).trim()];
		for (const part of discardedParts) {
			if (part.length === 0) continue;
			newLinesNorm ??= newLines.map(normalizeForFuzzy).join("\n");
			if (!newLinesNorm.includes(part)) {
				throw new ApplyPatchError(
					`Refusing partial-line match in ${path} at line ${matchStartIndex + j + 1}: ` +
						`the file line also contains ${JSON.stringify(part)}, which the replacement would silently drop. ` +
						`Provide the complete line in the hunk.`,
				);
			}
		}
	}
}

/**
 * Compute replacements needed to transform originalLines using the diff hunks.
 */
function computeReplacements(
	originalLines: string[],
	path: string,
	hunks: DiffHunk[],
	allowFuzzy: boolean,
): { replacements: Replacement[]; warnings: string[] } {
	const replacements: Replacement[] = [];
	const warnings: string[] = [];
	let lineIndex = 0;

	for (const hunk of hunks) {
		let contextIndex: number | undefined;
		if (hunk.oldStartLine !== undefined && hunk.oldStartLine < 1) {
			throw new ApplyPatchError(
				`Line hint ${hunk.oldStartLine} is out of range for ${path} (line numbers start at 1)`,
			);
		}
		if (hunk.newStartLine !== undefined && hunk.newStartLine < 1) {
			throw new ApplyPatchError(
				`Line hint ${hunk.newStartLine} is out of range for ${path} (line numbers start at 1)`,
			);
		}
		const lineHint = hunk.oldStartLine;
		const allowAggressiveFallbacks = hunk.changeContext !== undefined || lineHint !== undefined || hunk.isEndOfFile;
		const fallbackVariants = filterFallbackVariants(buildFallbackVariants(hunk), allowAggressiveFallbacks);
		if (lineHint !== undefined && hunk.changeContext === undefined && !hunk.hasContextLines) {
			lineIndex = Math.max(0, Math.min(lineHint - 1, originalLines.length - 1));
		}

		// If hunk has a changeContext, find it and adjust lineIndex
		if (hunk.changeContext !== undefined) {
			// Use hierarchical context matching for nested @@ anchors and space-separated contexts
			const result = findHierarchicalContext(originalLines, hunk.changeContext, lineIndex, lineHint, allowFuzzy);
			const idx = result.index;
			contextIndex = idx;

			if (idx === undefined || (result.matchCount !== undefined && result.matchCount > 1)) {
				const fallback = attemptSequenceFallback(
					originalLines,
					hunk,
					lineIndex,
					lineHint,
					allowFuzzy,
					allowAggressiveFallbacks,
				);
				if (fallback !== undefined) {
					lineIndex = fallback;
				} else if (result.matchCount !== undefined && result.matchCount > 1) {
					const displayContext = hunk.changeContext.includes("\n")
						? hunk.changeContext.split("\n").pop()
						: hunk.changeContext;
					const previews = formatSequenceMatchPreviews(originalLines, result.matchIndices, result.matchCount);
					const strategyHint = result.strategy ? ` Matching strategy: ${result.strategy}.` : "";
					const previewText = previews ? `\n\n${previews}` : "";
					throw new ApplyPatchError(
						`Found ${result.matchCount} matches for context '${displayContext}' in ${path}.${strategyHint}` +
							`${previewText}\n\nAdd more surrounding context or additional @@ anchors to make it unique.`,
					);
				} else {
					const displayContext = hunk.changeContext.includes("\n")
						? hunk.changeContext.split("\n").join(" > ")
						: hunk.changeContext;
					throw new ApplyPatchError(`Failed to find context '${displayContext}' in ${path}`);
				}
			} else {
				// If oldLines[0] matches the final context, start search at idx (not idx+1)
				// This handles the common case where @@ scope and first context line are identical
				const firstOldLine = hunk.oldLines[0];
				const finalContext = hunk.changeContext.includes("\n")
					? hunk.changeContext.split("\n").pop()?.trim()
					: hunk.changeContext.trim();
				const isHierarchicalContext =
					hunk.changeContext.includes("\n") || hunk.changeContext.trim().split(/\s+/).length > 2;
				if (firstOldLine !== undefined && (firstOldLine.trim() === finalContext || isHierarchicalContext)) {
					lineIndex = idx;
				} else {
					lineIndex = idx + 1;
				}
			}
		}

		if (hunk.oldLines.length === 0) {
			// Pure addition - prefer changeContext position, then line hint, then end of file
			let insertionIdx: number;
			if (hunk.changeContext !== undefined) {
				// changeContext was processed above; lineIndex is set to the context line or after it
				insertionIdx = lineIndex;
			} else {
				const lineHintForInsertion = hunk.oldStartLine ?? hunk.newStartLine;
				if (lineHintForInsertion !== undefined) {
					// Reject if line hint is out of range for insertion
					// Valid insertion points are 1 to (file length + 1) for 1-indexed hints
					if (lineHintForInsertion < 1) {
						throw new ApplyPatchError(
							`Line hint ${lineHintForInsertion} is out of range for insertion in ${path} ` +
								`(line numbers start at 1)`,
						);
					}
					if (lineHintForInsertion > originalLines.length + 1) {
						throw new ApplyPatchError(
							`Line hint ${lineHintForInsertion} is out of range for insertion in ${path} ` +
								`(file has ${originalLines.length} lines)`,
						);
					}
					insertionIdx = Math.max(0, lineHintForInsertion - 1);
				} else {
					insertionIdx =
						originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
							? originalLines.length - 1
							: originalLines.length;
				}
			}

			replacements.push({ startIndex: insertionIdx, oldLen: 0, newLines: [...hunk.newLines] });
			continue;
		}

		// Try to find the old lines in the file
		let pattern = [...hunk.oldLines];
		const matchHint = getHunkHintIndex(hunk, lineIndex);
		let searchResult = findSequenceWithHint(
			originalLines,
			pattern,
			lineIndex,
			matchHint,
			hunk.isEndOfFile,
			allowFuzzy,
		);
		let newSlice = [...hunk.newLines];

		// Retry without trailing empty line if present
		if (searchResult.index === undefined && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			searchResult = findSequenceWithHint(
				originalLines,
				pattern,
				lineIndex,
				matchHint,
				hunk.isEndOfFile,
				allowFuzzy,
			);
		}

		if (searchResult.index === undefined || (searchResult.matchCount ?? 0) > 1) {
			for (const variant of fallbackVariants) {
				if (variant.oldLines.length === 0) continue;
				const variantResult = findSequenceWithHint(
					originalLines,
					variant.oldLines,
					lineIndex,
					matchHint,
					hunk.isEndOfFile,
					allowFuzzy,
				);
				if (variantResult.index !== undefined && (variantResult.matchCount ?? 1) <= 1) {
					pattern = variant.oldLines;
					newSlice = variant.newLines;
					searchResult = variantResult;
					break;
				}
			}
		}

		if (searchResult.index === undefined && contextIndex !== undefined) {
			for (const variant of fallbackVariants) {
				if (variant.oldLines.length !== 1 || variant.newLines.length !== 1) continue;
				const removedLine = variant.oldLines[0];
				const hasSharedDuplicate = hunk.newLines.some(line => line.trim() === removedLine.trim());
				const adjacentIndex = findContextRelativeMatch(
					originalLines,
					removedLine,
					contextIndex,
					hasSharedDuplicate,
				);
				if (adjacentIndex !== undefined) {
					pattern = variant.oldLines;
					newSlice = variant.newLines;
					searchResult = { index: adjacentIndex, confidence: 0.95 };
					break;
				}
			}
		}

		if (searchResult.index !== undefined && contextIndex !== undefined && pattern.length === 1) {
			const trimmed = pattern[0].trim();
			let occurrenceCount = 0;
			for (const line of originalLines) {
				if (line.trim() === trimmed) occurrenceCount++;
			}
			if (occurrenceCount > 1) {
				const hasSharedDuplicate = hunk.newLines.some(line => line.trim() === trimmed);
				const contextMatch = findContextRelativeMatch(originalLines, pattern[0], contextIndex, hasSharedDuplicate);
				if (contextMatch !== undefined) {
					searchResult = { index: contextMatch, confidence: searchResult.confidence ?? 0.95 };
				}
			}
		}

		if ((searchResult.matchCount ?? 0) > 1) {
			const hintIndex = matchHint ?? (lineHint ? lineHint - 1 : undefined);
			const hinted = chooseHintedMatch(searchResult.matchIndices, hintIndex, AMBIGUITY_HINT_WINDOW);
			if (hinted !== undefined) {
				searchResult = { ...searchResult, index: hinted, matchCount: 1 };
			}
		}

		if (searchResult.index === undefined) {
			if (searchResult.matchCount !== undefined && searchResult.matchCount > 1) {
				const previews = formatSequenceMatchPreviews(
					originalLines,
					searchResult.matchIndices,
					searchResult.matchCount,
				);
				const strategyHint = searchResult.strategy ? ` Matching strategy: ${searchResult.strategy}.` : "";
				const previewText = previews ? `\n\n${previews}` : "";
				throw new ApplyPatchError(
					`Found ${searchResult.matchCount} matches for the text in ${path}.${strategyHint}` +
						`${previewText}\n\nAdd more surrounding context or additional @@ anchors to make it unique.`,
				);
			}
			const closest = findClosestSequenceMatch(originalLines, pattern, {
				start: lineIndex,
				eof: hunk.isEndOfFile,
			});
			if (closest.index !== undefined && closest.confidence > 0) {
				const similarity = Math.round(closest.confidence * 100);
				const preview = formatSequenceMatchPreview(originalLines, closest.index);
				throw new ApplyPatchError(
					`Failed to find expected lines in ${path}:\n${hunk.oldLines.join("\n")}\n\n` +
						`Closest match (${similarity}% similar) near line ${closest.index + 1}:\n${preview}`,
				);
			}
			throw new ApplyPatchError(`Failed to find expected lines in ${path}:\n${hunk.oldLines.join("\n")}`);
		}

		const found = searchResult.index;

		if (searchResult.strategy === "fuzzy-dominant") {
			const similarity = Math.round(searchResult.confidence * 100);
			warnings.push(`Dominant fuzzy match selected in ${path} near line ${found + 1} (${similarity}% similar).`);
		} else if (
			searchResult.strategy === "comment-prefix" ||
			searchResult.strategy === "prefix" ||
			searchResult.strategy === "substring" ||
			searchResult.strategy === "fuzzy" ||
			searchResult.strategy === "character"
		) {
			const similarity = Math.round(searchResult.confidence * 100);
			warnings.push(
				`Inexact match in ${path} near line ${found + 1}: matched via ${searchResult.strategy} strategy ` +
					`(${similarity}% similar). Re-read the file if the result is not what you intended.`,
			);
		}

		// Reject if match is ambiguous (prefix/substring matching found multiple matches)
		if (searchResult.matchCount !== undefined && searchResult.matchCount > 1) {
			const previews = formatSequenceMatchPreviews(
				originalLines,
				searchResult.matchIndices,
				searchResult.matchCount,
			);
			const strategyHint = searchResult.strategy ? ` Matching strategy: ${searchResult.strategy}.` : "";
			const previewText = previews ? `\n\n${previews}` : "";
			throw new ApplyPatchError(
				`Found ${searchResult.matchCount} matches for the text in ${path}.${strategyHint}` +
					`${previewText}\n\nAdd more surrounding context or additional @@ anchors to make it unique.`,
			);
		}

		// For simple diffs (no context marker, no context lines), check for multiple occurrences
		// This ensures ambiguous replacements are rejected
		// Skip this check if isEndOfFile is set (EOF marker provides disambiguation)
		if (hunk.changeContext === undefined && !hunk.hasContextLines && !hunk.isEndOfFile && lineHint === undefined) {
			const secondMatch = seekSequence(originalLines, pattern, found + 1, false, { allowFuzzy });
			if (secondMatch.index !== undefined) {
				const preview1 = formatSequenceMatchPreview(originalLines, found);
				const preview2 = formatSequenceMatchPreview(originalLines, secondMatch.index);
				throw new ApplyPatchError(
					`Found 2 occurrences in ${path}:\n\n${preview1}\n\n${preview2}\n\n` +
						`Add more context lines to disambiguate.`,
				);
			}
		}

		// Adjust indentation if needed (handles fuzzy matches where indentation differs)
		const actualMatchedLines = originalLines.slice(found, found + pattern.length);

		// Skip pure-context hunks (no +/- lines — oldLines === newLines).
		// They serve only to advance lineIndex for subsequent hunks.
		let isNoOp = pattern.length === newSlice.length;
		if (isNoOp) {
			for (let i = 0; i < pattern.length; i++) {
				if (pattern[i] !== newSlice[i]) {
					isNoOp = false;
					break;
				}
			}
		}

		if (isNoOp) {
			lineIndex = found + pattern.length;
			continue;
		}

		if (searchResult.strategy === "prefix" || searchResult.strategy === "substring") {
			assertPartialMatchPreservesDiscardedText(path, pattern, actualMatchedLines, newSlice, found);
		}

		const adjustedNewLines = adjustLinesIndentation(pattern, actualMatchedLines, newSlice);
		replacements.push({ startIndex: found, oldLen: pattern.length, newLines: adjustedNewLines });
		lineIndex = found + pattern.length;
	}

	// Sort by start index
	replacements.sort((a, b) => a.startIndex - b.startIndex);

	for (let i = 1; i < replacements.length; i++) {
		const prev = replacements[i - 1];
		const next = replacements[i];
		const prevEnd = prev.startIndex + prev.oldLen;
		if (next.startIndex < prevEnd) {
			const formatRange = (replacement: Replacement): string => {
				if (replacement.oldLen === 0) {
					return `${replacement.startIndex + 1} (insertion)`;
				}
				return `${replacement.startIndex + 1}-${replacement.startIndex + replacement.oldLen}`;
			};
			const prevRange = formatRange(prev);
			const nextRange = formatRange(next);
			throw new ApplyPatchError(
				`Overlapping hunks detected in ${path} at lines ${prevRange} and ${nextRange}. ` +
					`Split hunks or add more context to avoid overlap.`,
			);
		}
	}

	return { replacements, warnings };
}

/**
 * Apply replacements to lines, returning the modified content.
 */
function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
	const result = [...lines];

	// Apply in reverse order to maintain indices
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { startIndex, oldLen, newLines } = replacements[i];
		result.splice(startIndex, oldLen);
		result.splice(startIndex, 0, ...newLines);
	}

	return result;
}

/**
 * Apply diff hunks to file content.
 */
function applyHunksToContent(
	originalContent: string,
	path: string,
	hunks: DiffHunk[],
	fuzzyThreshold: number,
	allowFuzzy: boolean,
): { content: string; warnings: string[] } {
	const hadFinalNewline = originalContent.endsWith("\n");

	// Detect simple replace pattern: single hunk, no @@ context, no context lines, has old lines to match
	// Only use character-based matching when there are no hints to disambiguate
	if (hunks.length === 1) {
		const hunk = hunks[0];
		if (
			hunk.changeContext === undefined &&
			!hunk.hasContextLines &&
			hunk.oldLines.length > 0 &&
			hunk.oldStartLine === undefined && // No line hint to use for positioning
			!hunk.isEndOfFile // No EOF targeting (prefer end of file)
		) {
			const { content, warnings } = applyCharacterMatch(originalContent, path, hunk, fuzzyThreshold, allowFuzzy);
			return { content: applyTrailingNewlinePolicy(content, hadFinalNewline), warnings };
		}
	}

	let originalLines = originalContent.split("\n");

	// Track if we have a trailing empty element from the final newline
	// Only strip ONE trailing empty (the newline marker), preserve actual blank lines
	let strippedTrailingEmpty = false;
	if (hadFinalNewline && originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
		// Check if the second-to-last is also empty (actual blank line) - if so, only strip one
		originalLines = originalLines.slice(0, -1);
		strippedTrailingEmpty = true;
	}

	const { replacements, warnings } = computeReplacements(originalLines, path, hunks, allowFuzzy);
	const newLines = applyReplacements(originalLines, replacements);

	// Restore the trailing empty element if we stripped it
	if (strippedTrailingEmpty) {
		newLines.push("");
	}

	const content = newLines.join("\n");
	return { content: applyTrailingNewlinePolicy(content, hadFinalNewline), warnings };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply a patch operation to the filesystem.
 */
export async function applyPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	return applyNormalizedPatch(input, options);
}

/**
 * Apply a normalized patch operation to the filesystem.
 * @internal
 */
async function applyNormalizedPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	const {
		cwd,
		dryRun = false,
		fs = defaultFileSystem,
		fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD,
		allowFuzzy = true,
		allowCreateOverwrite = false,
	} = options;

	const resolvePath = (p: string): string => resolveToCwd(p, cwd);
	const absolutePath = resolvePath(input.path);
	const op = input.op ?? "update";

	if (input.rename) {
		const destPath = resolvePath(input.rename);
		if (destPath === absolutePath) {
			throw new ApplyPatchError("rename path is the same as source path");
		}
		// The `*** Move to` / rename contract is strictly non-overwriting:
		// reject before the update path reads or writes anything, so both
		// source and pre-existing destination remain untouched. Callers who
		// really need to replace the destination must delete it in an
		// earlier hunk.
		if (await fs.exists(destPath)) {
			throw new ApplyPatchError(`Cannot rename ${input.path} to ${input.rename}: destination already exists.`);
		}
	}

	// Handle CREATE operation
	if (op === "create") {
		if (!input.diff) {
			throw new ApplyPatchError("Create operation requires diff (file content)");
		}
		// The `*** Add File` contract of the apply_patch envelope is strictly
		// non-overwriting: reject before mkdir/write so pre-existing content
		// stays intact and the caller can re-issue as an explicit
		// `*** Update File` (or a delete+add pair) if overwrite is genuinely
		// intended. The JSON `patch` mode opts out via `allowCreateOverwrite`,
		// where `op: "create"` doubles as a sanctioned full-file overwrite.
		if (!allowCreateOverwrite && (await fs.exists(absolutePath))) {
			throw new ApplyPatchError(
				`Cannot create ${input.path}: file already exists. Use *** Update File to modify it in place.`,
			);
		}
		// Strip + prefixes if present (handles diffs formatted as additions)
		const normalizedContent = normalizeCreateContent(input.diff);
		const content = normalizedContent.endsWith("\n") ? normalizedContent : `${normalizedContent}\n`;

		if (!dryRun) {
			const parentDir = path.dirname(absolutePath);
			if (parentDir && parentDir !== ".") {
				await fs.mkdir(parentDir);
			}
			await fs.write(absolutePath, content);
		}

		return {
			change: {
				type: "create",
				path: absolutePath,
				newContent: content,
			},
		};
	}

	// Handle DELETE operation
	if (op === "delete") {
		const oldContent = await readExistingPatchFile(fs, absolutePath, input.path);
		if (!dryRun) {
			await fs.delete(absolutePath);
		}

		return {
			change: {
				type: "delete",
				path: absolutePath,
				oldContent,
			},
		};
	}

	// Handle UPDATE operation
	if (!input.diff) {
		throw new ApplyPatchError("Update operation requires diff (hunks)");
	}

	const originalContent = await readExistingPatchFile(fs, absolutePath, input.path);
	const { bom: bomFromText, text: strippedContent } = stripBom(originalContent);
	let bom = bomFromText;
	if (!bom && fs.readBinary) {
		const bytes = await fs.readBinary(absolutePath);
		if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
			bom = "\uFEFF";
		}
	}
	const lineEnding = detectLineEnding(strippedContent);
	const normalizedContent = normalizeToLF(strippedContent);
	const hunks = parseDiffHunks(input.diff);

	if (hunks.length === 0) {
		throw new ApplyPatchError("Diff contains no hunks");
	}

	const { content: newContent, warnings } = applyHunksToContent(
		normalizedContent,
		input.path,
		hunks,
		fuzzyThreshold,
		allowFuzzy,
	);
	const finalContent = bom + restoreLineEndings(newContent, lineEnding);
	const destPath = input.rename ? resolvePath(input.rename) : absolutePath;
	const isMove = Boolean(input.rename) && destPath !== absolutePath;

	if (!dryRun) {
		if (isMove) {
			const parentDir = path.dirname(destPath);
			if (parentDir && parentDir !== ".") {
				await fs.mkdir(parentDir);
			}
			await fs.write(destPath, finalContent);
			await fs.delete(absolutePath);
		} else {
			await fs.write(absolutePath, finalContent);
		}
	}

	return {
		change: {
			type: "update",
			path: absolutePath,
			newPath: isMove ? destPath : undefined,
			oldContent: originalContent,
			newContent: finalContent,
		},
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

/**
 * Preview what changes a patch would make without applying it.
 */
export async function previewPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	return applyPatch(input, { ...options, dryRun: true });
}

export async function computePatchDiff(
	input: PatchInput,
	cwd: string,
	options?: { fuzzyThreshold?: number; allowFuzzy?: boolean; allowCreateOverwrite?: boolean },
): Promise<
	| {
			diff: string;
			firstChangedLine: number | undefined;
	  }
	| {
			error: string;
	  }
> {
	try {
		const result = await previewPatch(input, {
			cwd,
			fuzzyThreshold: options?.fuzzyThreshold,
			allowFuzzy: options?.allowFuzzy,
			allowCreateOverwrite: options?.allowCreateOverwrite,
		});
		const oldContent = result.change.oldContent ?? "";
		const newContent = result.change.newContent ?? "";
		const normalizedOld = normalizeToLF(stripBom(oldContent).text);
		const normalizedNew = normalizeToLF(stripBom(newContent).text);
		if (!normalizedOld && !normalizedNew) {
			return { diff: "", firstChangedLine: undefined };
		}
		return generateUnifiedDiffString(normalizedOld, normalizedNew, undefined, {
			path: result.change.newPath ?? result.change.path,
		});
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export const patchEditEntrySchema = type({
	"op?": "'create' | 'delete' | 'update'",
	"rename?": "string",
	"diff?": "string",
});

export type PatchEditEntry = typeof patchEditEntrySchema.infer;

export const patchEditSchema = type({
	path: "string",
	edits: patchEditEntrySchema.array(),
});

export type PatchParams = typeof patchEditSchema.infer;

export interface ExecutePatchSingleOptions {
	session: ToolSession;
	path: string;
	params: PatchEditEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	/** See {@link ApplyPatchOptions.allowCreateOverwrite}; set by the JSON `patch` mode only. */
	allowCreateOverwrite?: boolean;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	/** Observes a committed content transition before result snapshots are pruned. */
	onApplied?: AppliedEditObserver;
}

class LspFileSystem implements FileSystem {
	#lastDiagnostics: FileDiagnosticsResult | undefined;
	#fileCache: Record<string, Bun.BunFile> = {};

	constructor(
		private readonly session: ToolSession,
		private readonly requestedPath: string,
		private readonly writethrough: WritethroughCallback,
		private readonly signal?: AbortSignal,
		private readonly batchRequest?: LspBatchRequest,
		private readonly deferredForPath?: (path: string) => WritethroughDeferredHandle,
	) {}

	#getFile(path: string): Bun.BunFile {
		if (this.#fileCache[path]) {
			return this.#fileCache[path];
		}
		const file = Bun.file(path);
		this.#fileCache[path] = file;
		return file;
	}

	async exists(path: string): Promise<boolean> {
		return this.#getFile(path).exists();
	}

	async read(path: string): Promise<string> {
		return readEditFileText(path, path);
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const bytes = await fs.promises.readFile(path);
		return bytes;
	}

	async write(path: string, content: string): Promise<void> {
		const finalContent = await serializeEditFileText(path, path, content);

		// Route through ACP bridge when available; skips internal artifacts and local:// paths.
		if (await routeWriteThroughBridge(this.session, this.requestedPath, path, finalContent, this.signal)) {
			return;
		}

		const file = this.#getFile(path);
		const deferredForPath = this.deferredForPath;
		const result = await this.writethrough(
			path,
			finalContent,
			this.signal,
			file,
			this.batchRequest,
			deferredForPath ? (dst: string) => deferredForPath(dst) : undefined,
		);
		if (result) {
			this.#lastDiagnostics = result;
		}
	}

	async delete(path: string): Promise<void> {
		await deleteFileWithFallback(path, this.#getFile(path));
		if (this.session.enableLsp ?? true) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[{ filePath: path, type: FileChangeType.Deleted }],
				this.signal,
			);
		}
	}

	async mkdir(path: string): Promise<void> {
		await mkdirAllowingFallback(path);
	}

	getDiagnostics(): FileDiagnosticsResult | undefined {
		return this.#lastDiagnostics;
	}
}

function mergeDiagnosticsWithWarnings(
	diagnostics: FileDiagnosticsResult | undefined,
	warnings: string[],
): FileDiagnosticsResult | undefined {
	if (warnings.length === 0) return diagnostics;
	const warningMessages = warnings.map(warning => `patch: ${warning}`);
	if (!diagnostics) {
		return {
			server: "patch",
			messages: warningMessages,
			summary: `Patch warnings: ${warnings.length}`,
			errored: false,
		};
	}
	return {
		...diagnostics,
		messages: [...warningMessages, ...diagnostics.messages],
		summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
	};
}

export async function executePatchSingle(
	options: ExecutePatchSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof patchEditEntrySchema>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		allowCreateOverwrite,
		writethrough,
		beginDeferredDiagnosticsForPath,
		onApplied,
	} = options;
	const { op: rawOp, rename, diff } = params;

	const op: Operation = rawOp === "create" || rawOp === "delete" ? rawOp : "update";

	enforcePlanModeWrite(session, path, { op, move: rename });
	const resolvedPath = resolvePlanPath(session, path);
	const resolvedRename = rename ? resolvePlanPath(session, rename) : undefined;

	await assertEditableFile(resolvedPath, path, session.settings);

	// Capture pre-edit content so we can verify the write actually hit disk.
	// `LspFileSystem.writeFile` delegates to a writethrough callback that, in
	// some host integrations, has been observed to report success without
	// persisting bytes — leaving the tool to claim "Updated <path>" while the
	// file on disk is byte-identical to before. After the write we re-read
	// the file and assert the bytes match the expected newContent; relying
	// on stat (mtime/size) is unreliable because filesystems with coarse
	// timestamp resolution can record an unchanged mtime even when the
	// content was rewritten, and same-length rewrites leave size unchanged.
	let preEditContent: Uint8Array | undefined;
	if (op === "update") {
		try {
			preEditContent = await fs.promises.readFile(resolvedPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	const input: PatchInput = { path: resolvedPath, op, rename: resolvedRename, diff };
	const patchFileSystem = new LspFileSystem(
		session,
		path, // original user-provided path for bridge guard (may be local://, vault://, etc.)
		writethrough,
		signal,
		batchRequest,
		beginDeferredDiagnosticsForPath,
	);
	const result = await applyPatch(input, {
		cwd: session.cwd,
		fs: patchFileSystem,
		fuzzyThreshold,
		allowFuzzy,
		allowCreateOverwrite,
	});

	// Post-write verification: only meaningful for in-place updates where the
	// patch actually changes content and the file is not being renamed away.
	if (
		result.change.type === "update" &&
		!result.change.newPath &&
		preEditContent !== undefined &&
		result.change.oldContent !== undefined &&
		result.change.newContent !== undefined &&
		result.change.oldContent !== result.change.newContent
	) {
		let postEditContent: Uint8Array | undefined;
		try {
			postEditContent = await fs.promises.readFile(resolvedPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const unchanged =
			postEditContent !== undefined &&
			postEditContent.length === preEditContent.length &&
			postEditContent.every((b, i) => b === preEditContent[i]);
		if (unchanged) {
			throw new ToolError(`edit appeared successful but file content did not change on disk: ${path}`, {
				path: resolvedPath,
			});
		}
	}

	if (resolvedRename) {
		invalidateFsScanAfterRename(resolvedPath, resolvedRename);
	} else if (result.change.type === "delete") {
		invalidateFsScanAfterDelete(resolvedPath);
	} else {
		invalidateFsScanAfterWrite(resolvedPath);
	}
	const effectiveRename = result.change.newPath ? rename : undefined;

	let diffResult: { diff: string; firstChangedLine: number | undefined } = {
		diff: "",
		firstChangedLine: undefined,
	};
	let previewSource: EditPreviewSource | undefined;
	if (
		result.change.type === "update" &&
		result.change.oldContent !== undefined &&
		result.change.newContent !== undefined
	) {
		const normalizedOld = normalizeToLF(stripBom(result.change.oldContent).text);
		const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text);
		const path = result.change.newPath ?? result.change.path;
		diffResult = generateUnifiedDiffString(normalizedOld, normalizedNew, undefined, { path });
		previewSource = { before: normalizedOld, after: normalizedNew, path };
	} else if (result.change.type === "create" && result.change.newContent !== undefined) {
		// The result is authoritative for rendering, so emit the added-content
		// diff here rather than relying on the call-phase streaming preview.
		const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text);
		diffResult = generateUnifiedDiffString("", normalizedNew, undefined, { path: result.change.path });
		previewSource = { before: "", after: normalizedNew, path: result.change.path };
	}

	let diagnostics = patchFileSystem.getDiagnostics();
	if (op === "delete" && batchRequest?.flush) {
		const flushedDiagnostics = await flushLspWritethroughBatch(batchRequest.id, session.cwd, signal);
		diagnostics ??= flushedDiagnostics;
	}
	const mergedDiagnostics = mergeDiagnosticsWithWarnings(diagnostics, result.warnings ?? []);
	const oldText = result.change.type !== "create" ? result.change.oldContent : undefined;
	const newText = result.change.type !== "delete" ? result.change.newContent : undefined;
	if (oldText !== undefined && newText !== undefined) {
		await onApplied?.({
			path: result.change.newPath ?? resolvedPath,
			prev: oldText,
			next: newText,
		});
	}

	const editResult = createEditResult({
		displayPath: path,
		// When the patch moves the file, anchor the diff to the destination
		// path. ACP `ToolCallContent.diff.path` comes from this field, and
		// clients use it to open or focus the file post-change; pointing at
		// the (now-deleted) source navigates to nothing.
		resultPath: result.change.newPath ?? resolvedPath,
		diff: diffResult.diff,
		firstChangedLine: diffResult.firstChangedLine,
		diagnostics: mergedDiagnostics,
		op,
		move: effectiveRename,
		sourcePath: result.change.newPath ? resolvedPath : undefined,
		oldText,
		newText,
		warnings: result.warnings,
		previewSource,
	});
	return toEditToolResult(editResult);
}
