/**
 * The one parser for **external / unmigrated** tool results whose `details`
 * happen to be shaped like an edit bag, plus the readers that walk it.
 *
 * Nothing here can be reached by a built-in `edit`/`patch`/`apply_patch`
 * call. `AcpAgent#handlePromptEvent` gates every tool lifecycle event on
 * `session.hasBuiltInToolDispatch(toolName) && isLegacyEditToolName(toolName)`,
 * routes those to `#handleLegacyEditEvent`, and **returns** before
 * `mapAgentSessionEventToAcpSessionUpdates` — the mapper's generic branch and
 * therefore this module — ever runs. What still arrives here is:
 *
 *  - an MCP/extension/custom tool (`origin: "external"`) whose result carries
 *    edit-shaped `details` — including one *shadowing* a built-in name, the
 *    case `hasBuiltInToolDispatch` deliberately excludes;
 *  - any other unmigrated result with a `details.meta`, for
 *    {@link externalEditNoticeText}: {@link asExternalEditDetails} validates
 *    the edit-shaped fields *only when present*, so a `read`/`grep` result
 *    carrying just a `meta` still narrows and keeps its notice.
 *
 * That second group is why this module is a reduction to a named scope rather
 * than an `origin: "external"` runtime gate: the generic mapper route holds no
 * provenance, and gating on it would drop the notices of every non-edit
 * built-in that rides the same route.
 *
 * The diff/text readers take an already-parsed {@link ExternalEditDetails} so
 * the end-frame branch parses once instead of five times.
 */

import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { EditToolDetails, EditToolPerFileResult } from "../../edit";
import { type PresentationOutputMeta, salvageOutputMeta } from "../../presentation/schemas/output-meta";
import { formatOutputNotice, isRecord } from "../../tools/output-meta";

/**
 * The subset of the producer's result types this parser reads, kept as
 * `Pick`s rather than a hand-copied shape: the runtime validators below
 * describe the producer by hand, so a field renamed or retyped in
 * `EditToolPerFileResult`/`EditToolDetails` would otherwise make every real
 * edit result fail {@link asExternalEditDetails} and silently fall back to
 * plain content — the same silent-omission class this subsystem exists to
 * close, moved into the validator. Derived here, `tsgo` fails instead.
 *
 * `isError`/`errorText`/`displayErrorText` are per-file only on the producer
 * (`EditToolDetails` has no such fields), so the aggregate declares them
 * itself for the extension/MCP results that reach this narrowing.
 *
 * `meta` stays `unknown` here and is narrowed per read by `salvageOutputMeta`:
 * unlike `oldText`/`newText`/`path`, which compose a `diff` frame and must
 * reject the whole result when malformed, a bad `meta` costs only its notice.
 */
type ExternalEditFields = Pick<
	EditToolPerFileResult,
	"path" | "oldText" | "newText" | "isError" | "errorText" | "displayErrorText" | "snapshotsPruned" | "meta"
>;

export type ExternalEditEntry = Omit<ExternalEditFields, "meta"> & { meta?: unknown };

export interface ExternalEditDetails
	extends Partial<Omit<Pick<EditToolDetails, "path" | "oldText" | "newText" | "snapshotsPruned" | "meta">, "meta">> {
	meta?: unknown;
	isError?: boolean;
	errorText?: string;
	displayErrorText?: string;
	perFileResults?: ExternalEditEntry[];
	unattemptedPaths?: EditToolDetails["unattemptedPaths"];
}

function hasValidEditFields(value: Record<string, unknown>): boolean {
	for (const key of [
		"path",
		"oldText",
		"newText",
		"errorText",
		"displayErrorText",
	] as const satisfies readonly (keyof ExternalEditEntry)[]) {
		if (value[key] !== undefined && typeof value[key] !== "string") return false;
	}
	for (const key of ["isError", "snapshotsPruned"] as const satisfies readonly (keyof ExternalEditEntry)[]) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
	}
	return true;
}

function isExternalEditEntry(value: unknown): value is ExternalEditEntry {
	return isRecord(value) && typeof value.path === "string" && hasValidEditFields(value);
}

/** Built-in edit calls bypass this compatibility extractor entirely — see the module doc. */
export function asExternalEditDetails(result: unknown): ExternalEditDetails | undefined {
	if (!isRecord(result)) return undefined;
	const details = result.details;
	if (!isRecord(details) || !hasValidEditFields(details)) return undefined;
	const perFileResults = details.perFileResults;
	if (perFileResults !== undefined && (!Array.isArray(perFileResults) || !perFileResults.every(isExternalEditEntry))) {
		return undefined;
	}
	const unattemptedPaths = details.unattemptedPaths;
	if (unattemptedPaths !== undefined) {
		if (!Array.isArray(unattemptedPaths) || !unattemptedPaths.every(path => typeof path === "string"))
			return undefined;
	}
	return details as ExternalEditDetails;
}

