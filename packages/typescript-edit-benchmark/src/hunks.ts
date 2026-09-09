/**
 * Shared hunk machinery for fixture generation.
 *
 * `generate.ts` expresses every task as "replace these exact blocks in the
 * input file". This module locates changed blocks, prepares prompt-visible
 * before/after blocks whose old side occurs exactly once in the input
 * (re-padding with context, or falling back to an explicit line number), and
 * re-solves prepared hunks to prove a prompt admits exactly one byte-exact
 * answer. Prompt prose itself lives in the Handlebars templates under
 * `src/prompts/`; this module only supplies the block data.
 */
import { diffLines } from "diff";

/** Replace `oldLen` lines at `start` (0-based index into the input) with `newLines`. */
export interface Placement {
	start: number;
	oldLen: number;
	newLines: string[];
}

/** A prompt-visible change: replace (or delete) `oldBlock`, verbatim, with `newBlock`. */
export interface RenderedHunk {
	oldBlock: string[];
	newBlock: string[];
	/** 1-based line where `oldBlock` starts in the input file. */
	startLine: number;
	/** Whether `oldBlock` occurs exactly once in the input; when false, prompts must state `startLine`. */
	unique: boolean;
}

const MAX_UNIQUENESS_EXTENSION = 10;

export function findBlockOccurrences(lines: string[], block: string[]): number[] {
	if (block.length === 0 || block.length > lines.length) return [];
	const hits: number[] = [];
	const first = block[0];
	outer: for (let i = 0; i <= lines.length - block.length; i++) {
		if (lines[i] !== first) continue;
		for (let j = 1; j < block.length; j++) {
			if (lines[i + j] !== block[j]) continue outer;
		}
		hits.push(i);
	}
	return hits;
}

export function applyPlacements(lines: string[], placements: Placement[]): string[] {
	const out: string[] = [];
	let cursor = 0;
	for (const placement of placements) {
		out.push(...lines.slice(cursor, placement.start), ...placement.newLines);
		cursor = placement.start + placement.oldLen;
	}
	out.push(...lines.slice(cursor));
	return out;
}

export function commonPrefixLength(a: string[], b: string[]): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

