import type { ToolCallPresentation, ToolOutcome, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { nonZeroExitCode, streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { type BashLikeResult, knownResultText } from "../../../presentation/known-tool-result";

/** The built-in aliases that use BashTool's legacy lifecycle result contract. */
export function isLegacyBashToolName(toolName: string): toolName is "bash" | "shell" | "exec" {
	return toolName === "bash" || toolName === "shell" || toolName === "exec";
}

/** Construct the typed start event once; no legacy result shape is read here. */
export function legacyBashStartedEvent(call: ToolCallPresentation): ToolPresentationEvent {
	return { type: "started", call };
}

/**
 * Typed compatibility adapter for built-in bash lifecycle events that never
 * reached BashTool's presentation producer (validation, permission, abort, or
 * pre-execution synthetic paths). Normal bash execution is exclusively on
 * `presentation_events` and never enters this adapter.
 */
export class LegacyBashPresentation {
	readonly #events: ToolPresentationEvent[] = [];
	readonly #stream: ToolPresentationStream;

	constructor(toolCallId: string) {
		this.#stream = new ToolPresentationStream(streamId(toolCallId), event => this.#events.push(event));
	}

	/**
	 * Intentionally a no-op. A legacy `update()` snapshot is the *whole*
	 * accumulated output so far, not a byte-offset delta, and its source
	 * (`TailBuffer`) is a bounded sliding window that silently drops bytes
	 * from the head once it fills. Naively appending each snapshot duplicates
	 * bytes on every extension (`a, ab, abc` → `aababc`); diffing against the
	 * previously published snapshot instead permanently loses whatever the
	 * window already dropped once it rolls over (`abcde, bcdef, cdefg` would
	 * publish only `abcde` and never recover `f`/`g`). Both are the
	 * snapshot-continuity inference the frozen design forbids and schedules
	 * for deletion, not patching — there is no
	 * non-heuristic way to convert a lossy rolling snapshot into a byte-exact
	 * live delta. `settle` is the sole point this adapter publishes terminal
	 * bytes, from the one full-body text it is guaranteed to have; this is the
	 * same settled-body-only degradation phase 1 already applied to legacy
	 * replay, not a new exception.
	 */
	update(_result: BashLikeResult): readonly ToolPresentationEvent[] {
		return [];
	}

	/** Publish the final result's full body once and emit the adapter's one settlement. */
	settle(result: BashLikeResult, resultIsError: boolean): readonly ToolPresentationEvent[] {
		return this.#capture(() => {
			const text = knownResultText(result);
			if (text.length > 0) this.#stream.appendTerminal(text);
			this.#events.push({ type: "settled", outcome: legacyBashOutcome(result, resultIsError) });
		});
	}

	#capture(action: () => void): readonly ToolPresentationEvent[] {
		const start = this.#events.length;
		action();
		return this.#events.slice(start);
	}
}

/** Derive terminal status from the strict result arm, never generic details extraction. */
function legacyBashOutcome(result: BashLikeResult, resultIsError: boolean): ToolOutcome {
	const details = result.details;
	if ("timedOut" in details && details.timedOut === true) {
		return {
			kind: "failed",
			failure: {
				reason: "process",
				message:
					details.timeoutSeconds === undefined
						? "Command timed out"
						: `Command timed out after ${details.timeoutSeconds} seconds`,
			},
			process: { kind: "timed_out", timeoutMs: (details.timeoutSeconds ?? 0) * 1000 },
		};
	}
	if ("exitCode" in details && typeof details.exitCode === "number" && details.exitCode !== 0) {
		return {
			kind: "failed",
			failure: { reason: "process", message: `Command exited with code ${details.exitCode}` },
			process: { kind: "exited", code: nonZeroExitCode(details.exitCode) },
		};
	}
	// The agent loop's own pre-dispatch argument-validation failure (see
	// `validationFailureDetailsSchema`): a real, well-formed outcome distinct
	// from a process failure or a generic tool-reported error.
	if ("error" in details && typeof details.error === "string" && details.isError === true) {
		return { kind: "failed", failure: { reason: "validation", message: details.error } };
	}
	if (resultIsError || result.isError) {
		return { kind: "failed", failure: { reason: "tool_reported", message: "Command failed" } };
	}
	return { kind: "succeeded", process: { kind: "exited", code: 0 } };
}
