/**
 * Every bound on model-facing progress delivery lives here. Producers
 * (ProgressBatcher, ProgressLines, ProgressPreview), the session wake budget,
 * and the tool prompts that describe these limits all read the same block.
 */
export const PROGRESS_LIMITS = {
	/** Collection window for complete events before a batch is delivered. */
	BATCH_INTERVAL_MS: 200,
	/** Per-source token-bucket burst of model-facing progress batches. */
	RATE_LIMIT_BURST: 10,
	/** Per-source refill: one permit regained every this many ms. */
	RATE_LIMIT_REFILL_MS: 2_000,
	/** UTF-8 bytes retained in a model-facing progress preview (head+tail). */
	PREVIEW_BYTES: 3_000,
	/** UTF-16 code units retained per reported progress line. */
	LINE_CHARS: 500,
	/** Suppression-report counts at which the chatty-progress guidance is repeated; never again after the last. */
	CHATTY_REMINDER_SCHEDULE: [5, 15, 30],
	/** Session-wide budget of model turns that wake-mode progress may start. */
	WAKE_TURN_BURST: 5,
	/** One wake-turn permit regained every this many ms. */
	WAKE_TURN_REFILL_MS: 30_000,
} as const;
