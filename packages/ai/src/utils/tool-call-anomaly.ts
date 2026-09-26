/**
 * Tool-call anomaly detection.
 *
 * Detects when a tool call emitted by an assistant turn did not land as a real,
 * executed tool result. This is the audit layer for the failure mode where the
 * model emits malformed/invalid tool invocations that get silently dropped or
 * return empty results — the model never sees the failure, so it keeps
 * "retrying" the same broken call.
 *
 * Design notes:
 *
 * - Lives in `pi-ai` (pure, model/provider-agnostic) and mirrors
 *   `harmony-leak.ts`: a detector + an audit-event factory, both exported so
 *   the agent loop (and its tests) can call them without importing the loop.
 * - The "synthetic result" discriminator is owned by the agent package
 *   (`agent-loop.ts`); to avoid an `agent` -> `pi-ai` import cycle we re-declare
 *   the minimal shape here and check the same `__synthetic` / `source` fields.
 * - The one anomaly class that is fundamentally undetectable (a tool call that
 *   the provider's stream parser dropped on the wire, leaving no `toolCall` block
 *   and no `toolResult`) is *not* emittable here. It is documented in the module
 *   so the limitation is explicit rather than a quiet gap.
 */
import type { AssistantMessage, StopReason, ToolCall, ToolResultMessage } from "../types";
import type { CursorExecResolvedCarrier } from "./block-symbols";
import { kCursorExecResolved } from "./block-symbols";

/** Minimal local view of the agent's `SyntheticToolResultDetails` (see
 * `agent-loop.ts`). Only the fields the detector reads are declared. */
interface SyntheticToolResultDetailsLike {
	__synthetic?: unknown;
	source?:
		| "assistant_stop_aborted"
		| "assistant_stop_error"
		| "assistant_stop_skipped"
		| "assistant_stop_length"
		| "interrupt_skipped";
}

/** Text content of a tool result (ignores image content). */
function toolResultText(result: ToolResultMessage): string {
	let out = "";
	for (const block of result.content ?? []) {
		if (block.type === "text") {
			out += (block as { text?: string }).text ?? "";
		}
	}
	return out;
}

/**
 * The per-turn anomaly summary. `kinds` lists every distinct anomaly observed
 * across the turn's tool calls (e.g. `["tool_failed"]`, `["never_run", "truncated"]`
 * for a truncated turn whose single call was also left unexecuted).
 */
export type ToolCallAnomalyKind =
	| "tool_failed" // a real tool result with no substantive content (empty/error output)
	| "never_run"; // a synthetic result (call emitted but never invoked locally)

export interface ToolCallAnomalyDetail {
	callId: string;
	toolName: string;
	kind: ToolCallAnomalyKind;
	/**
	 * Short machine-readable context for the audit/log:
	 * - `tool_failed`: `"empty_text"` (no output) or `"error: …"` (isError, with a
	 *   short error message)
	 * - `never_run`: the synthetic `source` (e.g. `assistant_stop_length`) or
	 *   `"missing"` when no paired result existed.
	 */
	reason: string;
	/** For `never_run` from a synthetic source, the human-readable stop/skip reason. */
	stopReason?: StopReason;
}

export interface ToolCallAnomaly {
	/** Turn-level: the assistant message's stop reason (for the `truncated` classification). */
	stopReason: StopReason;
	/** All anomalies found on this turn, in tool-call order. */
	details: ToolCallAnomalyDetail[];
	/** Distinct kinds present (for concise `kinds` in the audit event). */
	kinds: readonly ToolCallAnomalyKind[];
}

/**
 * Extract every `toolCall` block in `message.content`, excluding Cursor-exec
 * calls (those already executed server-side via the bridge — the agent loop
 * never re-runs them, so they are not part of the local result pairing and must
 * not be audited).
 */
function toolCallsInMessage(message: AssistantMessage): readonly ToolCall[] {
	const out: ToolCall[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall" && (block as CursorExecResolvedCarrier)[kCursorExecResolved] !== true) {
			out.push(block);
		}
	}
	return out;
}

