/**
 * Tool-call anomaly detection.
 *
 * Detects when a tool call emitted by an assistant turn did not land as a real,
 * executed tool result the model can see. This is the audit layer for the
 * failure mode where the model emits broken tool invocations that get
 * sanitized out of history or return empty results — the model never sees the
 * failure, so it keeps "retrying" the same broken call.
 *
 * Design notes:
 *
 * - Lives in `pi-ai` (pure, provider-agnostic) and mirrors `harmony-leak.ts`:
 *   a detector + an audit-event factory, both exported so the agent loop (and
 *   its tests) can call them without importing the loop.
 * - The "synthetic result" discriminator is owned by the agent package
 *   (`agent-loop.ts`); to avoid an `agent` -> `pi-ai` import cycle we re-declare
 *   the minimal shape here and check the same `__synthetic` / `source` fields.
 * - Audit scope: what the **next provider request actually receives** (model
 *   -facing reality), not local execution. `sanitizeMalformedToolCalls`
 *   (`../providers/transform-messages`) strips calls with empty/whitespace `id`
 *   or `name` from every provider request, so they are the `malformed` class
 *   even though a local (often error) result exists.
 * - The one anomaly class that is fundamentally undetectable (a tool call the
 *   provider's stream parser dropped on the wire, leaving no `toolCall` block
 *   and no `toolResult`) is *not* emittable here; it is documented so the
 *   limitation is explicit rather than a quiet gap.
 *
 * Three anomaly classes, checked per call in this order (model-facing reality
 * first):
 *
 * 1. `malformed` — call stripped from every provider request
 *    (`isMalformedToolCall`, shared with `sanitizeMalformedToolCalls`). Flagged
 *    even when a local result exists — the model never received the pair.
 * 2. `never_run` — no paired result, or a synthetic placeholder (never
 *   executed locally: abort / error / soft-required skip / length).
 * 3. `tool_failed` — real result with no substantive content (empty / error
 *    output; an image block counts as substantive).
 *
 * Returns `undefined` for healthy turns, otherwise one anomaly with the union
 * of kinds and one detail per anomalous call.
 */

import { isMalformedToolCall } from "../providers/transform-messages";
import type { AssistantMessage, StopReason, TextContent, ToolCall, ToolResultMessage } from "../types";
import type { CursorExecResolvedCarrier } from "./block-symbols";
import { isCursorExecResolved } from "./block-symbols";

/** Minimal local view of the agent's `SyntheticToolResultDetails` (see
 * `agent-loop.ts`). Only the fields the detector reads are declared. */
interface SyntheticToolResultDetailsLike {
	__synthetic: true;
	/** Source: one of the loop's placeholder emitters. */
	source:
		| "assistant_stop_aborted"
		| "assistant_stop_error"
		| "assistant_stop_length"
		| "assistant_stop_skipped"
		| "interrupt_skipped";
}

/**
 * `ToolCallAnomalyKind` — the classes reported by
 * {@link detectToolCallAnomaly}.
 *
 * - `tool_failed` — a real (non-synthetic) tool result with no substantive
 *   content: empty/error output. The tool ran but told the model nothing
 *   useful (text-only: an `ImageContent` block counts as substantive).
 * - `never_run` — a call the model emitted that never executed locally: a
 *   synthetic placeholder result (abort / error / soft-required skip / length
 *   truncation) or no paired result at all.
 * - `malformed` — a call stripped from model-facing history by
 *   `sanitizeMalformedToolCalls` (empty/whitespace `id` or `name`); the model
 *   never received the call or its paired result.
 */
export type ToolCallAnomalyKind = "tool_failed" | "never_run" | "malformed";

/**
 * Whether a `ToolResultMessage` carries content the model actually received:
 * a non-whitespace text block or any image block (`ToolResultMessage.content`
 * accepts `ImageContent`, which the model receives). "Legitimate empty
 * successful output" (text-only empty, no images) is the documented
 * `tool_failed` class and must still be flagged.
 */
