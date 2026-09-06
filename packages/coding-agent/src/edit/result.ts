/**
 * Shared model-visible and structured results for every edit backend.
 *
 * A completed edit always needs the same hashline-compatible preview,
 * diagnostics metadata, snapshot cap, and aggregate shape. Keeping those
 * mechanics here makes each backend responsible only for applying its edit.
 */
import { buildCompactDiffPreview } from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FileDiagnosticsResult } from "../lsp";
import { outputMeta } from "../tools/output-meta";
import { generateDiffString } from "./diff";
import type { Operation } from "./modes/patch";
import type { EditToolDetails, EditToolPerFileResult } from "./renderer";
import { pruneOversizedEditSnapshots } from "./snapshot-details";

/** Separates completed edit sections in model-visible tool output. */
export const EDIT_RESULT_SEPARATOR = "\n\n";

/** A normalized before/after pair used to render a hashline-compatible preview. */
export interface EditPreviewSource {
	before: string;
	after: string;
	path: string;
}

/** Inputs shared by every completed single-file edit result. */
export interface EditResultOptions {
	displayPath: string;
	resultPath?: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	sourcePath?: string;
	oldText?: string;
	newText?: string;
	/** Overrides the standard `[path]` result header, used by hashline tags. */
	header?: string;
	/** Adds operation-specific lines between the header and preview. */
	beforePreview?: readonly string[];
	/** Adds operation-specific lines after the preview. */
	afterPreview?: readonly string[];
	/** Appends parser or write warnings after the result body. */
	warnings?: readonly string[];
	/** Uses the normalized content pair for a hashline-compatible preview. */
	previewSource?: EditPreviewSource;
	/** Bypasses standard result formatting for no-op diagnostics. */
	text?: string;
}

/** The model-visible and structured forms of one completed edit. */
export interface EditResult {
	text: string;
	details: EditToolDetails;
	perFileResult: EditToolPerFileResult;
}

/** Inputs for a multi-entry edit result. */
export interface AggregateEditDetailsOptions {
	perFileResults?: readonly EditToolPerFileResult[];
	diff?: string;
	firstChangedLine?: number;
	path?: string;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
}

/** Joins model-visible edit sections with hashline's blank-line separator. */
export function joinEditResultText(sections: readonly string[]): string {
	return sections.filter(Boolean).join(EDIT_RESULT_SEPARATOR);
}

/** Pulls the text portion from an edit result for multi-entry aggregation. */
export function getEditResultText(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content?.find(part => part.type === "text")?.text ?? "";
}

/** Copies a single-file result into an aggregate's per-file result list. */
export function toEditPerFileResult(details: EditToolDetails | undefined, fallbackPath: string): EditToolPerFileResult {
	return {
		path: details?.path ?? fallbackPath,
		diff: details?.diff ?? "",
		firstChangedLine: details?.firstChangedLine,
		diagnostics: details?.diagnostics,
		op: details?.op,
		move: details?.move,
		sourcePath: details?.sourcePath,
		meta: details?.meta,
		oldText: details?.oldText,
		newText: details?.newText,
		snapshotsPruned: details?.snapshotsPruned,
	};
}

/** Records a failed file entry in a partial multi-file edit result. */
export function createFailedEditResult(
	path: string,
	errorText: string,
	displayErrorText?: string,
): EditToolPerFileResult {
	return {
		path,
		diff: "",
		isError: true,
		errorText,
		...(displayErrorText ? { displayErrorText } : {}),
	};
}

/** Builds bounded structured details for a multi-entry edit result. */
export function createAggregateEditDetails(options: AggregateEditDetailsOptions): EditToolDetails {
	const perFileResults = options.perFileResults ? [...options.perFileResults] : undefined;
	const details: EditToolDetails = {
		diff:
			options.diff ??
			perFileResults
				?.map(entry => entry.diff)
				.filter(Boolean)
				.join("\n") ??
			"",
		firstChangedLine:
			options.firstChangedLine ??
			perFileResults?.find(entry => entry.firstChangedLine !== undefined)?.firstChangedLine,
		...(perFileResults ? { perFileResults } : {}),
		...(options.path ? { path: options.path } : {}),
		...("oldText" in options ? { oldText: options.oldText } : {}),
		...("newText" in options ? { newText: options.newText } : {}),
		...(options.snapshotsPruned ? { snapshotsPruned: true } : {}),
	};
	return pruneOversizedEditSnapshots(details);
}

/** Converts a rendered edit result into the agent tool-result envelope. */
export function toEditToolResult(result: EditResult): AgentToolResult<EditToolDetails> {
	return {
		content: [{ type: "text", text: result.text }],
		details: result.details,
	};
}

/** Builds the agent tool-result envelope for a completed aggregate edit. */
export function createAggregateEditToolResult(
	text: string,
	details: EditToolDetails,
	isError = false,
): AgentToolResult<EditToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function formatEditResultText(options: EditResultOptions): string {
	if (options.text !== undefined) return options.text;
	if (options.op === "delete") return `Deleted ${options.displayPath}`;

	const previewDiff = options.previewSource
		? generateDiffString(options.previewSource.before, options.previewSource.after, undefined, {
				path: options.previewSource.path,
			}).diff
		: options.diff;
	const preview = buildCompactDiffPreview(previewDiff).preview;
	const body = [
		options.header ?? `[${options.displayPath}]`,
		...(options.beforePreview ?? []),
		...(options.move ? [`Moved to ${options.move}`] : []),
		...(preview ? [preview] : []),
		...(options.afterPreview ?? []),
	]
		.filter(Boolean)
		.join("\n");
	const warnings = options.warnings?.filter(Boolean) ?? [];
	return `${body}${warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : ""}`;
}

/** Builds one hashline-style result and its aggregate-ready per-file details. */
export function createEditResult(options: EditResultOptions): EditResult {
	const text = formatEditResultText(options);
	const meta = outputMeta()
		.diagnostics(options.diagnostics?.summary ?? "", options.diagnostics?.messages ?? [])
		.get();
	const path = options.resultPath ?? options.displayPath;
	const perFileResult: EditToolPerFileResult = {
		path,
		diff: options.diff,
		firstChangedLine: options.firstChangedLine,
		diagnostics: options.diagnostics,
		op: options.op,
		move: options.move,
		sourcePath: options.sourcePath,
		meta,
		...("oldText" in options ? { oldText: options.oldText } : {}),
		...("newText" in options ? { newText: options.newText } : {}),
	};
	const details: EditToolDetails = {
		diff: options.diff,
		firstChangedLine: options.firstChangedLine,
		diagnostics: options.diagnostics,
		op: options.op,
		move: options.move,
		sourcePath: options.sourcePath,
		meta,
		...("oldText" in options ? { oldText: options.oldText } : {}),
		...("newText" in options ? { newText: options.newText } : {}),
		...(options.resultPath ? { path: options.resultPath } : {}),
	};
	return {
		text,
		details: pruneOversizedEditSnapshots(details),
		perFileResult: pruneOversizedEditSnapshots(perFileResult),
	};
}
