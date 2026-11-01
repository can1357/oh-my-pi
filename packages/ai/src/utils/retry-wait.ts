import { scheduler } from "node:timers/promises";
import type { StreamOptions } from "../types";

/** Injected retry sleep: `StreamOptions.providerRetryWait` / `UsageFetchContext.retryWait`. */
export type RetryWaitHook = (delayMs: number, signal?: AbortSignal) => Promise<void>;

/** Default cap on a server-stated retry wait: `StreamOptions.maxRetryDelayMs`. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** The stream options that bound a server-stated wait a provider's own retry sleeps. */
export type StatedWaitPolicy = Pick<StreamOptions, "maxRetryDelayMs" | "providerRetryWaitCeilingMs">;

/** The longest server-stated wait a provider's own retry sleeps, and the option that sets it. */
export interface StatedWaitLimit {
	/** `Infinity` when nothing bounds the wait. */
	limitMs: number;
	option: "maxRetryDelayMs" | "providerRetryWaitCeilingMs";
}

/**
 * The bound on a server-stated wait a provider's own retry (a pre-output loop,
 * or its transport's retry) sleeps; a longer one surfaces the failure. It is
 * the caller's `maxRetryDelayMs` (`defaultMaxRetryDelayMs` when unset; a
 * non-positive cap bounds nothing), or `providerRetryWaitCeilingMs` when the
 * caller set a positive one and it is the smaller.
 */
export function statedRetryWaitLimit(
	policy: StatedWaitPolicy | undefined,
	defaultMaxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
): StatedWaitLimit {
	const cap =
		policy?.maxRetryDelayMs === undefined || Number.isNaN(policy.maxRetryDelayMs)
			? defaultMaxRetryDelayMs
			: policy.maxRetryDelayMs;
	const capMs = cap > 0 ? cap : Number.POSITIVE_INFINITY;
	const ceilingMs = policy?.providerRetryWaitCeilingMs;
	return ceilingMs !== undefined && ceilingMs > 0 && ceilingMs <= capMs
		? { limitMs: ceilingMs, option: "providerRetryWaitCeilingMs" }
		: { limitMs: capMs, option: "maxRetryDelayMs" };
}

/** A server-stated wait a provider's own retry did not sleep, and the bound it exceeded. */
export interface RefusedRetryWait extends StatedWaitLimit {
	waitMs: number;
}

const refusedRetryWaits = new WeakMap<object, RefusedRetryWait>();

/**
 * Records on `failure`, the error about to surface, that its stated wait was
 * refused, so `AIError.finalize` says so in the failed message. The error and
 * its classification are left as they are.
 */
export function markRetryWaitRefused(failure: unknown, refused: RefusedRetryWait): void {
	if (failure !== null && typeof failure === "object") refusedRetryWaits.set(failure, refused);
}

/** The refusal {@link markRetryWaitRefused} recorded on `failure`. */
export function retryWaitRefusal(failure: unknown): RefusedRetryWait | undefined {
	return failure !== null && typeof failure === "object" ? refusedRetryWaits.get(failure) : undefined;
}

const REFUSAL_NOTE_END = "so the provider did not retry)";

/**
 * What a surfaced failure adds to its message when its stated wait was refused:
 * that the server asked for a wait, how long, and which bound refused it (the
 * caller's ceiling, or `maxRetryDelayMs`, which may be the library default).
 * Its wording names no wait a retry hint reader takes, so the failed message's
 * stated wait stays the response's.
 */
export function refusedRetryWaitNote(refused: RefusedRetryWait): string {
	const seconds = (ms: number) => `${Number((ms / 1_000).toFixed(3))} s`;
	const bound =
		refused.option === "providerRetryWaitCeilingMs"
			? `the caller's ${seconds(refused.limitMs)} providerRetryWaitCeilingMs`
			: `the ${seconds(refused.limitMs)} maxRetryDelayMs`;
	return `(server asked to wait ${seconds(refused.waitMs)} before retrying; ${bound} refused it, ${REFUSAL_NOTE_END}`;
}

/** Whether `message` already carries a {@link refusedRetryWaitNote}, from this layer or one below. */
export function hasRefusedRetryWaitNote(message: string): boolean {
	return message.includes(REFUSAL_NOTE_END);
}

/**
 * Waits `delayMs` between retry attempts. Honors the caller's retry-wait hook
 * when one is set (tests and custom transports inject it to avoid real sleeps)
 * and otherwise sleeps on `signal`, so an abort rejects instead of the retry
 * proceeding.
 */
export async function waitForRetry(
	retryWait: RetryWaitHook | undefined,
	delayMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (retryWait) await retryWait(delayMs, signal);
	else await scheduler.wait(delayMs, { signal });
}
