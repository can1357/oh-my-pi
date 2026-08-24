import type {
	ToolAttachment,
	ToolCallPresentation,
	ToolOutcome,
	ToolPresentationEvent,
} from "@oh-my-pi/pi-agent-core/presentation";
import { streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import type { NonEmptyArray } from "@oh-my-pi/pi-utils/types";
import { type EditResult, knownResultText } from "../../../presentation/known-tool-result";
import { fenceBlock } from "../../../presentation/projections";
import type {
	PresentationEditBagDetails,
	PresentationEditDetails,
	PresentationEditPerFileResult,
	PresentationSingleFileEditDetails,
} from "../../../presentation/schemas/details";
import type { PresentationOutputMeta } from "../../../presentation/schemas/output-meta";
import type { AcpStatusChange, AcpToolFrame } from "./frames";
import { nonTerminalContent } from "./frames";

/** The registered built-ins that share EditTool's legacy result contract. */
export function isLegacyEditToolName(toolName: string): toolName is "edit" | "patch" | "apply_patch" {
	return toolName === "edit" || toolName === "patch" || toolName === "apply_patch";
}

/** Construct the typed start record once; no legacy result shape is read here. */
export function legacyEditStartedEvent(call: ToolCallPresentation): ToolPresentationEvent {
	return { type: "started", call };
}

/** Typed replacement frame for an EditTool progress snapshot. */
export function legacyEditUpdateFrames(
	toolCallId: string,
	result: EditResult,
	locations?: readonly { readonly path: string; readonly line?: number }[],
	resolveImageData?: (data: string, mimeType: string | undefined) => string,
): readonly AcpToolFrame[] {
	const changes = [
		{ kind: "status" as const, value: "in_progress" as const },
		...(locations === undefined || locations.length === 0 ? [] : [{ kind: "locations" as const, value: locations }]),
	] as const;
	const content = nonTerminalContent([
		...textContent(knownResultText(result)),
		...imageAttachments(result, resolveImageData).map(attachment => ({
			type: "image" as const,
			data: attachment.data,
			mimeType: attachment.mimeType,
		})),
	]);
	if (content === undefined) {
		return [{ channel: "status", toolCallId, announce: false, changes }];
	}
	return [
		{
			channel: "content",
			toolCallId,
			announce: false,
			contentMode: "replacement_snapshot",
			content,
			changes,
		},
	];
}

/**
 * One file's contribution to a legacy edit result, folded — through a
 * strict schema, never by probing optional fields — from either a
 * `perFileResults` entry or the single-file bag's own top-level fields.
 */
type EditRow =
	| { readonly kind: "failed"; readonly path: string; readonly message: string | undefined }
	| {
			readonly kind: "available";
			readonly path: string | undefined;
			readonly oldText: string | undefined;
			readonly newText: string | undefined;
			readonly meta: PresentationOutputMeta | undefined;
	  }
	| { readonly kind: "pruned"; readonly path: string | undefined; readonly meta: PresentationOutputMeta | undefined };

/** Fold one `perFileResults` entry, already validated by `editPerFileSchema`. */
function toRow(entry: PresentationEditPerFileResult): EditRow {
	if (entry.isError === true) {
		return { kind: "failed", path: entry.path, message: entry.displayErrorText ?? entry.errorText };
	}
	// Two arms remain: `snapshotsPruned: true` (required) or the available
	// arm's `snapshotsPruned?: false` (optional). TS cannot prove this `if`
	// exhausts the optional arm's `false | undefined` via equality narrowing
	// (a real TS limitation, reproduced in isolation independent of zod), so
	// the available arm is the implicit `else` rather than a third checked
	// branch asserting `never`.
	if (entry.snapshotsPruned === true) {
		return { kind: "pruned", path: entry.path, meta: entry.meta };
	}
	return { kind: "available", path: entry.path, oldText: entry.oldText, newText: entry.newText, meta: entry.meta };
}

/** Fold a single-file bag's own fields into the row shape a `perFileResults` entry projects to. */
function toSingleRow(details: PresentationSingleFileEditDetails): EditRow {
	// See `toRow`'s comment: the available arm is the implicit `else`, not a
	// third `never`-checked branch, for the same TS narrowing limitation.
	if (details.snapshotsPruned === true) {
		return { kind: "pruned", path: details.path, meta: details.meta };
	}
	return {
		kind: "available",
		path: details.path,
		oldText: details.oldText,
		newText: details.newText,
		meta: details.meta,
	};
}

/**
 * Every file row a legacy edit result carries, plus the aggregate-level
 * fields the detail-reading helpers below fold over. One exhaustive
 * dispatch on the schema-validated details union replaces the old
 * `perFileResults ?? [details]` idiom: a lifecycle result (thrown-empty,
 * pre-dispatch validation failure, or the synthetic never-executed shape —
 * none of which describe a file) yields no rows, rather than being probed
 * as if it might.
 */
interface EditDetailsRows {
	readonly rows: readonly EditRow[];
	readonly unattemptedPaths: readonly string[] | undefined;
	readonly aggregateMeta: PresentationOutputMeta | undefined;
	/** Only the multi-file bag attributes each row's own `meta` by path; the single-file bag's one row IS the aggregate. */
	readonly attributeRowMeta: boolean;
}

/**
 * `"diff" in details` alone does not narrow away the thrown-failure arm for
 * the compiler: `z.strictObject({})` infers as `Record<string, never>`,
 * whose index signature makes every key "exist" at type `never`. An
 * explicit predicate is what actually excludes it.
 */
function isEditBagDetails(details: PresentationEditDetails): details is PresentationEditBagDetails {
	return "diff" in details;
}

function editDetailsRows(details: PresentationEditDetails): EditDetailsRows {
	if (!isEditBagDetails(details)) {
		return { rows: [], unattemptedPaths: undefined, aggregateMeta: undefined, attributeRowMeta: false };
	}
	if (details.perFileResults !== undefined) {
		return {
			rows: details.perFileResults.map(toRow),
			unattemptedPaths: details.unattemptedPaths,
			aggregateMeta: details.meta,
			attributeRowMeta: true,
		};
	}
	return {
		rows: [toSingleRow(details)],
		unattemptedPaths: undefined,
		aggregateMeta: details.meta,
		attributeRowMeta: false,
	};
}

/** Result-derived paths stay inside the typed edit adapter. */
function legacyEditLocations(
	result: EditResult,
	cwd?: string,
	resolveLocationPath?: (path: string, cwd: string) => string,
): readonly { readonly path: string }[] {
	const paths = editDetailsRows(result.details)
		.rows.map(row => row.path)
		.filter((path): path is string => path !== undefined && path.length > 0);
	return [...new Set(paths)]
		.filter(path => !/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
		.map(path => ({
			path: cwd === undefined || resolveLocationPath === undefined ? path : resolveLocationPath(path, cwd),
		}));
}

/** Translate one parsed legacy edit result into structured reducer events. */
export function legacyEditSettlementEvents(
	toolCallId: string,
	result: EditResult,
	failed: boolean,
	formatOutputNotice: (meta: PresentationOutputMeta | undefined) => string,
	resolveImageData?: (data: string, mimeType: string | undefined) => string,
): readonly ToolPresentationEvent[] {
	const presentation = compileLegacyEditPresentation(result, failed, formatOutputNotice, resolveImageData);
	const events: ToolPresentationEvent[] = [];
	if (presentation.body !== undefined) {
		const stream = new ToolPresentationStream(streamId(toolCallId), event => events.push(event));
		stream.appendTerminal(presentation.body);
	}
	for (const attachment of presentation.attachments) events.push({ type: "attachment", attachment });
	events.push({ type: "settled", outcome: presentation.outcome });
	return events;
}

/** Add parsed edit paths to the encoded terminal frame, preserving one terminal update. */
export function legacyEditFramesWithLocations(
	toolCallId: string,
	frames: readonly AcpToolFrame[],
	result: EditResult,
	cwd?: string,
	resolveLocationPath?: (path: string, cwd: string) => string,
): readonly AcpToolFrame[] {
	const locations = legacyEditLocations(result, cwd, resolveLocationPath);
	const orderedFrames = frames.map(orderLegacyEditContent);
	if (locations.length === 0) return orderedFrames;
	const locationChange: AcpStatusChange = { kind: "locations", value: locations };
	const final = orderedFrames.at(-1);
	if (final === undefined || (final.channel !== "content" && final.channel !== "status")) {
		return [...orderedFrames, { channel: "status", toolCallId, announce: false, changes: [locationChange] }];
	}
	const changes: NonEmptyArray<AcpStatusChange> =
		final.changes === undefined ? [locationChange] : [...final.changes, locationChange];
	return [...orderedFrames.slice(0, -1), { ...final, changes }];
}

/**
 * The legacy ACP mapper emitted edit diffs before notice/body text. Preserve
 * that literal structured order without reparsing or reconciling any text.
 */
function orderLegacyEditContent(frame: AcpToolFrame): AcpToolFrame {
	if (frame.channel !== "content") return frame;
	const diffs = frame.content.filter(item => item.type === "diff");
	if (diffs.length === 0) return frame;
	const rest = frame.content.filter(item => item.type !== "diff");
	return { ...frame, content: nonTerminalContent([...diffs, ...rest])! };
}

function compileLegacyEditPresentation(
	result: EditResult,
	failed: boolean,
	formatOutputNotice: (meta: PresentationOutputMeta | undefined) => string,
	resolveImageData?: (data: string, mimeType: string | undefined) => string,
): {
	readonly body: string | undefined;
	readonly attachments: readonly ToolAttachment[];
	readonly outcome: ToolOutcome;
} {
	const view = editDetailsRows(result.details);
	const attachments: ToolAttachment[] = [];
	for (const row of view.rows) {
		if (row.kind !== "available" || row.path === undefined) continue;
		if (row.oldText === undefined && row.newText === undefined) continue;
		attachments.push({
			kind: "diff",
			path: row.path,
			oldText: row.oldText ?? null,
			newText: row.newText ?? "",
		});
	}
	attachments.push(...imageAttachments(result, resolveImageData));
	const diffPresent = attachments.some(attachment => attachment.kind === "diff");
	const notices = outputNotices(view, formatOutputNotice);
	const pruned = prunedPathsText(view.rows);
	const failures = failureText(view);
	const body =
		diffPresent && !failed
			? joinSections([pruned, notices])
			: diffPresent && failures !== undefined
				? joinSections([pruned, failures, notices])
				: limitLegacyEditText(knownResultText(result)) || undefined;
	return {
		body,
		attachments,
		outcome: failed
			? {
					kind: "failed",
					failure: { reason: "tool_reported", message: failures ?? (knownResultText(result) || "Edit failed") },
				}
			: { kind: "succeeded" },
	};
}

function textContent(text: string): readonly { type: "text"; text: string }[] {
	return text.length === 0 ? [] : [{ type: "text", text: fenceBlock(limitLegacyEditText(text)) }];
}

function imageAttachments(
	result: EditResult,
	resolveImageData?: (data: string, mimeType: string | undefined) => string,
): Extract<ToolAttachment, { kind: "image" }>[] {
	return result.content
		.filter(
			(content): content is Extract<EditResult["content"][number], { type: "image" }> => content.type === "image",
		)
		.map(content => ({
			kind: "image" as const,
			data: resolveImageData?.(content.data, content.mimeType) ?? content.data,
			mimeType: content.mimeType,
		}));
}

/** Matches the legacy ACP text-content budget (4,000 code units, ellipsis included). */
function limitLegacyEditText(text: string): string {
	return text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text;
}

function failureText(view: EditDetailsRows): string | undefined {
	const lines: string[] = [];
	for (const row of view.rows) {
		if (row.kind !== "failed") continue;
		if (row.message === undefined || row.message.length === 0) continue;
		lines.push(`Error editing ${row.path}: ${row.message}`);
	}
	if (view.unattemptedPaths !== undefined && view.unattemptedPaths.length > 0) {
		lines.push(
			`Files NOT applied: ${view.unattemptedPaths.join(", ")}; re-read the affected files and re-issue only the failed and unapplied files.`,
		);
	}
	return lines.length === 0 ? undefined : lines.join("\n");
}

function prunedPathsText(rows: readonly EditRow[]): string | undefined {
	const paths = rows
		.filter((row): row is Extract<EditRow, { readonly kind: "pruned" }> => row.kind === "pruned")
		.map(row => row.path)
		.filter((path): path is string => path !== undefined && path.length > 0);
	return paths.length === 0 ? undefined : `Also applied (diff omitted: file snapshot too large): ${paths.join(", ")}`;
}

function outputNotices(
	view: EditDetailsRows,
	formatOutputNotice: (meta: PresentationOutputMeta | undefined) => string,
): string | undefined {
	const notices: string[] = [];
	const seen = new Set<string>();
	const push = (meta: PresentationOutputMeta | undefined, path: string | undefined) => {
		if (meta === undefined) return;
		const notice = formatOutputNotice(meta).trim();
		if (notice.length === 0) return;
		const attributed = path === undefined || path.length === 0 ? notice : `${path}: ${notice}`;
		if (seen.has(attributed)) return;
		seen.add(attributed);
		notices.push(attributed);
	};
	push(view.aggregateMeta, undefined);
	if (view.attributeRowMeta) {
		for (const row of view.rows) push(row.kind === "failed" ? undefined : row.meta, row.path);
	}
	return notices.length === 0 ? undefined : notices.join("\n\n");
}

function joinSections(sections: readonly (string | undefined)[]): string | undefined {
	const values = sections.filter((section): section is string => section !== undefined && section.length > 0);
	return values.length === 0 ? undefined : values.join("\n\n");
}
