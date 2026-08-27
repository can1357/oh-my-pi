/**
 * Edit-tool producer contracts.
 *
 * `EditToolDetails`/`EditToolPerFileResult` are the producer's contract, so
 * they live here rather than in the renderer that merely consumes them.
 */

import type { ToolFailure, ToolOutcome } from "@oh-my-pi/pi-agent-core/presentation";
import { mintToolOutcome, outcomeFailed } from "@oh-my-pi/pi-agent-core/presentation";
import type { NonEmptyArray } from "@oh-my-pi/pi-utils";
import type { FileDiagnosticsResult } from "../lsp";
import type { OutputMeta } from "../tools/output-meta";
import type { Operation } from "./modes/patch";

// ═══════════════════════════════════════════════════════════════════════════
// Legacy bag (kept until every producer migrates onto the closed per-file union)
// ═══════════════════════════════════════════════════════════════════════════

export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	/** TUI-friendly error text. When present, rendered to the user instead of `errorText`.
	 * Set when the underlying error carries a `displayMessage` (e.g. {@link HashlineMismatchError}). */
	displayErrorText?: string;
	meta?: OutputMeta;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The header renders `sourcePath → path`. */
	sourcePath?: string;
}

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	move?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
	/** Per-file results (multi-file edits) */
	perFileResults?: EditToolPerFileResult[];
	/** Paths of files never attempted because an earlier file in the same multi-file edit failed first. */
	unattemptedPaths?: string[];
	/** Absolute file path for single-file edit results. Required by ACP diff metadata consumers. */
	path?: string;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The header renders `sourcePath → path`. */
	sourcePath?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Closed per-file union — computed internally by every edit producer, then
// projected back down to the legacy `EditToolDetails` bag (the bag is what
// crosses AgentToolResult.details)
// ═══════════════════════════════════════════════════════════════════════════

declare const normalizedPathBrand: unique symbol;

/**
 * A path that went through {@link normalizedPath}.
 *
 * Despite the name, this brand does **not** rewrite the string — edit paths
 * include internal URL targets (`memory://…`) that `node:path.normalize`
 * would corrupt, and producers already hand in a path they resolved
 * themselves. "Normalized" here means "validated non-empty", which is what
 * makes duplicate-path and empty-path detection in {@link aggregateEditOutcome}
 * a theorem about the brand rather than a repeated runtime check.
 */
export type NormalizedPath = string & { readonly [normalizedPathBrand]: true };

/** Validate and brand a producer-supplied path. Throws on empty/whitespace-only input. */
export function normalizedPath(value: string): NormalizedPath {
	if (value.trim().length === 0) {
		throw new Error("Edit file path must not be empty");
	}
	return value as NormalizedPath;
}

/**
 * One file's change, closed over the four operations a built-in edit
 * producer can perform. `before`/`after` are `null` for create/delete
 * instead of overloaded `undefined`, so `{before: null, after: null}` (a
 * change that changed nothing) is not representable.
 */
export type AvailableFileChange =
	| { readonly operation: "create"; readonly before: null; readonly after: string }
	| { readonly operation: "update"; readonly before: string; readonly after: string }
	| { readonly operation: "delete"; readonly before: string; readonly after: null }
	| { readonly operation: "move"; readonly sourcePath: string; readonly before: string; readonly after: string };

/**
 * The `AvailableFileChange` shape with `before`/`after` stripped, retained
 * only for the tag data a pruned entry still needs to render (the move
 * arm keeps `sourcePath` — {@link pruneOversizedEditSnapshots} drops content,
 * never provenance).
 */
export type PrunedFileChange =
	| { readonly operation: "create" | "update" | "delete" }
	| { readonly operation: "move"; readonly sourcePath: string };

/**
 * Whether a file's change snapshot survived the aggregate byte budget.
 * `snapshotsPruned: true` beside populated `before`/`after` is unrepresentable:
 * a change is in exactly one of these two states.
 */
export type FileChangeEvidence =
	| { readonly kind: "available"; readonly change: AvailableFileChange }
	| { readonly kind: "pruned"; readonly change: PrunedFileChange; readonly reason: "aggregate-byte-budget" };

/** One file's outcome within a multi-file edit call. */
export type EditFileOutcome =
	| {
			readonly kind: "applied";
			readonly path: NormalizedPath;
			readonly evidence: FileChangeEvidence;
			readonly diagnostics?: FileDiagnosticsResult;
	  }
	| {
			readonly kind: "failed";
			readonly path: string;
			readonly message: string;
			/** Human-facing variant of {@link message}, when the underlying error carried one (e.g. `HashlineMismatchError.displayMessage`). */
			readonly displayMessage?: string;
	  }
	| { readonly kind: "skipped"; readonly path: string; readonly reason: string };

