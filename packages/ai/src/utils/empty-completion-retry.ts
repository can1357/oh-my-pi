/**
 * Replay-safe retries for provider streams.
 *
 * A provider attempt can be discarded only until meaningful assistant output is
 * emitted. Pre-output markers are buffered so transient transport failures and
 * benign empty completions can re-issue a fresh request without duplicating
 * content; the first text, thinking, image, or tool-call-delta event commits
 * the attempt and restores live streaming. `toolcall_start` and `toolcall_end`
 * markers alone do not commit — if the stream dies before any argument content
 * arrives, the buffered markers are discarded and the attempt retried.
 *
 * Empty-completion retries remain opt-in because a normal empty stop can be a
 * valid provider result. Transient-error retries use the shared provider error
 * classifier and are separately bounded by the caller's policy.
 */
import { scheduler } from "node:timers/promises";
import * as AIError from "../error";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

export const MAX_EMPTY_COMPLETION_RETRIES = 2;
export const EMPTY_COMPLETION_BASE_DELAY_MS = 500;

const NON_WHITESPACE_RE = /\S/;

/**
 * Whether a completed assistant message carries content worth delivering: an
 * image, tool call, or any non-whitespace text. An empty/whitespace-only message
 * — or one that only ever produced thinking — is the "empty response" failure.
 */
export function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	for (const block of message.content) {
		if (block.type === "image") return true;
		if (block.type === "toolCall") return true;
		if (block.type === "text" && NON_WHITESPACE_RE.test(block.text)) return true;
	}
	return false;
}

/** A streamed event that delivers content worth committing the attempt for. `toolcall_start` and `toolcall_end` markers are excluded: they carry no argument data, so a stream that dies after the start but before any delta content should be retried rather than committed. A `toolcall_delta` with a non-empty delta string is what commits a tool call — string-arg hosts emit `{}` itself as a delta, so completed zero-argument calls commit on their args. Object-arg hosts merge `{}` delta-free (the flush is suppressed and both sweeps finalize through the same `finishToolCallBlock`), so a completed call there is event-identical to an unfilled one and bounded-retries instead. Committing on `toolcall_end` would also commit mid-args transport failures that today recover invisibly via retry. Safe either way: buffered output never reached the consumer and the tool never executed. */
function isMeaningfulCompletionEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "image_end":
			return true;
		case "toolcall_start":
		case "toolcall_end":
			return false;
		default:
			return false;
	}
}

interface StreamRetryOptions {
	signal?: AbortSignal;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	acceptEmptyResponse?: boolean;
	/**
	 * Shared provider-attempt budget for the current provider request, created by
	 * {@link withReplaySafeStreamRetry} and decremented by the transport
	 * (`fetchWithRetry`). Bounds every stacked retry layer together, so a replay
	 * retry cannot multiply the transport's own budget.
	 */
	providerAttemptBudget?: { remaining: number };
}

/** Controls which replay-safe provider results may issue a fresh request. */
export interface ReplaySafeStreamRetryPolicy {
	/** Retry benign terminal stops that contain no visible output. */
	retryEmptyCompletion?: boolean;
	/** Retry transient provider errors before output is committed. */
	retryProviderErrors?: boolean;
	/** Maximum transient provider-error retries; empty completions keep their shared fixed budget. */
	maxProviderErrorRetries?: number;
	/**
	 * Total provider request budget for this stream call (initial request plus
	 * every transport/replay retry). When set, it supersedes
	 * {@link maxProviderErrorRetries}: a shared budget is created, handed to the
	 * transport, and replay retries are allowed only while it has attempts left.
	 * This is what keeps stacked retry layers from multiplying each other
	 * (e.g. 6 transport attempts × 1 replay retry = 12 requests).
	 */
	maxProviderAttempts?: number;
}

class FinalizedProviderStreamError extends Error {
	readonly status?: number;

	constructor(message: string, status: number | undefined) {
		super(message);
		this.name = "FinalizedProviderStreamError";
		this.status = status;
	}
}

/**
 * Re-issues a fresh provider request only while the current attempt remains
 * replay-safe. Buffered pre-output events from discarded attempts never reach
 * consumers.
 */
