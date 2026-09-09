/**
 * Compaction error types.
 *
 * `CompactionCancelledError` is the canonical signal raised when a compaction
 * is explicitly aborted — operator Esc, extension hook returning `cancel`,
 * programmatic `session.abortCompaction()` call, or any other deliberate
 * abort source. Downstream callers (e.g. `executeCompaction`) discriminate
 * cancellation from other failures via `instanceof CompactionCancelledError`
 * rather than introspecting error messages or `name` fields — the typed
 * sentinel makes classification source-agnostic and refactor-stable.
 */

export class CompactionCancelledError extends Error {
	override readonly name = "CompactionCancelledError" as const;

	constructor(message = "Compaction cancelled", options?: ErrorOptions) {
		super(message, options);
	}
}

/**
 * A provider-native compaction request failed after every native protocol
 * available for the selected model was exhausted.
 *
 * The cause stays attached so AI error classification can still recognize
 * authentication failures. Non-auth failures remain distinguishable from
 * ordinary summarization errors and must not fall through to another provider.
 */
export class NativeCompactionError extends Error {
	override readonly name = "NativeCompactionError" as const;

	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

/**
 * Outcome of a compaction attempt, surfaced by `CommandController.executeCompaction`
 * so callers (e.g. the plan-mode approval flow) can distinguish a deliberate abort
 * from an unrelated failure.
 *
 *   "ok"        — compaction completed; transcript was summarized.
 *   "cancelled" — `CompactionCancelledError` was raised. Operator Esc, extension
 *                 hook, programmatic abort — all source-agnostic.
 *   "failed"    — any other rejection from `session.compact()`.
 */
export type CompactionOutcome = "ok" | "cancelled" | "failed";
