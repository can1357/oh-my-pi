import { extractRetryHint } from "@oh-my-pi/pi-utils";
import * as AIError from "./error";
import type { AssistantMessage } from "./types";
import { getHeadersFromError, getRetryAfterMsFromHeaders, type HeadersLike } from "./utils/retry-after";

/**
 * Transient-failure retry for **oneshot** (non-agent-loop) completions.
 *
 * Why this exists: `streamSimple`/`completeSimple` retry *auth* failures
 * (credential rotation) but deliberately surface *transient* provider failures
 * — Anthropic `overloaded_error`, `rate_limit_error`, HTTP 429/500/502/503/529
 * — as a **resolved** `AssistantMessage` with `stopReason: "error"`. For the
 * main agent turn that is correct: `TurnRecovery` owns recovery there, and it
 * must refuse to replay once tool calls or visible text have streamed.
 *
 * Oneshots have no such hazard. A summary, title, handoff, or image
 * description produces no side effects, so re-issuing the whole request is
 * safe and is almost always what the caller wants. Before this helper every
 * oneshot call site had to re-implement that decision, and most did not —
 * failing on the first blip, or swallowing it into `null` so a transient
 * overload was indistinguishable from a legitimate empty result.
 *
 * Classification reuses the existing provider predicates (`AIError`), so the
 * set of retryable Anthropic failures stays defined in exactly one place.
 * Usage limits are included: unlike the provider loop — which excludes them so
 * credential rotation can own them — a oneshot has no rotation layer above it,
 * and the retry hint the provider supplies (`retry-after`, "try again in ~5m")
 * is honored, so waiting is the correct response.
 */
export interface OneshotRetryOptions {
	/** Total attempts, including the first. Default 3. Values < 1 are treated as 1. */
	maxAttempts?: number;
	/** First backoff step in ms; doubles per attempt. Default 500. */
	baseDelayMs?: number;
	/**
	 * Upper bound for a single wait. Default 30_000. A provider retry hint
	 * longer than this aborts the retry instead of parking the caller — the
	 * error surfaces so higher-level recovery (or the user) can decide.
	 */
	maxDelayMs?: number;
	/**
	 * Stops further attempts. Two distinct paths, both preserving the caller's
	 * intent: an abort already visible when an attempt settles surfaces that
	 * attempt's own result (`completeSimple` reports `stopReason: "aborted"`),
	 * while an abort that lands during the backoff wait rejects with the abort
	 * reason — a user cancel stays a cancel and is never relabelled as the
	 * provider failure we happened to be waiting on.
	 *
	 * This helper does NOT pass the signal into `run` — cancelling the in-flight
	 * request is the closure's job, because a per-attempt deadline must be
	 * rebuilt on every attempt. Construct it inside `run`
	 * (`signal: AbortSignal.timeout(MS)`, or `AbortSignal.any([outer, perAttempt])`);
	 * a deadline captured outside would fire once and then abort every retry,
	 * silently turning this helper into a single attempt.
	 */
	signal?: AbortSignal;
	/**
	 * Headers of the attempt that just failed, used to honor `retry-after`.
	 *
	 * Load-bearing: a transient Anthropic failure arrives as a **resolved**
	 * `AssistantMessage`, and `AssistantMessage` carries no headers — so without
	 * this the real `retry-after` / `x-ratelimit-reset` values on a 429/529 are
	 * invisible and only the (usually hint-free) error text is available.
	 * Callers that already capture headers via `SimpleStreamOptions.onResponse`
	 * should return the latest capture here; it is read once per failed attempt.
	 * Thrown errors need no wiring — headers are recovered from the error itself.
	 */
	getResponseHeaders?: () => HeadersLike;
	/** Observability hook. Fires immediately before sleeping. */
	onRetry?: (info: OneshotRetryInfo) => void;
}

export interface OneshotRetryInfo {
	/** 1-based index of the attempt that just failed. */
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	/** True when `delayMs` came from a provider retry hint rather than backoff. */
	fromRetryHint: boolean;
	errorMessage: string;
	/** `AIError` classification bits of the failure. */
	errorId: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** Cap on pure backoff growth. A provider hint may still exceed this, up to `maxDelayMs`. */
const BACKOFF_CEILING_MS = 8_000;
const RETRY_AFTER_MS_SUFFIX = /(?:^|\s)retry-after-ms=([0-9]+(?:\.[0-9]+)?)(?=\s|$)/i;

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
	const growth = Math.min(baseDelayMs * 2 ** (attempt - 1), BACKOFF_CEILING_MS);
	// 75-100% jitter, matching the provider loop and TurnRecovery, so a fleet of
	// concurrent oneshots does not re-converge on the same instant.
	return Math.round(growth * (0.75 + Math.random() * 0.25));
}