export function withReplaySafeStreamRetry<M, O extends StreamRetryOptions>(
	model: M,
	context: Context,
	options: O | undefined,
	attempt: (model: M, context: Context, options?: O) => AssistantMessageEventStream,
	policy: ReplaySafeStreamRetryPolicy,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const signal = options?.signal;
	// One budget per public stream call when the caller declared a total provider
	// attempt allowance: the transport charges it per physical request, and the
	// replay layer below only retries while attempts remain.
	const budget =
		policy.maxProviderAttempts === undefined
			? undefined
			: { remaining: Math.max(1, Math.floor(policy.maxProviderAttempts)) };
	const attemptOptions = budget === undefined ? options : ({ ...options, providerAttemptBudget: budget } as O);
	void (async () => {
		let emptyRetries = 0;
		let providerErrorRetries = 0;
		while (true) {
			const buffered: AssistantMessageEvent[] = [];
			let committed = options?.acceptEmptyResponse === true;
			let terminal: AssistantMessageEvent | undefined;
			const flush = (): void => {
				for (const event of buffered) outer.push(event);
				buffered.length = 0;
			};
			let inner: AssistantMessageEventStream;
			try {
				// The attempt factory can throw synchronously (e.g. a config error
				// raised before it creates its stream); surface it on the outer stream
				// rather than leaking an unhandled rejection that never settles.
				inner = attempt(model, context, attemptOptions);
				for await (const event of inner) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}
					if (!committed && !isMeaningfulCompletionEvent(event)) {
						buffered.push(event);
						continue;
					}
					committed = true;
					flush();
					outer.push(event);
					if (outer.done) return;
				}
			} catch (error) {
				flush();
				outer.fail(error);
				return;
			}

			const completedMessage = terminal?.type === "done" ? terminal.message : undefined;
			const retryEmpty =
				policy.retryEmptyCompletion === true &&
				// A replay retry issues a fresh physical request, so it must fit the
				// shared provider budget (see `maxProviderAttempts`).
				(budget === undefined || budget.remaining > 0) &&
				options?.acceptEmptyResponse !== true &&
				!committed &&
				completedMessage !== undefined &&
				completedMessage.stopReason === "stop" &&
				completedMessage.stopDetails?.type !== "pause_turn" &&
				completedMessage.stopDetails?.type !== "compaction" &&
				!completedMessage.errorMessage &&
				(completedMessage.usage?.output ?? 0) <= 1 &&
				!hasVisibleAssistantContent(completedMessage) &&
				emptyRetries < MAX_EMPTY_COMPLETION_RETRIES;
			const failedMessage = terminal?.type === "error" ? terminal.error : undefined;
			// A declared total budget supersedes the fixed replay-retry count: the
			// transport has already spent attempts for this provider request, so the
			// replay layer retries only while the shared budget still has room. The
			// cap below is a safety net for a transport that never charges the
			// budget, and it keeps the total at the declared allowance (`N` attempts
			// = 1 initial request + at most `N - 1` replay retries).
			const providerRetryLimit =
				policy.maxProviderAttempts === undefined
					? (policy.maxProviderErrorRetries ?? 0)
					: Math.max(0, Math.floor(policy.maxProviderAttempts) - 1);
			const retryProviderError =
				policy.retryProviderErrors === true &&
				!committed &&
				(budget === undefined || budget.remaining > 0) &&
				failedMessage?.stopReason === "error" &&
				failedMessage.errorMessage !== undefined &&
				providerErrorRetries < providerRetryLimit &&
				AIError.isProviderRetryableError(
					new FinalizedProviderStreamError(failedMessage.errorMessage, failedMessage.errorStatus),
				);

			let delayMs: number | undefined;
			if (retryEmpty) {
				delayMs = EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** emptyRetries;
				emptyRetries++;
			} else if (retryProviderError) {
				delayMs = EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** providerErrorRetries;
				providerErrorRetries++;
			}

			if (delayMs !== undefined && !signal?.aborted) {
				try {
					if (options?.providerRetryWait) await options.providerRetryWait(delayMs, signal);
					else await scheduler.wait(delayMs, { signal });
				} catch (waitError) {
					flush();
					if (signal?.aborted) {
						if (terminal) outer.push(terminal);
					} else {
						outer.fail(waitError);
					}
					return;
				}
				continue;
			}

			flush();
			if (terminal) {
				outer.push(terminal);
			} else if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (error) {
					outer.fail(error);
				}
			}
			return;
		}
	})();
	return outer;
}
