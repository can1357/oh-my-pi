/**
 * Shared foreground-wait helpers for tools that auto-background long-running
 * work as {@link AsyncJobManager} jobs (bash commands, eval cells): the
 * LLM-facing background notice, the threshold-vs-timeout wait budget, and the
 * settlement race against abort/steering signals.
 */

/** Default foreground-wait threshold before a tool call auto-backgrounds. */
export const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;
/** LLM-facing footer appended when a tool call is converted into a background job. */
export function formatBackgroundNotice(jobId: string): string {
	return `Backgrounded as job ${jobId}; result will be delivered automatically.`;
}

/**
 * How long a tool foreground-waits before backgrounding. Bounded by the call's
 * own timeout minus a small buffer so a deadline expiry resolves inline instead
 * of backgrounding moments before it fires. `0` means background immediately.
 */
export function resolveAutoBackgroundWaitMs(thresholdMs: number, timeoutMs: number | undefined): number {
	if (thresholdMs <= 0) return 0;
	if (timeoutMs === undefined) return thresholdMs;
	const timeoutBufferMs = 1_000;
	return Math.max(0, Math.min(thresholdMs, timeoutMs - timeoutBufferMs));
}

/** Non-settled outcomes of {@link raceJobSettlement}. */
export type JobWaitInterrupt = { kind: "running" } | { kind: "steer" } | { kind: "aborted" };

/**
 * Race a managed job's settlement against the auto-background threshold, the
 * caller's abort signal, and the turn's steering signal. Returns the job's own
 * completion when it settles first; otherwise reports why the wait ended:
 * "running" = threshold elapsed (background it), "steer" = a queued message
 * arrived mid-wait, "aborted" = the caller cancelled.
 */
export async function raceJobSettlement<C>(
	completion: Promise<C>,
	thresholdMs: number,
	signal?: AbortSignal,
	steeringSignal?: AbortSignal,
): Promise<C | JobWaitInterrupt> {
	if (signal?.aborted) {
		return { kind: "aborted" };
	}
	if (steeringSignal?.aborted) {
		return { kind: "steer" };
	}

	// Cancellable threshold: a bare Bun.sleep(thresholdMs) leaves a live, ref'd
	// timer for the full threshold after the job finishes (or abort/steer) wins
	// the race first — delaying SDK/headless shutdown and accumulating timers
	// under fast completion rates. Settle a withResolvers promise from
	// setTimeout so the finally can clear it regardless of which waiter wins.
	const { promise: thresholdPromise, resolve: resolveThreshold } = Promise.withResolvers<{ kind: "running" }>();
	const thresholdTimer = setTimeout(() => resolveThreshold({ kind: "running" }), thresholdMs);
	const waiters: Array<Promise<C | JobWaitInterrupt>> = [completion, thresholdPromise];

	const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<{ kind: "aborted" }>();
	const onAbort = () => resolveAborted({ kind: "aborted" });
	const { promise: steerPromise, resolve: resolveSteer } = Promise.withResolvers<{ kind: "steer" }>();
	const onSteer = () => resolveSteer({ kind: "steer" });
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
		waiters.push(abortedPromise);
	}
	if (steeringSignal) {
		steeringSignal.addEventListener("abort", onSteer, { once: true });
		waiters.push(steerPromise);
	}
	try {
		return await Promise.race(waiters);
	} finally {
		clearTimeout(thresholdTimer);
		signal?.removeEventListener("abort", onAbort);
		steeringSignal?.removeEventListener("abort", onSteer);
	}
}
