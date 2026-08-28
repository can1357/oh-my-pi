/**
 * Recovers stale section tags by proving that every anchored line still maps
 * to one unchanged, contiguous region in the current file, then replaying the
 * edit against that live content.
 *
 * Recovery fails closed when the target changed or became ambiguous. The
 * patcher then returns a mismatch with fresh context instead of guessing.
 */
import { diffLineRuns } from "@oh-my-pi/pi-natives";
import { applyEdits } from "./apply";
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING } from "./messages";
import type { SnapshotStore } from "./snapshots";
import type { Anchor, ApplyResult, Clipboard, Edit } from "./types";

export interface RecoveryArgs {
	path: string;
	currentText: string;
	fileHash: string;
	edits: readonly Edit[];
	/** Shared clipboard register for `cut`/`paste` edits, threaded into the replay apply. */
	clipboard?: Clipboard;
}

export interface RecoveryResult {
	/** Post-recovery text. */
	text: string;
	/** First changed line (1-indexed) relative to the live `currentText`, or `undefined`. */
	firstChangedLine: number | undefined;
	/** Warnings collected during recovery, including the user-facing recovery banner. */
	warnings: string[];
}

function collectAnchorLines(edits: readonly Edit[]): number[] {
	const lines: number[] = [];
	for (const edit of edits) {
		for (const anchor of getEditAnchors(edit)) lines.push(anchor.line);
	}
	return lines;
}

function getEditAnchors(edit: Edit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	// Recovery only ever receives already-resolved edits (no `block`); this arm
	// exists for type-exhaustiveness over the full `Edit` union.
	if (edit.kind === "block") return [edit.anchor];
	if (edit.kind === "cut") {
		// Every captured line is an anchor: changed interior content is unsafe.
		const anchors: Anchor[] = [];
		for (let line = edit.range.start.line; line <= edit.range.end.line; line++) anchors.push({ line });
		return anchors;
	}
	if (edit.kind === "paste") {
		if (edit.at.kind === "span") {
			const anchors: Anchor[] = [];
			for (let line = edit.at.range.start.line; line <= edit.at.range.end.line; line++) anchors.push({ line });
			return anchors;
		}
		const cursor = edit.at.cursor;
		return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : [];
	}
	return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor" ? [edit.cursor.anchor] : [];
}

function buildLineMap(previousText: string, currentText: string): Map<number, number> {
	const changes = diffLineRuns(previousText, currentText);
	const map = new Map<number, number>();
	let previousLine = 1;
	let currentLine = 1;

	for (const change of changes) {
		const count = change.count;
		if (change.added) {
			currentLine += count;
			continue;
		}
		if (change.removed) {
			previousLine += count;
			continue;
		}
		for (let offset = 0; offset < count; offset++) {
			map.set(previousLine + offset, currentLine + offset);
		}
		previousLine += count;
		currentLine += count;
	}

	return map;
}

/** Values appearing two or more times in `lines`, for O(1) duplicate checks. */
function collectDuplicatedValues(lines: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const value of lines) {
		if (seen.has(value)) duplicated.add(value);
		else seen.add(value);
	}
	return duplicated;
}

interface AnchorNeighbors {
	/** Nearest non-anchor line below the anchor's run, or `undefined` at the file edge. */
	before: number | undefined;
	/** Nearest non-anchor line above the anchor's run, or `undefined` at the file edge. */
	after: number | undefined;
}

/**
 * Nearest non-anchor context line on each side of every anchor, computed in
 * one sweep over the sorted anchor set. Anchors in one contiguous run share
 * both neighbors (the lines just outside the run), so this replaces the
 * per-anchor directional walk across anchored ranges — O(anchors²) on a
 * large block replacement — with one O(anchors log anchors) pass.
 */
function computeAnchorNeighbors(anchorLines: ReadonlySet<number>, lineCount: number): Map<number, AnchorNeighbors> {
	const sorted = [...anchorLines].sort((a, b) => a - b);
	const neighbors = new Map<number, AnchorNeighbors>();
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		const start = sorted[i];
		const end = sorted[j];
		const before = start - 1 >= 1 && start - 1 <= lineCount ? start - 1 : undefined;
		const after = end + 1 <= lineCount ? end + 1 : undefined;
		for (let k = i; k <= j; k++) neighbors.set(sorted[k], { before, after });
		i = j + 1;
	}
	return neighbors;
}