function hasSubstantiveResultContent(result: ToolResultMessage): boolean {
	for (const block of result.content) {
		if (block.type === "text") {
			if (block.text.trim().length > 0) return true;
		} else if (block.type === "image") {
			// Image content is substantive on its own.
			return true;
		}
	}
	return false;
}

/**
 * Text of the first `TextContent` block only (ignores image content); used
 * for the human-readable `reason` message.
 */
function toolResultText(result: ToolResultMessage): string {
	const first = result.content.find((b): b is TextContent => b.type === "text");
	return first?.text ?? "";
}

/** Human-readable why for a model-facing `malformed` call. */
function malformedReason(call: ToolCall): string {
	const missingId = !call.id || call.id.trim().length === 0;
	const missingName = !call.name || call.name.trim().length === 0;
	if (missingId && missingName) return "sanitized: missing_id_and_name";
	if (missingId) return "sanitized: missing_id";
	return "sanitized: missing_name";
}

/** One anomaly detail for a single tool call in the audited turn. */
export interface ToolCallAnomalyDetail {
	/** Call id from the `ToolCall` block. */
	callId: string;
	/** Tool name from the `ToolCall` block. */
	toolName: string;
	/** Anomaly class for this call. */
	kind: ToolCallAnomalyKind;
	/**
	 * Human-readable why: `empty_text`, `error: <message>`, `no_paired_result`,
	 * a synthetic source (`assistant_stop_aborted`, `assistant_stop_length`,
	 * `assistant_stop_skipped`, `interrupt_skipped`), or
	 * `sanitized: missing_id | missing_name | missing_id_and_name` (model-facing
	 * `malformed`).
	 */
	reason: string;
	/**
	 * Raw turn `stopReason`. Distinct for `never_run` and `malformed`: `length`
	 * truncation (tools not run), abort, or a plain toolUse/stop turn.
	 */
	stopReason?: StopReason;
	/**
	 * True when the turn was truncated (`stopReason === "length"`) and the call
	 * was not run — the signal for "the user's turn got cut off mid-way before
	 * tools could execute."
	 */
	truncated?: boolean;
	/** Optional provider + model id, set by the calling loop if available. */
	model?: { provider: string; id: string };
}

/**
 * Aggregated anomaly for one turn: raw stop reason, unique kinds, and one
 * detail per anomalous call (in emission order).
 */
export interface ToolCallAnomaly {
	/** Raw turn `stopReason`; drives the event-level `truncated` flag. */
	stopReason: StopReason;
	/** All anomaly kinds present in the turn (unique, in first-seen order). */
	kinds: ToolCallAnomalyKind[];
	/** One detail per anomalous tool call (in emission order). */
	details: ToolCallAnomalyDetail[];
}

/**
 * Audit event emitted to `onToolCallAnomaly` subscribers when a tool-call
 * anomaly is detected on a turn. Mirrors `createHarmonyAuditEvent`: a plain,
 * serialisable record of what happened and where.
 */
export interface ToolCallAuditEvent {
	/** The model/provider context that produced the anomalous turn. */
	model?: { provider: string; id: string };
	/** When the turn ended (ms since epoch), or undefined when not supplied. */
	timestamp?: number;
	/** The turn-level stop reason. */
	stopReason: StopReason;
	/** Whether the turn ended on `length` truncation. */
	truncated: boolean;
	/** Distinct anomaly kinds (e.g. `["never_run"]`). */
	kinds: readonly ToolCallAnomalyKind[];
	/** Per-call anomaly details. */
	details: readonly ToolCallAnomalyDetail[];
}

/**
 * Non-fatal detection of failed or orphaned assistant `toolCall` invocations.
 *
 * A healthy turn pairs every emitted, non-Cursor-exec `toolCall` block with a
 * real, substantive `ToolResultMessage`. Turns with no `toolCall` blocks are
 * trivially healthy.
 *
 * @param message The assistant turn being audited.
 * @param toolResults The tool results (real or synthetic placeholders) the
 *   agent loop produced for this turn's runnable calls, in emission order.
 */
