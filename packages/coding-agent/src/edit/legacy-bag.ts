/**
 * Project {@link EditFileOutcome}/{@link AggregateEditOutcome} — the closed
 * per-file union that is now the single source of truth — onto the legacy
 * {@link EditToolDetails}/{@link EditToolPerFileResult} bag every existing
 * consumer (the ACP `legacy-edit.ts` view, model/TUI renderers, the
 * extension API) still reads. Producers build the union first and
 * derive the bag from it via the helpers here — the bag is never
 * hand-constructed at a producer call site anymore.
 *
 * Presentation data the union deliberately does not carry (rendered `diff`
 * text, `firstChangedLine`, LSP `diagnostics`, `meta`) is supplied alongside
 * the outcome by the producer, which already computed it while performing
 * the edit.
 */

import type { OutputMeta } from "../tools/output-meta";
import type {
	AppliedEditFile,
	AttemptedEditFile,
	EditFileOutcome,
	EditToolDetails,
	EditToolPerFileResult,
} from "./types";

/**
 * One producer call's production for a single file: the `EditFileOutcome`
 * the closed union models, plus the presentation data it doesn't
 * ({@link EditFilePresentation}), the legacy `move` string (see
 * {@link legacyEditFileResult}'s `move` param), and the tool-call text.
 * `executePatchSingleProduction`/`executeReplaceSingleProduction`/hashline's
 * `renderSection` all return this shape so `executeApplyPatchPerFile` and
 * `executeSinglePathEntries` (`edit/index.ts`) can build one
 * `EditFileOutcomes` array and call `aggregateEditOutcome` once, instead of
 * reconstructing the union from an already-projected bag.
 */
export interface SingleFileProduction {
	readonly file: AppliedEditFile;
	readonly presentation: EditFilePresentation;
	readonly move: string | undefined;
	readonly text: string;
}

/**
 * Presentation data for one applied file that the closed union does not
 * model: `diff` is derived from `before`/`after` by a diff generator whose
 * exact output (context lines, path header) the union has no opinion on,
 * `firstChangedLine` is a diff-generator artifact, and `meta`/`diagnostics`
 * come from the LSP writethrough the union doesn't touch.
 */
export interface EditFilePresentation {
	readonly diff: string;
	readonly firstChangedLine?: number;
	readonly meta?: OutputMeta;
}

/**
 * Legacy `op`/`move`/`sourcePath` fields, derived from an applied file's
 * change. `replace` mode never populated these on the bag (it has no concept
 * of operation kind or move), so callers that never emitted them pass
 * `operationTags: false` to keep projecting exactly nothing — adding fields
 * a byte-identical consumer never saw would itself be a wire-shape change.
 */
function legacyChangeTags(
	file: AppliedEditFile,
	move: string | undefined,
): Pick<EditToolPerFileResult, "op" | "move" | "sourcePath"> {
	const { evidence } = file;
	const operation = evidence.change.operation;
	// The bag's `op` is `"create" | "delete" | "update"` (see `Operation` in
	// `modes/patch.ts`) — `move` is a distinct field layered on top of an
	// `"update"`, not a fourth `op` value, matching what `executePatchSingle`
	// and hashline's `renderSection` already did before this slice.
	const op = operation === "move" ? "update" : operation;
	const sourcePath = evidence.change.operation === "move" ? evidence.change.sourcePath : undefined;
	return { op, move: operation === "move" ? move : undefined, sourcePath };
}

/**
 * `oldText`/`newText` derived from an applied file's evidence — `undefined`
 * for the arms `AvailableFileChange` types as `null`, present (possibly
 * empty) otherwise, absent entirely when the snapshot was pruned.
 */
function legacySnapshotFields(
	file: AppliedEditFile,
): Pick<EditToolPerFileResult, "oldText" | "newText" | "snapshotsPruned"> {
	const { evidence } = file;
	if (evidence.kind === "pruned") {
		return { snapshotsPruned: true };
	}
	const { before, after } = evidence.change;
	return { oldText: before ?? undefined, newText: after ?? undefined };
}

/**
 * Project one attempted file (`applied` or `failed` — `skipped` entries
 * never reach a per-file bag row, they only ever contributed to
 * `unattemptedPaths`) onto the legacy per-file shape.
 *
 * @param move The authored/resolved move destination string for the legacy
 *   `move` field, when this file's change is a move. Not derivable from the
 *   union alone: `patch` mode's legacy `move` is the model-authored rename
 *   argument (pre-path-resolution), which can differ textually from the
 *   union's `sourcePath`/`path` (both resolved). Ignored for non-move files.
 * @param operationTags Whether to emit `op`/`move`/`sourcePath` at all —
 *   `false` for `replace` mode, which never populated these on the bag.
 */
export function legacyEditFileResult(
	file: AttemptedEditFile,
	presentation: EditFilePresentation,
	move: string | undefined,
	operationTags: boolean,
): EditToolPerFileResult {
	if (file.kind === "failed") {
		return {
			path: file.path,
			diff: "",
			isError: true,
			errorText: file.message,
			displayErrorText: file.displayMessage,
		};
	}
	return {
		path: file.path,
		diff: presentation.diff,
		firstChangedLine: presentation.firstChangedLine,
		diagnostics: file.diagnostics,
		meta: presentation.meta,
		...(operationTags ? legacyChangeTags(file, move) : {}),
		...legacySnapshotFields(file),
	};
}

/**
 * Project one successfully-applied file onto the legacy `details` shape a
 * single-file producer (`executePatchSingle`, `executeReplaceSingle`,
 * hashline's single-section fast path) returns directly as
 * `AgentToolResult.details`. These producers throw rather than return on
 * failure, so — unlike {@link legacyEditFileResult} — there is no `failed`
 * arm to project here.
 */
export function legacyEditDetails(
	file: AppliedEditFile,
	presentation: EditFilePresentation,
	move: string | undefined,
	operationTags: boolean,
): EditToolDetails {
	return {
		diff: presentation.diff,
		firstChangedLine: presentation.firstChangedLine,
		diagnostics: file.diagnostics,
		path: file.path,
		meta: presentation.meta,
		...(operationTags ? legacyChangeTags(file, move) : {}),
		...legacySnapshotFields(file),
	};
}

/**
 * `unattemptedPaths`: every `skipped` entry's path, in call order — never
 * maintained independently of the aggregate's own file list.
 */
export function legacyUnattemptedPaths(files: readonly EditFileOutcome[]): string[] | undefined {
	const paths = files
		.filter((file): file is Extract<EditFileOutcome, { kind: "skipped" }> => file.kind === "skipped")
		.map(file => file.path);
	return paths.length > 0 ? paths : undefined;
}
