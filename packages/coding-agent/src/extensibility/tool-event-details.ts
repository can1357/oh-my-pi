/**
 * `tool_result` event payload shapes that need more than a passthrough of the
 * producer's own `AgentToolResult.details` (see `normalizeToolEventInput` in
 * `tool-event-input.ts` for the sibling `input` normalization).
 *
 * The edit family is the one case today: `EditToolResultEvent.details` used
 * to be typed `EditToolDetails | undefined` — the producer's own internal bag
 * (`edit/types.ts`), which the extension surface had no business depending on.
 * That bag is re-derived here into a shape describing what actually happened
 * to each file, validated with the same {@link editBagDetailsSchema} that
 * `parseLegacyToolResult` (`presentation/known-tool-result.ts`) uses to
 * validate a producer's raw edit result — so a producer field rename fails
 * this projection's own type check instead of silently misprojecting.
 *
 * This is a boundary projection, not a passthrough: `ToolResultEventResult`
 * (the handler override channel) still carries `details?: unknown` and a
 * handler that returns it back for an `edit` event now echoes the *projected*
 * shape rather than the bag. That is the accepted half of the break — the
 * bag stops being an extension-surface contract at all.
 */

import { editBagDetailsSchema, type PresentationEditPerFileResult } from "../presentation/schemas/details";

/** One file's outcome as seen from the edit tool's `tool_result` event. */
export type EditToolResultFile =
	| {
			readonly status: "applied";
			readonly path: string;
			readonly diff: string;
			/** Absent for `replace` mode, which never tags an operation kind. */
			readonly operation?: "create" | "update" | "delete" | "move";
			/** Set only when {@link operation} is `"move"`. */
			readonly sourcePath?: string;
	  }
	| { readonly status: "failed"; readonly path: string; readonly message: string }
	/** Never attempted because an earlier file in the same multi-file edit failed first. No reason is available: the legacy bag this is derived from does not carry one per skipped file. */
	| { readonly status: "skipped"; readonly path: string };

/** The edit tool's `tool_result.details` payload. */
export interface EditToolResultDetails {
	/** Unified diff of every change this call made, as shown to the model. */
	readonly diff: string;
	/** Every file the call touched or attempted, in producer order. Empty for hashline's no-op result (a section that changed nothing). */
	readonly files: readonly EditToolResultFile[];
}

function editResultOperation(entry: {
	op?: "create" | "delete" | "update";
	sourcePath?: string;
}): Extract<EditToolResultFile, { status: "applied" }>["operation"] {
	return entry.sourcePath !== undefined ? "move" : entry.op;
}

function editResultPerFile(entry: PresentationEditPerFileResult): EditToolResultFile {
	if (entry.isError === true) {
		return { status: "failed", path: entry.path, message: entry.displayErrorText ?? entry.errorText };
	}
	return {
		status: "applied",
		path: entry.path,
		diff: entry.diff,
		operation: editResultOperation(entry),
		sourcePath: entry.sourcePath,
	};
}

/**
 * Project a raw edit tool result's `details` into {@link EditToolResultDetails},
 * or `undefined` when it isn't a real edit bag — a thrown edit (the agent loop's
 * `{}` for a producer that never got far enough to build one), a synthetic
 * lifecycle result, or a validation failure. Those already carry their story
 * on the event's `content`/`isError`; there is no per-file outcome to derive.
 */
export function editToolResultDetails(details: unknown): EditToolResultDetails | undefined {
	const parsed = editBagDetailsSchema.safeParse(details);
	if (!parsed.success) return undefined;
	const bag = parsed.data;
	if ("perFileResults" in bag && bag.perFileResults) {
		const files: EditToolResultFile[] = bag.perFileResults.map(editResultPerFile);
		for (const path of bag.unattemptedPaths ?? []) {
			files.push({ status: "skipped", path });
		}
		return { diff: bag.diff, files };
	}
	if (bag.path === undefined) {
		return { diff: bag.diff, files: [] };
	}
	return {
		diff: bag.diff,
		files: [
			{
				status: "applied",
				path: bag.path,
				diff: bag.diff,
				operation: editResultOperation(bag),
				sourcePath: bag.sourcePath,
			},
		],
	};
}

/** Adds derived compatibility payloads to a `tool_result` event's details without changing the underlying `AgentToolResult`. */
export function normalizeToolEventDetails(toolName: string, details: unknown): unknown {
	return toolName === "edit" ? editToolResultDetails(details) : details;
}
