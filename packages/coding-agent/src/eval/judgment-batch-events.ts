import { isRecord } from "@oh-my-pi/pi-utils";

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

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validate an untyped event-bus payload before rendering it. */
export function isJudgmentBatchProgress(value: unknown): value is JudgmentBatchProgress {
	if (!isRecord(value)) return false;
	const progress = value;
	if (
		typeof progress.id !== "string" ||
		progress.id.length === 0 ||
		typeof progress.intent !== "string" ||
		progress.intent.trim().length === 0 ||
		!isNonNegativeInteger(progress.done) ||
		!isNonNegativeInteger(progress.total) ||
		!isNonNegativeInteger(progress.failed) ||
		typeof progress.cost !== "number" ||
		!Number.isFinite(progress.cost) ||
		progress.cost < 0 ||
		typeof progress.running !== "boolean" ||
		(progress.error !== undefined && typeof progress.error !== "string")
	) {
		return false;
	}
	return progress.done <= progress.total && progress.failed <= progress.done;
}
