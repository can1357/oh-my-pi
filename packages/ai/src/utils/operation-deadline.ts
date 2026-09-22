/**
 * Aggregate wall-clock budget for ONE logical provider operation, bounding
 * time WITHOUT progress rather than total duration.
 *
 * pi-ai retries in nested layers — replay-safe stream retries wrap provider
 * transport retries wrap client retries — and every layer sleeps between
 * attempts. Each layer is individually bounded, but their product is not: a
 * single `stream()` call can spend hours in backoff while the caller sees
 * nothing at all. `operationTimeoutMs` bounds that product. `streamSimple`'s
 * request builder and `stream`'s dispatcher each stamp one absolute deadline
 * per operation (first stamp wins, so the bypass branches and the auth-retry
 * re-entry share it), and every retry site asks, before sleeping, whether the
 * sleep still fits. A retry that would land past the deadline is refused
 * immediately instead of taken, so the budget is a ceiling on silence rather
 * than one more wait to sit through.
 *
 * Producing output extends the budget: every provider loop calls
 * {@link markOperationProgress} when an attempt produces output, re-basing
 * the deadline to now + budget. A long productive stream that later hits a
 * transient failure therefore keeps its in-place retry, while a ladder of
 * silent attempts is still cut at the budget.
 *
 * Enforced in: the replay-safe stream retry (`empty-completion-retry`), the
 * Anthropic provider loop and its HTTP client backoff, the OpenAI Responses
 * transient stream retry, the five Codex Responses websocket/provider/
 * whitespace retries, and the Google + Gemini CLI empty-stream retries. A
 * caller abort always wins: every site keeps its existing abort check ahead of
 * the budget check.
 *
 * Deliberately NOT the stream-idle watchdog: that one bounds the gap between
 * events of a live stream and knows nothing about retries, while this one
 * bounds retry wall clock and never interrupts a stream that is producing
 * output.
 */
import { ProviderOperationDeadlineError } from "../error/validation";

/** The two fields a retry site needs to enforce the budget. */
export interface OperationDeadlineOptions {
	/** Budget for the whole operation in milliseconds; omitted or non-positive disables it. */
	operationTimeoutMs?: number;
	/** Absolute deadline stamped from `operationTimeoutMs` at the pi-ai entry point, not by callers. */
	operationDeadlineAt?: number;
}

/**
 * Stamp the absolute deadline once per operation. Re-entry (auth retries,
 * header resolution, glyph codecs, the streamSimple -> stream hop) keeps the
 * first stamp, so the budget covers the operation rather than restarting.
 */
export function withOperationDeadline<T extends OperationDeadlineOptions>(options: T): T {
	const timeoutMs = options.operationTimeoutMs;
	if (timeoutMs === undefined || !(timeoutMs > 0) || options.operationDeadlineAt !== undefined) return options;
	return { ...options, operationDeadlineAt: Date.now() + timeoutMs };
}

/**
 * Re-base the deadline to now + budget when an attempt produces output.
 *
 * Called by every provider loop at the point where it already decides the
 * attempt "produced output" (Anthropic's replay-safety tracking, OpenAI
 * Responses replay-unsafe events, Codex text/thinking/tool deltas, Google
 * first-token delivery, the replay-safe wrapper's commit transition), so the
 * budget bounds time without progress rather than total duration. Mutates the
 * shared options object in place so every nested retry site in the operation
 * sees the extended deadline. No-op when the budget is disabled, unstamped,
 * or the options are absent — in particular it never invents a deadline the
 * entry point did not stamp.
 */
export function markOperationProgress(options: OperationDeadlineOptions | undefined): void {
	if (options?.operationDeadlineAt === undefined) return;
	const timeoutMs = options.operationTimeoutMs;
	if (timeoutMs === undefined || !(timeoutMs > 0)) return;
	options.operationDeadlineAt = Date.now() + timeoutMs;
}

/**
 * The error to raise instead of sleeping `delayMs`, or `undefined` while the
 * retry still fits the budget. Returns rather than throws so callers inside
 * detached async producers can fail their stream instead of leaking a
 * rejection.
 */
export function operationDeadlineExceeded(
	options: OperationDeadlineOptions | undefined,
	delayMs: number,
): ProviderOperationDeadlineError | undefined {
	const deadlineAt = options?.operationDeadlineAt;
	if (deadlineAt === undefined) return undefined;
	const now = Date.now();
	const wait = Math.max(0, delayMs);
	if (now + wait < deadlineAt) return undefined;
	const budgetMs = options?.operationTimeoutMs ?? 0;
	return new ProviderOperationDeadlineError(budgetMs, Math.max(0, now - (deadlineAt - budgetMs)), wait);
}