/** The arm of {@link EditFileOutcome} that actually changed a file. */
export type AppliedEditFile = Extract<EditFileOutcome, { readonly kind: "applied" }>;

/** The arms of {@link EditFileOutcome} the producer actually attempted — everything a per-file legacy payload can describe. */
export type AttemptedEditFile = Exclude<EditFileOutcome, { readonly kind: "skipped" }>;

/** The non-empty per-file outcome list for one edit-tool call. */
export type EditFileOutcomes = NonEmptyArray<EditFileOutcome>;

/**
 * The aggregate outcome of one multi-file edit call, derived from
 * {@link EditFileOutcomes} — never set independently of the per-file results.
 */
export interface AggregateEditOutcome {
	readonly files: EditFileOutcomes;
	/** `failed` if any file failed, `succeeded` otherwise. The primary signal. */
	readonly outcome: ToolOutcome;
	/** Derived from {@link outcome}, kept for backward-compatible `AgentToolResult.isError` construction. */
	readonly isError: boolean;
}

/**
 * Build the aggregate outcome for a multi-file edit call from its per-file
 * results.
 *
 * Throws — never returns an error result — on any of the contradictions
 * this type exists to make unrepresentable in a *built-in* producer:
 *
 * - an empty file list;
 * - an empty `path` on a `failed`/`skipped` entry, or a `move` whose
 *   `sourcePath` is empty or equal to its own destination `path`;
 * - a `skipped` entry with no `failed` entry anywhere in the list (skipping
 *   is only meaningful as a consequence of an earlier failure — the
 *   unattempted-paths contradiction this guarantee rules out).
 *
 * A repeated `path` across entries is *not* rejected: `apply_patch` deletes
 * and re-adds the same path as two sequential hunks in one call (delete the
 * old file, add its replacement under the same name — a sanctioned
 * full-file-replacement idiom, not a producer bug), so entries model
 * ordered steps against a path, not a one-entry-per-path set. Duplicate
 * detection was a placeholder for "the aggregate isn't lying about
 * which files it touched"; that guarantee lives in the empty-path and
 * skipped/failed checks instead, which is what a lying aggregate actually
 * violates.
 *
 * An empty path or empty file list from a built-in producer is a producer
 * bug, not external input: external/untrusted input crosses a zod boundary
 * before it ever reaches this constructor, so this constructor's own
 * contract is throw-on-invariant-violation, not fail-closed-with-a-result.
 */
export function aggregateEditOutcome(files: readonly EditFileOutcome[]): AggregateEditOutcome {
	const [first, ...rest] = files;
	if (first === undefined) {
		throw new Error("aggregateEditOutcome requires at least one file");
	}
	const nonEmptyFiles: EditFileOutcomes = [first, ...rest];

	const failures: { path: string; message: string }[] = [];
	let hasSkipped = false;

	for (const file of nonEmptyFiles) {
		if (file.path.trim().length === 0) {
			throw new Error(`aggregateEditOutcome: ${file.kind} entry has an empty path`);
		}

		if (file.kind === "applied" && file.evidence.change.operation === "move") {
			const { sourcePath } = file.evidence.change;
			if (sourcePath.trim().length === 0) {
				throw new Error(`aggregateEditOutcome: move to ${JSON.stringify(file.path)} has an empty sourcePath`);
			}
			if (sourcePath === file.path) {
				throw new Error(`aggregateEditOutcome: move to ${JSON.stringify(file.path)} has sourcePath equal to path`);
			}
		}

		if (file.kind === "failed") {
			failures.push({ path: file.path, message: file.message });
		} else if (file.kind === "skipped") {
			hasSkipped = true;
		}
	}

	if (hasSkipped && failures.length === 0) {
		throw new Error("aggregateEditOutcome: a skipped entry requires at least one failed entry in the same call");
	}

	const outcome: ToolOutcome = mintToolOutcome(
		failures.length === 0
			? { kind: "succeeded" }
			: {
					kind: "failed",
					failure: {
						reason: "tool_reported",
						message: failures.map(f => `${f.path}: ${f.message}`).join("; "),
					} satisfies ToolFailure,
				},
	);

	return { files: nonEmptyFiles, outcome, isError: outcomeFailed(outcome) };
}