/**
 * Human-readable label for a synthetic result's `source`, for the audit/log.
 */
function syntheticSourceLabel(source: SyntheticToolResultDetailsLike["source"] | undefined): string {
	switch (source) {
		case "assistant_stop_aborted":
			return "assistant turn aborted";
		case "assistant_stop_error":
			return "assistant turn error";
		case "assistant_stop_skipped":
			return "tool call intentionally skipped";
		case "assistant_stop_length":
			return "truncated (max output tokens)";
		case "interrupt_skipped":
			return "skipped during steer/interrupt";
		default:
			return "no paired result";
	}
}

/**
 * Detect tool-call anomalies for the given assistant turn.
 *
 * `toolResults` is the array of result messages the loop attached for this turn
 * (one entry per emitted tool call, paired by `toolCallId`). A result may be a
 * *real* tool output or a *synthetic* placeholder (`__synthetic: true`).
 *
 * Returns `undefined` when no anomaly (the common healthy case), or a
 * {@link ToolCallAnomaly} summarising the turn's anomalies.
 *
 * A `truncated` classification is implied when `message.stopReason === "length"`
 * *and* at least one tool call was not run (or ran empty) — a length-stopped
 * turn is precisely the "truncated" user-visible case. The caller decides how to
 * label/emit that; this module keeps the kind set to the two observable classes.
 */
export function detectToolCallAnomaly(
	message: AssistantMessage,
	toolResults: readonly ToolResultMessage[],
): ToolCallAnomaly | undefined {
	const details = new Map<string, ToolResultMessage>();
	for (const r of toolResults) {
		// Pair by call id; last one wins on the (should-not-happen) duplicate.
		details.set(r.toolCallId, r);
	}

	const anomalies: ToolCallAnomalyDetail[] = [];
	for (const call of toolCallsInMessage(message)) {
		const result = details.get(call.id);
		let kind: ToolCallAnomalyKind;
		let reason: string;
		let stopReason: StopReason | undefined;

		if (!result) {
			// Call emitted, no paired result at all. The loop always pairs a result
			// (real or synthetic) per call, so this is a genuinely-orphaned call —
			// classify as never_run with an explicit marker.
			kind = "never_run";
			reason = "no_paired_result";
		} else if ((result.details as SyntheticToolResultDetailsLike | undefined)?.__synthetic === true) {
			kind = "never_run";
			const src = (result.details as SyntheticToolResultDetailsLike | undefined)?.source;
			reason = syntheticSourceLabel(src);
			if (src === "assistant_stop_length") {
				stopReason = message.stopReason;
			}
		} else if (toolResultText(result).trim().length === 0) {
			kind = "tool_failed";
			if (result.isError) {
				const err = toolResultText(result).trim().slice(0, 200);
				reason = err ? `error: ${err}` : "error: (no message)";
			} else {
				reason = "empty_text";
			}
		} else {
			// Executed and returned substantive output — healthy, no anomaly.
			continue;
		}

		anomalies.push({
			callId: call.id,
			toolName: call.name,
			kind,
			reason,
			...(stopReason ? { stopReason } : {}),
		});
	}

	if (anomalies.length === 0) {
		return undefined;
	}

	return {
		stopReason: message.stopReason,
		details: anomalies,
		kinds: [...new Set(anomalies.map(a => a.kind))],
	};
}

/**
 * Audit event emitted to `onToolCallAnomaly` subscribers when a tool-call
 * anomaly is detected on a turn. Mirrors `createHarmonyAuditEvent`:
 * a plain, serialisable record of what happened and where.
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

export function createToolCallAuditEvent(params: {
	anomaly: ToolCallAnomaly;
	model?: { provider: string; id: string };
	timestamp?: number;
}): ToolCallAuditEvent {
	const truncated = params.anomaly.stopReason === "length";
	return {
		model: params.model,
		timestamp: params.timestamp,
		stopReason: params.anomaly.stopReason,
		truncated,
		kinds: params.anomaly.kinds,
		details: params.anomaly.details,
	};
}
