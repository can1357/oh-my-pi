/**
 * What the loop does after one assistant turn: run the calls, pair them with
 * placeholder results, or end the run — plus the rules that decide whether the
 * inner loop takes another turn.
 *
 * This used to be an inline ladder in `runLoopBody` that wrote
 * `hasMoreToolCalls` from six sites and re-derived the placeholder
 * reason/telemetry-status mapping three times. It is now two pure functions
 * over plain inputs, split along the phase boundary the loop actually has:
 *
 * 1. {@link decideTurn} — before the turn's effects: which calls run, which are
 *    paired with placeholders, whether the run ends here.
 * 2. {@link settleTurn} — after the effects: whether to re-engage. It has to be
 *    a second phase because a tool hook can abort the run from inside
 *    `executeToolCalls`, which only the post-effect read can see.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/** A tool-call block of an assistant message. Cursor exec-resolved blocks are filtered out before this point. */
export type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Why a tool call is not executed. Every cause pins both halves that used to be
 * derived separately at each call site: the reason persisted on the synthetic
 * result and the status reported to the run collector.
 */
export type PlaceholderCause = "aborted" | "error" | "length" | "deadline" | "skipped";

/** Synthetic-result reason accepted by `createAbortedToolResult`. */
export type SyntheticReason = "aborted" | "error" | "length" | "skipped";

/** Status reported to the run collector for a call that never executed. */
export type SkippedToolStatus = "aborted" | "error" | "skipped";

export interface PlaceholderSpec {
	readonly reason: SyntheticReason;
	readonly status: SkippedToolStatus;
	/** Default text when neither the plan nor a per-call label supplies one. */
	readonly errorMessage?: string;
}

/** Cause → persisted result + telemetry status. The single source for both. */
export const PLACEHOLDER_SPEC: Record<PlaceholderCause, PlaceholderSpec> = {
	// A user interrupt and a provider error both keep the verbatim reason; the
	// text comes from the message or from a tool-scoped abort label.
	aborted: { reason: "aborted", status: "aborted" },
	error: { reason: "error", status: "error" },
	// `max_tokens` truncation: the call may carry incomplete arguments, so it is
	// persisted as a length-truncated result and reported as skipped.
	length: { reason: "length", status: "skipped" },
	deadline: { reason: "aborted", status: "aborted", errorMessage: "Deadline exceeded" },
	skipped: { reason: "skipped", status: "skipped" },
};

/** Tool calls to pair with placeholder results instead of executing. */
export interface PlaceholderPlan {
	readonly calls: readonly ToolCallBlock[];
	readonly cause: PlaceholderCause;
	/** Plan-level text; a per-call label wins over it. */
	readonly errorMessage?: string;
}

/** A pending soft tool requirement, as the loop sees it on this turn. */
export interface SoftRequirementGate {
	readonly tool: string;
	/** Whether a call satisfies the requirement (host predicate, else name match). */
	readonly satisfied: (call: ToolCallBlock) => boolean;
	/** Whether the requirement still gates this turn (a hard `toolChoice` disables it). */
	readonly active: boolean;
	readonly escalations: number;
}

/** Whether the branch wants another turn, before the post-effect rules run. */
export type Reengage = "always" | "never";

export type TurnDecision =
	/** The turn ended the run (`error`/`aborted`): pair the calls, then stop. */
	| { readonly kind: "end"; readonly placeholders: PlaceholderPlan }
	/** Run the calls, then re-engage. */
	| { readonly kind: "execute"; readonly calls: readonly ToolCallBlock[]; readonly reengage: Reengage }
	/** Nothing runs; pair leftovers when there are any. */
	| {
			readonly kind: "hold";
			readonly placeholders: PlaceholderPlan | null;
			readonly reengage: Reengage;
			/** Soft-requirement escalation: force this tool on the next turn. */
			readonly escalate: { readonly tool: string; readonly escalations: number } | null;
	  }
	/** The pending requirement exhausted its forced turns: the caller must abort the run. */
	| {
			readonly kind: "limit-exhausted";
			readonly limit: "soft-tool-escalation";
			readonly tool: string;
			readonly max: number;
	  };

export interface TurnInput {
	/** Only the two fields the decision reads. */
	readonly message: Pick<AssistantMessage, "stopReason" | "errorMessage">;
	readonly toolCalls: readonly ToolCallBlock[];
	readonly deadlinePassed: boolean;
	readonly softRequirement: SoftRequirementGate | null;
	readonly maxSoftEscalations: number;
}

