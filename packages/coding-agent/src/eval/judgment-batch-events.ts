import { type } from "@oh-my-pi/omptype";

/** Session event channel for editor-anchored judgment progress. */
export const JUDGMENT_BATCH_PROGRESS_EVENT_CHANNEL = "eval:judgment-batch-progress";

/** Live progress snapshot for one host-owned judgment batch. */
export interface JudgmentBatchProgress {
	/** Stable batch/job identifier. */
	id: string;
	/** Caller-provided description of the judgment work. */
	intent: string;
	/** Settled item count, including failures. */
	done: number;
	/** Total item count. */
	total: number;
	/** Settled items that failed. */
	failed: number;
	/** Accumulated USD cost of every judgment attempt so far, including retries and failures. */
	cost: number;
	/** Whether the host is still processing the batch. */
	running: boolean;
	/** Whole-batch terminal error, when present. */
	error?: string;
}

const JudgmentBatchProgressShape = type({
	id: "string > 0",
	intent: type("string").narrow(intent => intent.trim().length > 0),
	done: "number.integer >= 0",
	total: "number.integer >= 0",
	failed: "number.integer >= 0",
	cost: "number >= 0",
	running: "boolean",
	"error?": "string | undefined",
}).narrow(progress => progress.done <= progress.total && progress.failed <= progress.done);

/** Validate an untyped event-bus payload before rendering it. */
export function isJudgmentBatchProgress(value: unknown): value is JudgmentBatchProgress {
	return JudgmentBatchProgressShape.allows(value);
}