/** Emit a `diff` ToolCallContent for each per-file edit result that carries oldText/newText. */
export function externalEditDiffContent(details: ExternalEditDetails): ToolCallContent[] {
	const entries: (ExternalEditEntry | ExternalEditDetails)[] = details.perFileResults ?? [details];
	const blocks: ToolCallContent[] = [];
	for (const entry of entries) {
		const block = buildDiffContent(entry);
		if (block) blocks.push(block);
	}
	return blocks;
}

/**
 * Join the per-file error messages from a partially-failed multi-file edit,
 * skipping succeeded entries, followed by which files were never attempted
 * (see `EditToolDetails.unattemptedPaths`) — mirrors the executor's own
 * `Files NOT applied: ...` guidance line so the ACP display can tell a
 * skipped-after-failure file apart from one that was never part of the edit.
 */
export function externalEditFailureText(details: ExternalEditDetails): string | undefined {
	if (!details.perFileResults) return undefined;
	const lines: string[] = [];
	for (const entry of details.perFileResults) {
		if (entry.isError !== true) continue;
		const message = entry.displayErrorText || entry.errorText;
		if (!message) continue;
		const path = entry.path.length > 0 ? entry.path : undefined;
		lines.push(path ? `Error editing ${path}: ${message}` : message);
	}
	if (lines.length === 0) return undefined;
	if (Array.isArray(details.unattemptedPaths) && details.unattemptedPaths.length > 0) {
		const paths = details.unattemptedPaths.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (paths.length > 0) {
			lines.push(
				`Files NOT applied: ${paths.join(", ")}; re-read the affected files and re-issue only the failed and unapplied files.`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * Names of successfully-edited files whose `oldText`/`newText` were dropped
 * by {@link pruneOversizedEditSnapshots} once the multi-file aggregate budget
 * (`MAX_EDIT_SNAPSHOT_TEXT_CHARS`) ran out — see `snapshot-details.ts`. Early
 * entries keep their diff; a later entry in the same batch can lose its
 * snapshot despite editing the file just as successfully. `buildDiffContent`
 * then has nothing to render for it, so without this note the file
 * disappears from the ACP content entirely even though the edit succeeded.
 *
 * Only entries with no diff of their own are named here — a pruned entry
 * that still has room for its own snapshot never reaches this path.
 */
export function externalEditPrunedPathsText(details: ExternalEditDetails): string | undefined {
	if (!details.perFileResults) return undefined;
	const paths: string[] = [];
	for (const entry of details.perFileResults) {
		if (entry.isError === true || entry.snapshotsPruned !== true) continue;
		if (buildDiffContent(entry)) continue;
		if (entry.path.length > 0) paths.push(entry.path);
	}
	if (paths.length === 0) return undefined;
	return `Also applied (diff omitted: file snapshot too large): ${paths.join(", ")}`;
}

/**
 * Re-render `wrapToolWithMetaNotice`'s notice (truncation/limit text, and
 * critically LSP diagnostics from a successful edit) directly from the
 * structured `details.meta` field, independent of whatever text content it
 * was originally appended to. The edit-content branches in the mapper discard
 * the general content array whenever a diff exists, which would otherwise take
 * this notice down with it — diagnostics on a successful edit are exactly as
 * real as diagnostics on any other tool call and must survive next to the
 * diff, not just in "Copy as Markdown" export.
 *
 * `executeApplyPatchPerFile`'s multi-file aggregate has no top-level
 * `details.meta` at all — each file's own `meta` (with its own diagnostics)
 * lives only in `details.perFileResults[].meta` (see `edit/index.ts`). Scan
 * those too, prefixed by path since distinct files can carry distinct
 * notices, and dedupe against the aggregate in case the two ever coincide.
 */
export function externalEditNoticeText(details: ExternalEditDetails): string | undefined {
	const notices: string[] = [];
	const seen = new Set<string>();
	const pushNotice = (meta: PresentationOutputMeta | undefined, path: string | undefined) => {
		const notice = formatOutputNotice(meta).trim();
		const attributedNotice = path ? `${path}: ${notice}` : notice;
		if (!notice || seen.has(attributedNotice)) return;
		seen.add(attributedNotice);
		notices.push(attributedNotice);
	};
	pushNotice(salvageOutputMeta(details.meta), undefined);
	for (const entry of details.perFileResults ?? []) {
		pushNotice(salvageOutputMeta(entry.meta), entry.path.length > 0 ? entry.path : undefined);
	}
	return notices.length > 0 ? notices.join("\n\n") : undefined;
}

function buildDiffContent(entry: {
	path?: string;
	oldText?: string;
	newText?: string;
	isError?: boolean;
}): ToolCallContent | undefined {
	if (entry.isError === true) return undefined;
	const path = entry.path && entry.path.length > 0 ? entry.path : undefined;
	if (!path) return undefined;
	if (entry.oldText === undefined && entry.newText === undefined) return undefined;
	return {
		type: "diff",
		path,
		oldText: entry.oldText ?? null,
		newText: entry.newText ?? "",
	};
}