/**
 * Decide the fate of one assistant turn, before its effects run. Pure: no
 * stream, no telemetry, no mutation — every effect stays with the caller.
 *
 * Precedence, in order: end-of-run → unmet soft requirement → execute → pair
 * leftovers.
 */
export function decideTurn(input: TurnInput): TurnDecision {
	const stopReason = input.message.stopReason;

	// Nothing may execute after an error/abort turn; the calls still need results
	// so the provider keeps its tool_use/tool_result pairing.
	if (stopReason === "error" || stopReason === "aborted") {
		return {
			kind: "end",
			placeholders: { calls: input.toolCalls, cause: stopReason, errorMessage: input.message.errorMessage },
		};
	}

	// `stop_reason` never goes back on the wire, so a turn carrying tool calls is
	// replayable whether it ended on `tool_use` or `stop` (end_turn, pause_turn).
	// `length` is the one reason we must not run: the trailing call may be
	// truncated, so it is paired with a placeholder below instead.
	const runnable = (stopReason === "toolUse" || stopReason === "stop") && input.toolCalls.length > 0;
	const canRun = runnable && !input.deadlinePassed;

	// A turn is compliant only when it calls the required tool and nothing else,
	// mirroring a forced-tool_choice turn. A required+detour batch counts as
	// non-compliant so detour side effects never run while the requirement pends.
	const requirement = input.softRequirement;
	const unmet =
		requirement?.active === true && !(input.toolCalls.length > 0 && input.toolCalls.every(requirement.satisfied));

	if (unmet && requirement) {
		if (requirement.escalations >= input.maxSoftEscalations) {
			return {
				kind: "limit-exhausted",
				limit: "soft-tool-escalation",
				tool: requirement.tool,
				max: input.maxSoftEscalations,
			};
		}
		return {
			kind: "hold",
			placeholders: {
				calls: input.toolCalls,
				cause: "skipped",
				errorMessage:
					`Not executed: call the \`${requirement.tool}\` tool to resolve the pending action ` +
					"before using other tools.",
			},
			// Re-engage so the loop never yields while the requirement is unmet.
			reengage: "always",
			escalate: { tool: requirement.tool, escalations: requirement.escalations + 1 },
		};
	}

	if (canRun) {
		return { kind: "execute", calls: input.toolCalls, reengage: "always" };
	}

	if (input.toolCalls.length > 0) {
		// Leftover calls from a turn that cannot run them: a `length` truncation, an
		// expired deadline, or any other non-runnable stop.
		const cause: PlaceholderCause = input.deadlinePassed
			? "deadline"
			: stopReason === "length"
				? "length"
				: "skipped";
		// A truncated turn is re-driven so the model can chunk its remaining work.
		return {
			kind: "hold",
			placeholders: { calls: input.toolCalls, cause },
			reengage: stopReason === "length" && !input.deadlinePassed ? "always" : "never",
			escalate: null,
		};
	}

	return { kind: "hold", placeholders: null, reengage: "never", escalate: null };
}

/** What {@link settleTurn} needs from the loop after the turn's effects ran. */
export interface SettleInput {
	readonly reengage: Reengage;
	/** `signal.reason === TERMINAL_TOOL_RESULT_ABORT_REASON` — read *after* tool execution. */
	readonly terminalAbort: boolean;
	readonly toolCalls: number;
	readonly stopReason: AssistantMessage["stopReason"];
	/** `stopDetails.type === "pause_turn"`. */
	readonly pauseTurn: boolean;
	readonly pausedContinuations: number;
	readonly maxPausedContinuations: number;
}

/** Whether the inner loop takes another turn, and the pause budget it leaves behind. */
export interface TurnContinuation {
	readonly continueLoop: boolean;
	readonly pausedContinuations: number;
}

/**
 * Settle the continuation after the turn's effects. A terminal tool-result abort
 * ends the loop even though the batch was persisted; a non-terminal `pause_turn`
 * stop re-samples with the assistant message replayed. A turn that carried tool
 * calls resets the pause budget, since the tool call *is* the progress.
 */
export function settleTurn(input: SettleInput): TurnContinuation {
	const continueLoop = input.reengage === "always" && !input.terminalAbort;
	if (input.toolCalls > 0) {
		return { continueLoop, pausedContinuations: 0 };
	}
	if (
		continueLoop ||
		input.stopReason !== "stop" ||
		!input.pauseTurn ||
		input.pausedContinuations >= input.maxPausedContinuations
	) {
		return { continueLoop, pausedContinuations: input.pausedContinuations };
	}
	return { continueLoop: true, pausedContinuations: input.pausedContinuations + 1 };
}