function validateDuplicateAnchorContext(
	line: number,
	mapped: number,
	neighbors: AnchorNeighbors,
	lineMap: ReadonlyMap<number, number>,
): boolean {
	let checked = false;
	const { before, after } = neighbors;
	if (before !== undefined) {
		checked = true;
		if (lineMap.get(before) !== mapped - (line - before)) return false;
	}
	if (after !== undefined) {
		checked = true;
		if (lineMap.get(after) !== mapped + (after - line)) return false;
	}
	return checked;
}

function validateUniqueAnchorContext(
	line: number,
	mapped: number,
	neighbors: AnchorNeighbors,
	lineMap: ReadonlyMap<number, number>,
): boolean {
	const offset = mapped - line;
	const { before, after } = neighbors;
	if (after !== undefined && lineMap.get(after) === after + offset) return true;
	return before !== undefined && lineMap.get(before) === before + offset;
}

function validateRemappedAnchorContext(
	previousText: string,
	currentText: string,
	lineMap: ReadonlyMap<number, number>,
	edits: readonly Edit[],
): boolean {
	const previousLines = previousText.split("\n");
	const currentLines = currentText.split("\n");
	const anchorLines = new Set(collectAnchorLines(edits));
	// Precompute once per validation pass: which line values are duplicated,
	// and each anchor's nearest non-anchor context. The per-anchor forms —
	// indexOf/lastIndexOf full-file scans plus directional walks across
	// anchored ranges — are O(anchors×lines) + O(anchors²) and blow up on
	// large block replacements.
	const duplicatedPrevious = collectDuplicatedValues(previousLines);
	const duplicatedCurrent = collectDuplicatedValues(currentLines);
	const anchorNeighbors = computeAnchorNeighbors(anchorLines, previousLines.length);

	for (const [line, neighbors] of anchorNeighbors) {
		const mapped = lineMap.get(line);
		if (mapped === undefined) return false;
		if (!duplicatedPrevious.has(previousLines[line - 1]) && !duplicatedCurrent.has(currentLines[mapped - 1])) {
			if (!validateUniqueAnchorContext(line, mapped, neighbors, lineMap)) {
				return false;
			}
			continue;
		}
		if (!validateDuplicateAnchorContext(line, mapped, neighbors, lineMap)) {
			return false;
		}
	}

	return true;
}

interface RemappedEdits {
	edits: Edit[];
	offset: number;
}

