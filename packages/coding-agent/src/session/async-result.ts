import { isRecord } from "@oh-my-pi/pi-utils";
import { isPersistedUsage } from "../task/task-details";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/**
 * Visit the server-reported AI-credit charge (nano-AIU) of each delivered
 * background job that carries one. Only credits roll up into session totals:
 * background-job tokens and dollars were never part of them.
 */
export function forEachAsyncResultAiu(details: unknown, visit: (nano: number) => void): void {
	if (!isRecord(details) || !Array.isArray(details.jobs)) return;
	for (const job of details.jobs) {
		if (isRecord(job) && isPersistedUsage(job.usage) && job.usage.aiu) visit(job.usage.aiu.nano);
	}
}

/**
 * Details of a `wait`/`cancel` snapshot (the `op` marker `buildJobResult` stamps) whose rows
 * can carry the child usage of a job that snapshot took over from its async push.
 */
export function jobControlJobs(details: unknown): unknown[] | undefined {
	if (!isRecord(details) || (details.op !== "wait" && details.op !== "cancel")) return undefined;
	return Array.isArray(details.jobs) ? details.jobs : undefined;
}

/** {@link forEachAsyncResultAiu} for the jobs a `wait`/`cancel` snapshot consumed. */
export function forEachJobControlAiu(details: unknown, visit: (nano: number) => void): void {
	if (jobControlJobs(details)) forEachAsyncResultAiu(details, visit);
}