/** Retryable when the provider says transient, or when it says "wait, then retry". */
function isRetryableOneshotFailure(errorId: number, errorStatus: number | undefined, errorMessage: string): boolean {
	// llama.cpp reports deterministic tool-call JSON parse failures as HTTP 500.
	// Replaying the same prompt produces the same malformed output.
	if (AIError.LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(errorMessage)) return false;
	if (AIError.is(errorId, AIError.Flag.ContentBlocked)) return false;
	// A oneshot replays a FIXED prompt, so an input the model cannot fit fails
	// identically on every attempt. Retrying burns the caller's deadline instead
	// of reaching the fallback that can actually shrink the input.
	if (AIError.is(errorId, AIError.Flag.ContextOverflow)) return false;
	if (AIError.is(errorId, AIError.Flag.PayloadRejected)) return false;
	return (
		AIError.isTransientStatus(errorStatus) ||
		AIError.is(errorId, AIError.Flag.Transient) ||
		AIError.is(errorId, AIError.Flag.UsageLimit) ||
		AIError.retriable(errorId)
	);
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, delayMs);
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal?.reason ?? new AIError.AbortError("oneshot retry aborted"));
	};
	if (signal) {
		if (signal.aborted) {
			clearTimeout(timer);
			return Promise.reject(signal.reason ?? new AIError.AbortError("oneshot retry aborted"));
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}
	return promise;
}

/**
 * Run a oneshot completion, retrying transient provider failures.
 *
 * Handles both failure shapes: a resolved `AssistantMessage` carrying
 * `stopReason: "error"` (what `completeSimple` produces) and a thrown error
 * (what the raw HTTP helpers produce). A non-retryable failure is returned or
 * rethrown unchanged, so existing caller error handling keeps working — this
 * only removes the *first-blip* failure mode.
 */
export async function retryTransientCompletion(
	run: (attempt: number) => Promise<AssistantMessage>,
	options?: OneshotRetryOptions,
): Promise<AssistantMessage> {
	const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const signal = options?.signal;

	for (let attempt = 1; ; attempt++) {
		let message: AssistantMessage | undefined;
		let thrown: unknown;
		try {
			message = await run(attempt);
			if (message.stopReason !== "error") return message;
		} catch (error) {
			thrown = error;
		}
		// A caller abort is never a transient failure — surface it immediately so
		// cancellation stays responsive.
		if (signal?.aborted) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}

		const errorId =
			thrown !== undefined ? AIError.classify(thrown) : AIError.classifyMessage(message as AssistantMessage);
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}
		const errorMessage =
			thrown !== undefined
				? thrown instanceof Error
					? thrown.message
					: String(thrown)
				: ((message as AssistantMessage).errorMessage ?? "unknown error");
		const errorStatus = thrown !== undefined ? AIError.status(thrown) : (message as AssistantMessage).errorStatus;
		const lastAttempt = attempt >= maxAttempts;
		if (lastAttempt || !isRetryableOneshotFailure(errorId, errorStatus, errorMessage)) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}

		// Headers first: a real Anthropic 429/529 carries `retry-after` /
		// `x-ratelimit-reset*` in the response, and the resolved AssistantMessage
		// has none — the caller supplies them via `getResponseHeaders`. Thrown
		// errors (e.g. AnthropicApiError) carry their own headers.
		const headers: HeadersLike = thrown !== undefined ? getHeadersFromError(thrown) : options?.getResponseHeaders?.();
		const headerHintMs = getRetryAfterMsFromHeaders(headers);
		const extractedTextHintMs = extractRetryHint(undefined, errorMessage);
		const suffixValue = RETRY_AFTER_MS_SUFFIX.exec(errorMessage)?.[1];
		const parsedSuffixMs = suffixValue === undefined ? undefined : Number(suffixValue);
		const suffixHintMs =
			parsedSuffixMs !== undefined && Number.isFinite(parsedSuffixMs) && parsedSuffixMs > 0
				? Math.ceil(parsedSuffixMs)
				: undefined;
		const textHintMs =
			extractedTextHintMs === undefined && suffixHintMs === undefined
				? undefined
				: Math.max(extractedTextHintMs ?? 0, suffixHintMs ?? 0);
		const hintMs =
			headerHintMs === undefined && textHintMs === undefined
				? undefined
				: Math.max(headerHintMs ?? 0, textHintMs ?? 0);
		// An over-cap hint means "come back much later"; parking a oneshot that
		// long is worse than surfacing the failure to the caller.
		if (hintMs !== undefined && hintMs > maxDelayMs) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}
		const backoff = backoffDelayMs(attempt, baseDelayMs);
		const delayMs = Math.min(Math.max(hintMs ?? 0, backoff), maxDelayMs);

		options?.onRetry?.({
			attempt,
			maxAttempts,
			delayMs,
			fromRetryHint: hintMs !== undefined && hintMs >= backoff,
			errorMessage,
			errorId,
		});
		// Aborting mid-backoff rejects with the caller's abort reason: a user
		// cancel must stay a cancel, not get relabelled as the provider failure we
		// happened to be waiting on.
		await sleep(delayMs, signal);
	}
}
