import { isRecord } from "@oh-my-pi/pi-utils";
import { isPersistedUsage } from "../task/task-details";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/** Visit the server-reported AI-credit charge (nano-AIU) of each row that carries persisted usage, nested `consumedJobs` rows included. */
function forEachRowAiu(rows: unknown, visit: (nano: number) => void): void {
	if (!Array.isArray(rows)) return;
	for (const row of rows) {
		if (!isRecord(row)) continue;
		if (isPersistedUsage(row.usage) && row.usage.aiu) visit(row.usage.aiu.nano);
		forEachRowAiu(row.consumedJobs, visit);
	}
}

/**
 * Visit the server-reported AI-credit charge (nano-AIU) of each delivered
 * background job that carries one. Only credits roll up into session totals:
 * background-job tokens and dollars were never part of them.
 */
export function forEachAsyncResultAiu(details: unknown, visit: (nano: number) => void): void {
	if (isRecord(details)) forEachRowAiu(details.jobs, visit);
}

/**
 * Rows of a tool result that took background jobs over from their async push, each able to carry
 * the child usage of its job: a `wait`/`cancel` snapshot (the `op` marker `buildJobResult` stamps,
 * rows in `jobs`) or an eval call (rows in `consumedJobs`, from `wait()` on its agent handles).
 */
export function jobControlJobs(details: unknown): unknown[] | undefined {
	if (!isRecord(details)) return undefined;
	const rows = details.op === "wait" || details.op === "cancel" ? details.jobs : details.consumedJobs;
	return Array.isArray(rows) ? rows : undefined;
}

/** {@link forEachAsyncResultAiu} for the jobs a tool result consumed ({@link jobControlJobs}). */
export function forEachJobControlAiu(details: unknown, visit: (nano: number) => void): void {
	forEachRowAiu(jobControlJobs(details), visit);
}
