/**
 * Bound the size of the `oldText` / `newText` snapshots that edit-tool results
 * carry in `details`. These fields hold the full pre/post file content; for
 * large files they balloon the per-turn JSONL line and the session file
 * (300 KB+ each on the cases reported in #3786) without paying for any LLM
 * context (provider serializers send only `content`, never `details`).
 *
 * Only consumer of the raw snapshots is the ACP event mapper, which builds a
 * `diff` ToolCallContent for ACP clients (Zed). When the snapshots are pruned
 * the mapper returns `undefined` for that file and the text content still
 * flows — diff visualization degrades gracefully for over-threshold edits.
 */

import type {
	AppliedEditFile,
	EditFileOutcome,
	EditToolDetails,
	EditToolPerFileResult,
	FileChangeEvidence,
} from "./types";

/**
 * Combined `oldText` + `newText` character budget for a single edit-tool
 * result. Applies both per-entry (one file at a time) and as an aggregate
 * across `perFileResults` (so a many-small-files batch can't accumulate
 * unbounded snapshot bytes — see #3787 review).
 *
 * Picked so typical code-file edits keep ACP diff visualization while
 * pathological cases (large generated files, full-file rewrites, or
 * many-file batches) drop the raw snapshots before they hit the
 * session JSONL.
 */
export const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

type WithSnapshot = { oldText?: string; newText?: string; snapshotsPruned?: boolean };

function pruneSnapshot<T extends WithSnapshot>(details: T): T {
	if ((details.oldText?.length ?? 0) + (details.newText?.length ?? 0) <= MAX_EDIT_SNAPSHOT_TEXT_CHARS) {
		return details;
	}
	const { oldText: _old, newText: _new, ...rest } = details;
	return { ...rest, snapshotsPruned: true } as T;
}

/**
 * Walk `perFileResults` in order with a shared budget. Each per-entry payload
 * is first capped individually by {@link pruneSnapshot}; if its kept bytes
 * would push the running aggregate past the cap, strip and mark this entry
 * too. Early entries get to keep their diff visualization; later entries in
 * a large batch degrade to text-only.
 */
function capPerFileSnapshots<T extends WithSnapshot>(entries: T[]): T[] {
	let remaining = MAX_EDIT_SNAPSHOT_TEXT_CHARS;
	return entries.map(entry => {
		const perEntry = pruneSnapshot(entry);
		const kept = (perEntry.oldText?.length ?? 0) + (perEntry.newText?.length ?? 0);
		if (kept === 0) return perEntry;
		if (kept <= remaining) {
			remaining -= kept;
			return perEntry;
		}
		const { oldText: _old, newText: _new, ...rest } = perEntry;
		return { ...rest, snapshotsPruned: true } as T;
	});
}

/**
 * Prune oversized `oldText` / `newText` from an edit-tool details payload,
 * recursing into `perFileResults` when present. Per-file overload comes first
 * so the more specific shape (required `path`) wins overload resolution at
 * the per-file call sites.
 */
export function pruneOversizedEditSnapshots(details: EditToolPerFileResult): EditToolPerFileResult;
export function pruneOversizedEditSnapshots(details: EditToolDetails): EditToolDetails;
export function pruneOversizedEditSnapshots(
	details: EditToolDetails | EditToolPerFileResult,
): EditToolDetails | EditToolPerFileResult {
	const pruned = pruneSnapshot(details);
	if ("perFileResults" in pruned && pruned.perFileResults) {
		return { ...pruned, perFileResults: capPerFileSnapshots(pruned.perFileResults) };
	}
	return pruned;
}

// ═══════════════════════════════════════════════════════════════════════════
// Union-level pruning — operates on `EditFileOutcome` before projection
// to the legacy bag, so `FileChangeEvidence`'s `pruned` variant becomes the
// single source of truth instead of `pruneOversizedEditSnapshots` stripping
// keys off an already-built bag. Mirrors the walk above exactly (same
// budget, same per-entry-then-aggregate order); kept as a parallel
// implementation rather than rewriting the bag-level walk in terms of this
// one because `pruneOversizedEditSnapshots` and its exact bag-shaped output
// are still pinned by `edit-snapshot-details.test.ts` and by direct callers
// that still consume the bag shape.

function evidenceByteCost(evidence: FileChangeEvidence): number {
	if (evidence.kind === "pruned") return 0;
	const { change } = evidence;
	return (change.before?.length ?? 0) + (change.after?.length ?? 0);
}

/** Strip an applied file's content snapshot, keeping only the tag data {@link PrunedFileChange} retains. */
function pruneEvidence(evidence: FileChangeEvidence): FileChangeEvidence {
	const { change } = evidence;
	return {
		kind: "pruned",
		reason: "aggregate-byte-budget",
		change:
			change.operation === "move"
				? { operation: "move", sourcePath: change.sourcePath }
				: { operation: change.operation },
	};
}

function pruneAppliedFileIfOversized(file: AppliedEditFile): AppliedEditFile {
	if (file.evidence.kind === "pruned" || evidenceByteCost(file.evidence) <= MAX_EDIT_SNAPSHOT_TEXT_CHARS) return file;
	return { ...file, evidence: pruneEvidence(file.evidence) };
}

/**
 * Walk a call's file outcomes in order with a shared byte budget, pruning
 * `applied` entries whose evidence survives individual capping but pushes
 * the running aggregate past {@link MAX_EDIT_SNAPSHOT_TEXT_CHARS}. `failed`/
 * `skipped` entries carry no snapshot and pass through unchanged.
 */
export function pruneEditFileSnapshots(files: readonly EditFileOutcome[]): EditFileOutcome[] {
	let remaining = MAX_EDIT_SNAPSHOT_TEXT_CHARS;
	return files.map(file => {
		if (file.kind !== "applied") return file;
		const perEntry = pruneAppliedFileIfOversized(file);
		const kept = evidenceByteCost(perEntry.evidence);
		if (kept === 0) return perEntry;
		if (kept <= remaining) {
			remaining -= kept;
			return perEntry;
		}
		return { ...perEntry, evidence: pruneEvidence(perEntry.evidence) };
	});
}