function remapEditsToCurrent(previousText: string, currentText: string, edits: readonly Edit[]): RemappedEdits | null {
	const lineMap = buildLineMap(previousText, currentText);
	if (!validateRemappedAnchorContext(previousText, currentText, lineMap, edits)) return null;
	const offsets: number[] = [];

	const mapLine = (line: number): number | null => {
		const mapped = lineMap.get(line);
		if (mapped === undefined) return null;
		offsets.push(mapped - line);
		return mapped;
	};

	const mapAnchor = (anchor: Anchor): Anchor | null => {
		const line = mapLine(anchor.line);
		return line === null ? null : { line };
	};

	const remapped: Edit[] = [];
	for (const edit of edits) {
		if (edit.kind === "delete") {
			const anchor = mapAnchor(edit.anchor);
			if (anchor === null) return null;
			remapped.push({ ...edit, anchor });
			continue;
		}
		if (edit.kind === "block") {
			const anchor = mapAnchor(edit.anchor);
			if (anchor === null) return null;
			remapped.push({ ...edit, anchor });
			continue;
		}
		if (edit.kind === "cut") {
			// Map every captured line; an unmapped interior line means the
			// content drifted and cannot be moved safely. Uniform offsets keep
			// the mapped range contiguous.
			const start = mapLine(edit.range.start.line);
			if (start === null) return null;
			let end = start;
			for (let line = edit.range.start.line + 1; line <= edit.range.end.line; line++) {
				const mapped = mapLine(line);
				if (mapped === null) return null;
				end = mapped;
			}
			remapped.push({ ...edit, range: { start: { line: start }, end: { line: end } } });
			continue;
		}
		if (edit.kind === "paste") {
			let blockStart = edit.blockStart;
			if (blockStart !== undefined) {
				const mappedBlockStart = mapLine(blockStart);
				if (mappedBlockStart === null) return null;
				blockStart = mappedBlockStart;
			}
			if (edit.at.kind === "span") {
				const start = mapLine(edit.at.range.start.line);
				if (start === null) return null;
				let end = start;
				for (let line = edit.at.range.start.line + 1; line <= edit.at.range.end.line; line++) {
					const mapped = mapLine(line);
					if (mapped === null) return null;
					end = mapped;
				}
				remapped.push({
					...edit,
					at: { kind: "span", range: { start: { line: start }, end: { line: end } } },
					blockStart,
				});
				continue;
			}
			const cursor = edit.at.cursor;
			if (cursor.kind !== "before_anchor" && cursor.kind !== "after_anchor") {
				remapped.push(blockStart === edit.blockStart ? edit : { ...edit, blockStart });
				continue;
			}
			const anchor = mapAnchor(cursor.anchor);
			if (anchor === null) return null;
			remapped.push({ ...edit, at: { kind: "gap", cursor: { kind: cursor.kind, anchor } }, blockStart });
			continue;
		}
		if (edit.kind === "insert") {
			let blockStart = edit.blockStart;
			if (blockStart !== undefined) {
				const mappedBlockStart = mapLine(blockStart);
				if (mappedBlockStart === null) return null;
				blockStart = mappedBlockStart;
			}
			const cursor = edit.cursor;
			if (cursor.kind !== "before_anchor" && cursor.kind !== "after_anchor") {
				remapped.push(blockStart === edit.blockStart ? edit : { ...edit, blockStart });
				continue;
			}
			const anchor = mapAnchor(cursor.anchor);
			if (anchor === null) return null;
			remapped.push({ ...edit, cursor: { kind: cursor.kind, anchor }, blockStart });
		}
	}

	if (offsets.length === 0) return null;
	const firstOffset = offsets[0];
	if (!offsets.every(offset => offset === firstOffset)) return null;
	return { edits: remapped, offset: firstOffset };
}

function replayRemappedAnchorsOnCurrent(
	previousText: string,
	currentText: string,
	edits: readonly Edit[],
	recoveryWarning: string,
	clipboard: Clipboard | undefined,
	path: string,
): RecoveryResult | null {
	const remapped = remapEditsToCurrent(previousText, currentText, edits);
	if (remapped === null) return null;
	let applied: ApplyResult;
	try {
		applied = applyEdits(currentText, remapped.edits, {
			...(clipboard === undefined ? {} : { clipboard }),
			path,
		});
	} catch {
		return null;
	}
	if (applied.text === currentText) return null;
	return {
		text: applied.text,
		firstChangedLine: applied.firstChangedLine,
		warnings: [remapped.offset === 0 ? recoveryWarning : RECOVERY_LINE_REMAP_WARNING, ...(applied.warnings ?? [])],
	};
}
/**
 * Stateless recovery driver over a {@link SnapshotStore}. Construct once and
 * call {@link Recovery.tryRecover} per stale-tag incident.
 *
 * Recovery maps every stale anchor through unchanged lines from the tagged
 * snapshot to the live text, validates surrounding context, and replays the
 * edit directly on live content. All anchors must move by one consistent
 * offset. A changed, deleted, split, or ambiguous target is rejected so the
 * caller can surface a {@link MismatchError} with current context.
 */
export class Recovery {
	constructor(readonly store: SnapshotStore) {}
	/**
	 * Attempt recovery. Returns `null` when no path forward is found — the
	 * caller should then surface a {@link MismatchError}.
	 */
	tryRecover(args: RecoveryArgs): RecoveryResult | null {
		const { path, currentText, fileHash, edits, clipboard } = args;
		// When retained texts collide on the 16-bit tag, use the latest one.
		// Recovery still requires its anchors and context to map unambiguously.
		const snapshot = this.store.byHash(path, fileHash);
		if (!snapshot) return null;
		const recoveryWarning =
			this.store.head(path) === snapshot ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
		return replayRemappedAnchorsOnCurrent(snapshot.text, currentText, edits, recoveryWarning, clipboard, path);
	}
}
