/**
 * The discriminated tool outcome.
 *
 * Replaces `isError?: boolean` + `details.isError?: boolean` + "did the process
 * exit nonzero" re-derivations with one authoritative value. Frame status is
 * *computed* from it (see the ACP frame constructors), never passed alongside it.
 *
 * Timeout is a **failed** outcome, settled from `bash.ts#buildCompletedResult`
 * which already returns `isError: true`. The only thing that differs for a
 * timeout is human *severity* — a warning border instead of error red — and
 * severity is a projection attribute derived from the
 * termination kind by {@link presentationSeverity}. There is no third success
 * state.
 */

import type { NonZeroExitCode } from "./brands";

/** A process that exited cleanly. The literal `0` is the only representable code. */
export interface SuccessfulProcessTermination {
	readonly kind: "exited";
	readonly code: 0;
}

/** A process that did not end well. */
export type FailedProcessTermination =
	| { readonly kind: "exited"; readonly code: NonZeroExitCode }
	| { readonly kind: "timed_out"; readonly timeoutMs: number }
	| { readonly kind: "signaled"; readonly signal: string };

/** Any process termination. */
export type ProcessTermination = SuccessfulProcessTermination | FailedProcessTermination;

/** Why a call failed, independent of whether a process was involved. */
export type ToolFailureReason =
	/** A spawned process reported failure (nonzero exit, timeout, signal). */
	| "process"
	/** Argument validation rejected the call before execution. */
	| "validation"
	/** A policy/hook blocked the call before execution. */
	| "blocked"
	/** The user (or a persisted preference) denied permission. */
	| "permission_denied"
	/** The executor threw. */
	| "thrown"
	/** `afterToolCall` threw. */
	| "hook"
	/** The tool returned a non-throwing failure result. */
	| "tool_reported"
	/**
	 * The dispatcher's own scaffolding failed — a telemetry span constructor threw, or
	 * deriving the typed outcome from the result did.
	 *
	 * Its own reason because a presentation failure is not a tool failure: the tool
	 * may well have run. It exists so the lifecycle owner can always emit *some*
	 * typed settlement; a call that announced itself and then produced no `settled`
	 * event leaves its card running forever, since the ACP layer deliberately skips
	 * the legacy `tool_execution_end` for presentation-protocol calls.
	 */
	| "internal";

/** The failure half of a {@link ToolOutcome}. */
export interface ToolFailure {
	readonly reason: ToolFailureReason;
	readonly message: string;
}

/**
 * The authoritative outcome of one tool call.
 *
 * `interrupted` is a user/steering abort: the call neither succeeded nor is it a
 * defect. It maps to a failed ACP status (the card cannot show "running"
 * forever) while remaining distinguishable for the model and for replay.
 */
export type ToolOutcome =
	| { readonly kind: "succeeded"; readonly process?: SuccessfulProcessTermination }
	| { readonly kind: "failed"; readonly failure: ToolFailure; readonly process?: FailedProcessTermination }
	| {
			readonly kind: "interrupted";
			readonly reason: string;
			readonly process?: Extract<FailedProcessTermination, { kind: "signaled" }>;
	  };

/** Rendering severity derived from the outcome — the *only* place timeout softening lives. */
export type PresentationSeverity = "success" | "warning" | "error";

/** Severity for a human-facing surface. A timeout is a failure that renders as a warning. */
export function presentationSeverity(outcome: ToolOutcome): PresentationSeverity {
	switch (outcome.kind) {
		case "succeeded":
			return "success";
		case "interrupted":
			return "warning";
		case "failed":
			return outcome.process?.kind === "timed_out" ? "warning" : "error";
	}
}

/** Whether the outcome is a failure on the wire (`status: "failed"`). */
export function outcomeFailed(outcome: ToolOutcome): boolean {
	return outcome.kind !== "succeeded";
}

/**
 * The exit code to report on a terminal, or `undefined` when the call has no
 * attributable process status.
 *
 * A successful termination reports `0`. A failure without a process termination
 * reports nothing: guessing a number for an unattributed failure is worse than
 * leaving it blank (an aborted call has no exit code anywhere).
 */
export function outcomeExitCode(outcome: ToolOutcome): number | undefined {
	switch (outcome.kind) {
		case "succeeded":
			return outcome.process === undefined ? 0 : outcome.process.code;
		case "failed":
			return outcome.process?.kind === "exited" ? outcome.process.code : undefined;
		case "interrupted":
			return undefined;
	}
}

/** The signal that terminated the process, when one did. */
export function outcomeSignal(outcome: ToolOutcome): string | undefined {
	switch (outcome.kind) {
		case "succeeded":
			return undefined;
		case "failed":
			return outcome.process?.kind === "signaled" ? outcome.process.signal : undefined;
		case "interrupted":
			return outcome.process?.signal;
	}
}