export function commonSuffixLength(a: string[], b: string[], maxLength: number): number {
	let n = 0;
	while (n < maxLength && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

function splitDiffValue(value: string): string[] {
	const lines = value.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Compute placements that transform `inputText` into `expectedText` via a
 * line diff. Adjacent removed/added runs merge into one placement.
 */
export function placementsFromDiff(inputText: string, expectedText: string): Placement[] {
	const placements: Placement[] = [];
	let inputLine = 0;
	let pendingStart = -1;
	let pendingOldLen = 0;
	let pendingNewLines: string[] = [];

	const flush = (): void => {
		if (pendingStart < 0) return;
		placements.push({ start: pendingStart, oldLen: pendingOldLen, newLines: pendingNewLines });
		pendingStart = -1;
		pendingOldLen = 0;
		pendingNewLines = [];
	};

	for (const change of diffLines(inputText, expectedText)) {
		const lines = splitDiffValue(change.value);
		if (!change.added && !change.removed) {
			flush();
			inputLine += lines.length;
			continue;
		}
		if (pendingStart < 0) pendingStart = inputLine;
		if (change.removed) {
			pendingOldLen += lines.length;
			inputLine += lines.length;
		} else {
			pendingNewLines.push(...lines);
		}
	}
	flush();
	return placements;
}

/**
 * Merge placements separated by at most `maxGap` context lines into one, so a
 * moved statement renders as a single natural replace instead of a delete plus
 * a re-insert whose blocks end on invisible blank lines.
 */
export function mergeNearbyPlacements(inputLines: string[], placements: Placement[], maxGap: number): Placement[] {
	const merged: Placement[] = [];
	for (const placement of placements) {
		const previous = merged[merged.length - 1];
		const gap = previous ? placement.start - (previous.start + previous.oldLen) : -1;
		if (previous && gap >= 0 && gap <= maxGap) {
			const bridge = inputLines.slice(previous.start + previous.oldLen, placement.start);
			previous.oldLen += gap + placement.oldLen;
			previous.newLines = [...previous.newLines, ...bridge, ...placement.newLines];
			continue;
		}
		merged.push({ ...placement });
	}
	return merged;
}

/**
 * Turn placements into prompt-visible hunks. Each hunk's blocks are trimmed to
 * the changed core, anchored on context when either side would be empty, then
 * re-padded with context lines until the old block occurs exactly once in the
 * input; when the input has no room to disambiguate, the hunk is marked
 * non-unique and prompts must state its start line. Blocks never start or end
 * on a blank line when a visible context line is available — a blank line at a
 * fence edge is invisible. Returns null when a hunk cannot be rendered at all.
 */
export function renderHunks(inputLines: string[], placements: Placement[]): RenderedHunk[] | null {
	const merged = mergeNearbyPlacements(inputLines, placements, 2);
	const hunks: RenderedHunk[] = [];
	let previousEnd = -1;

	for (let index = 0; index < merged.length; index++) {
		const placement = merged[index];
		const nextStart = index + 1 < merged.length ? merged[index + 1].start : inputLines.length;
		const old = inputLines.slice(placement.start, placement.start + placement.oldLen);
		const fresh = placement.newLines;
		const prefix = commonPrefixLength(old, fresh);
		const suffix = commonSuffixLength(old, fresh, Math.min(old.length, fresh.length) - prefix);
		let shownStart = placement.start + prefix;
		let oldBlock = old.slice(prefix, old.length - suffix);
		let newBlock = fresh.slice(prefix, fresh.length - suffix);
		if (oldBlock.length === 0 && newBlock.length === 0) continue;

		const takeAbove = (): boolean => {
			const above = shownStart - 1;
			if (above < 0 || above <= previousEnd) return false;
			shownStart = above;
			oldBlock = [inputLines[above], ...oldBlock];
			newBlock = [inputLines[above], ...newBlock];
			return true;
		};
		const takeBelow = (): boolean => {
			const below = shownStart + oldBlock.length;
			if (below >= nextStart || below >= inputLines.length) return false;
			oldBlock = [...oldBlock, inputLines[below]];
			newBlock = [...newBlock, inputLines[below]];
			return true;
		};

		// Pure insertion or pure deletion: anchor on a context line so neither
		// block is empty. Prefer a non-blank anchor.
		if (oldBlock.length === 0 || newBlock.length === 0) {
			const aboveIndex = shownStart - 1;
			const aboveVisible = aboveIndex >= 0 && aboveIndex > previousEnd && inputLines[aboveIndex].trim() !== "";
			if (aboveVisible) {
				takeAbove();
			} else if (!takeBelow() && !takeAbove()) {
				return null;
			}
		}

		let unique = true;
		for (let extension = 0; findBlockOccurrences(inputLines, oldBlock).length > 1; extension++) {
			if (extension >= MAX_UNIQUENESS_EXTENSION || !takeAbove()) {
				unique = false;
				break;
			}
		}

		// Pad blank fence edges with visible context (bounded; best effort).
		for (let guard = 0; guard < 2 && (oldBlock[0].trim() === "" || newBlock[0]?.trim() === ""); guard++) {
			if (!takeAbove()) break;
		}
		for (
			let guard = 0;
			guard < 2 && (oldBlock[oldBlock.length - 1].trim() === "" || newBlock[newBlock.length - 1]?.trim() === "");
			guard++
		) {
			if (!takeBelow()) break;
		}

		previousEnd = placement.start + placement.oldLen - 1;
		hunks.push({ oldBlock, newBlock, startLine: shownStart + 1, unique });
	}
	return hunks.length > 0 ? hunks : null;
}

/**
 * Re-solve the prompt from scratch: locate every hunk's old block in the input
 * (unique occurrence, or the stated start line) and apply the replacements.
 * Guarantees the prompt admits exactly one byte-exact answer.
 */
export function solveRenderedHunks(inputLines: string[], hunks: RenderedHunk[]): string[] | null {
	const placements: Placement[] = [];
	for (const hunk of hunks) {
		const occurrences = findBlockOccurrences(inputLines, hunk.oldBlock);
		let start: number;
		if (hunk.unique) {
			if (occurrences.length !== 1) return null;
			start = occurrences[0];
		} else {
			start = hunk.startLine - 1;
			if (!occurrences.includes(start)) return null;
		}
		placements.push({ start, oldLen: hunk.oldBlock.length, newLines: hunk.newBlock });
	}
	placements.sort((a, b) => a.start - b.start);
	let previousEnd = -1;
	for (const placement of placements) {
		if (placement.start <= previousEnd) return null;
		previousEnd = placement.start + placement.oldLen - 1;
	}
	return applyPlacements(inputLines, placements);
}

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "ts",
	".tsx": "tsx",
	".js": "js",
	".jsx": "jsx",
	".mjs": "js",
	".md": "markdown",
	".rs": "rust",
	".py": "python",
	".json": "json",
	".yml": "yaml",
	".yaml": "yaml",
	".toml": "toml",
};

/** Fence that safely wraps every block in `hunks` (upgrades when content embeds triple backticks). */
export function pickFence(hunks: RenderedHunk[]): string {
	const hasTripleBacktick = hunks.some(hunk =>
		[...hunk.oldBlock, ...hunk.newBlock].some(line => line.includes("```")),
	);
	return hasTripleBacktick ? "````" : "```";
}