export function detectToolCallAnomaly(
	message: AssistantMessage,
	toolResults: readonly ToolResultMessage[],
): ToolCallAnomaly | undefined {
	const truncated = message.stopReason === "length";

	// Filter to non-Cursor-exec tool calls — Cursor-exec blocks are executed
	// server-side and their results arrive out-of-band (not in `toolResults`);
	// they are already handled by the agent loop and must not be audited.
	const toolCallsInMessage = message.content.filter((block): block is ToolCall & CursorExecResolvedCarrier => {
		if (block.type !== "toolCall") return false;
		if (isCursorExecResolved(block)) return false;
		return true;
	});
	if (toolCallsInMessage.length === 0) {
		return undefined;
	}

	// Per-id FIFO queues pair each call occurrence with its matching result
	// occurrence in emission order (same semantics as `sanitizeMalformedToolCalls`
	// dedup), so repeated ids within one turn don't cross-pair onto a single
	// last-wins result.
	const resultQueues = new Map<string, ToolResultMessage[]>();
	for (const result of toolResults) {
		const queue = resultQueues.get(result.toolCallId);
		if (queue === undefined) {
			resultQueues.set(result.toolCallId, [result]);
		} else {
			queue.push(result);
		}
	}

	const anomalyDetails: ToolCallAnomalyDetail[] = [];
	for (const call of toolCallsInMessage) {
		// Malformed check first: model-facing reality dominates local state.
		// A stripped call never reaches the model regardless of any local
		// result.
		if (isMalformedToolCall(call)) {
			anomalyDetails.push({
				callId: call.id,
				toolName: call.name,
				kind: "malformed",
				reason: malformedReason(call),
				stopReason: message.stopReason,
				truncated: truncated || undefined,
			});
			continue;
		}

		const queue = resultQueues.get(call.id);
		const result = queue?.shift();
		const synthetic = (result?.details ?? null) as SyntheticToolResultDetailsLike | null;
		if (result === undefined || synthetic?.__synthetic === true) {
			anomalyDetails.push({
				callId: call.id,
				toolName: call.name,
				kind: "never_run",
				reason: result === undefined ? "no_paired_result" : (synthetic?.source ?? "unknown_synthetic"),
				stopReason: message.stopReason,
				truncated: truncated || undefined,
			});
		} else if (!hasSubstantiveResultContent(result)) {
			const err = toolResultText(result).trim().slice(0, 200);
			anomalyDetails.push({
				callId: call.id,
				toolName: call.name,
				kind: "tool_failed",
				reason: result.isError ? `error: ${err || "(no message)"}` : "empty_text",
				stopReason: message.stopReason,
				truncated: truncated || undefined,
			});
		}
	}

	if (anomalyDetails.length === 0) {
		return undefined;
	}

	const kinds: ToolCallAnomalyKind[] = [];
	for (const d of anomalyDetails) {
		if (!kinds.includes(d.kind)) kinds.push(d.kind);
	}
	return {
		stopReason: message.stopReason,
		kinds,
		details: anomalyDetails,
	};
}

/**
 * Converts a detected anomaly into the event shape consumed by
 * `onToolCallAnomaly`. Optional `model` + `timestamp` are filled in by the
 * calling loop when available.
 */
export function createToolCallAuditEvent(params: {
	anomaly: ToolCallAnomaly;
	model?: { provider: string; id: string };
	timestamp?: number;
}): ToolCallAuditEvent {
	const { anomaly } = params;
	return {
		model: params.model,
		timestamp: params.timestamp,
		stopReason: anomaly.stopReason,
		truncated: anomaly.stopReason === "length",
		kinds: anomaly.kinds,
		details: anomaly.details,
	};
}
