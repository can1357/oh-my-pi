import type { DiffStreamResult } from "@oh-my-pi/pi-natives";
import { structuredPatchHunks } from "@oh-my-pi/pi-natives";
import { DIFF_CONTEXT_LINES } from "./state";

/** Column ranges (inclusive start, exclusive end) carrying intraline emphasis. */
type MarkRanges = readonly (readonly [number, number])[];

type RowKind = "context" | "change" | "add" | "del";

interface DiffRow {
	readonly kind: RowKind;
	readonly oldNum?: number;
	readonly newNum?: number;
	/** Tab-expanded line for each side ("" when absent). */
	readonly oldText: string;
	readonly newText: string;
	readonly oldWidth: number;
	readonly newWidth: number;
	readonly oldMarks?: MarkRanges;
	readonly newMarks?: MarkRanges;
	/** Raw (untab-expanded) source lines, for patch construction. */
	readonly oldRaw?: string;
	readonly newRaw?: string;
}

/** One changed region with its applyable patch for hunk-level staging. */
export interface HunkBlock {
	/** `@@ -a,b +c,d @@` header shown above the block. */
	readonly header: string;
	/** Standalone patch text for this hunk, or "" when not applyable. */
	readonly patch: string;
	readonly rows: readonly DiffRow[];
}

/** Aligned diff document produced by {@link buildDiffDocument}. */
export interface DiffDocument {
	readonly filePath: string;
	readonly rows: readonly DiffRow[];
	readonly hunks: readonly HunkBlock[];
	/** Tab-expanded new-side lines for the `file` view. */
	readonly fileLines: readonly { text: string; width: number }[];
	/** Tab-expanded source lines, retained for progressive syntax highlighting. */
	readonly oldDisplayLines: readonly string[];
	/** Tab-expanded source lines, retained for progressive syntax highlighting. */
	readonly newDisplayLines: readonly string[];
	readonly additions: number;
	readonly deletions: number;
	readonly gutterWidth: number;
	readonly maxLineWidth: number;
	/** False when built with whitespace-ignore: hunk patches would not apply. */
	readonly canPatch: boolean;
	/** Raw input texts and newline state, for line-selection patches. */
	readonly rawOld: string;
	readonly rawNew: string;
	readonly oldEndsNewline: boolean;
	readonly newEndsNewline: boolean;
	/** Index into {@link rows} for each 1-based new-file line number. */
	readonly rowIndexByNewLine: readonly number[];
}

/**
 * Whitespace handling for {@link buildDiffDocument}:
 *
 * - `off`: exact, byte-level alignment.
 * - `whitespace`: align ignoring leading/trailing whitespace (disables hunk
 *   patches — the alignment no longer matches git's view of the file).
 * - `formatting`: exact alignment, but changed blocks that only move
 *   whitespace around (indentation, line splits/joins, blank lines) or only
 *   touch import statements (ts/js, rust, go) are demoted to context.
 */
export type WhitespaceMode = "off" | "whitespace" | "formatting";

/** Options for {@link buildDiffDocument}. */
export interface DiffBuildOptions {
	/** Whitespace handling; defaults to `off`. */
	whitespace?: WhitespaceMode;
	/** Exact runs/hunks already computed by the native streaming differ. */
	streamResult?: DiffStreamResult;
}

function filePatchHeader(filePath: string): string {
	return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n`;
}

/**
 * Build a patch covering only the changed rows inside `[from, to]` (indices
 * into `doc.rows`).
 *
 * - `apply`: base is the old side; the target adopts only the selected
 *   changes. Staging selected lines = apply this to the index.
 * - `revert`: base is the new side; the target undoes only the selected
 *   changes. Unstaging selected lines = apply `--cached`; discarding
 *   selected lines = apply to the worktree.
 *
 * Returns `null` when the selection touches no changes or the document
 * cannot produce patches (whitespace-ignore alignment).
 */
export function buildLineSelectionPatch(
	doc: DiffDocument,
	from: number,
	to: number,
	intent: "apply" | "revert",
): string | null {
	if (!doc.canPatch) return null;
	const target: string[] = [];
	let touched = false;
	for (let i = 0; i < doc.rows.length; i++) {
		const row = doc.rows[i];
		const selected = i >= from && i <= to;
		if (selected && row.kind !== "context") touched = true;
		const useNew = intent === "apply" ? selected : !selected;
		switch (row.kind) {
			case "context": {
				// Formatting-demoted rows can be one-sided or differ across
				// sides; the target must mirror the patch base outside changes.
				const line = intent === "apply" ? row.oldRaw : row.newRaw;
				if (line !== undefined) target.push(line);
				break;
			}
			case "change":
				target.push((useNew ? row.newRaw : row.oldRaw) ?? "");
				break;
			case "del":
				if (!useNew) target.push(row.oldRaw ?? "");
				break;
			case "add":
				if (useNew) target.push(row.newRaw ?? "");
				break;
		}
	}
	if (!touched) return null;
	const base = intent === "apply" ? doc.rawOld : doc.rawNew;
	const baseEndsNL = intent === "apply" ? doc.oldEndsNewline : doc.newEndsNewline;
	const otherEndsNL = intent === "apply" ? doc.newEndsNewline : doc.oldEndsNewline;
	const lastRow = doc.rows[doc.rows.length - 1];
	const lastSelected = lastRow !== undefined && to >= doc.rows.length - 1 && lastRow.kind !== "context";
	const endsNL = lastSelected ? otherEndsNL : baseEndsNL;
	const targetText = target.join("\n") + (endsNL && target.length > 0 ? "\n" : "");
	const hunks = structuredPatchHunks(base, targetText, DIFF_CONTEXT_LINES);
	if (hunks.length === 0) return null;
	const body = hunks
		.map(
			hunk =>
				`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
		)
		.join("\n");
	return `${filePatchHeader(doc.filePath)}${body}\n`;
}
