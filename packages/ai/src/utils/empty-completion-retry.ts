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
 * classifier, are separately bounded by the caller's policy, and wait at least
 * as long as the provider stated (a stated wait past `maxRetryDelayMs`, or a
 * set `providerRetryWaitCeilingMs`, surfaces the failure instead).
 */
import * as AIError from "../error";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl } from "../types";
import { AssistantMessageEventStream } from "./event-stream";
import { providerRetryWaitMs, retryWaitBounds } from "./retry-after";
import {
	DEFAULT_MAX_RETRY_DELAY_MS,
	hasRefusedRetryWaitNote,
	refusedRetryWaitNote,
	retryWaitRefusal,
	sleepBeforeRetry,
} from "./retry-wait";
import { withWireCount } from "./wire-attempts";

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
	fetch?: FetchImpl;
	maxRetryDelayMs?: number;
	providerRetryWaitCeilingMs?: number;
}

/** Controls which replay-safe provider results may issue a fresh request. */
export interface ReplaySafeStreamRetryPolicy {
	/** Retry benign terminal stops that contain no visible output. */
	retryEmptyCompletion?: boolean;
	/** Retry transient provider errors before output is committed. */
	retryProviderErrors?: boolean;
	/** Maximum transient provider-error retries; empty completions keep their shared fixed budget. */
	maxProviderErrorRetries?: number;
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
 *
 * Every attempt goes out under the same request counter (`withWireCount`), so
 * a provider that reports `providerReplays` reports every request this
 * wrapper's attempts made, the discarded ones included, and the terminal event
 * is forwarded as reported: nothing here adds to a count, so nothing here can
 * count a request twice or forget one.
 *
 * One check stays: a count over one counter never falls. A report below one an
 * earlier attempt already made, or a number after an attempt that reported
 * none, cannot be this request's count — the layer below counted only its own
 * call — and is forwarded as unknown rather than as a zero the request has
 * already disproved.
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
	const attemptOptions = withWireCount(options);
	void (async () => {
		let emptyRetries = 0;
		let providerErrorRetries = 0;
		/** The least count the request can report now: the highest an earlier attempt reported. */
		let replayFloor = 0;
		let unreportedAttempt = false;
		const forwardTerminal = (event: AssistantMessageEvent): void => {
			const reported = terminalReplays(event);
			if (reported === undefined || (!unreportedAttempt && reported >= replayFloor)) {
				outer.push(event);
				return;
			}
			// A copy, not a write: the message belongs to the layer below and may be
			// the same object on its next call.
			if (event.type === "error") {
				const { providerReplays: _discarded, ...error } = event.error;
				outer.push({ ...event, error });
			} else if (event.type === "done") {
				const { providerReplays: _discarded, ...message } = event.message;
				outer.push({ ...event, message });
			}
		};
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
			const retryProviderError =
				policy.retryProviderErrors === true &&
				!committed &&
				failedMessage?.stopReason === "error" &&
				failedMessage.errorMessage !== undefined &&
				failedMessage.errorRetryWaitRefusal === undefined &&
				providerErrorRetries < (policy.maxProviderErrorRetries ?? 0) &&
				AIError.isProviderRetryableError(
					new FinalizedProviderStreamError(
						failedMessage.errorClassificationMessage ?? failedMessage.errorMessage,
						failedMessage.errorStatus,
					),
				);

			// A provider error waits at least the wait its failed attempt stated, read
			// as session retry reads it: the response headers' wait
			// (`errorRetryAfterMs`) with the message's relative waits beside it, else
			// the message's text. A wait past the caller's bounds surfaces the failure.
			const statedWaitMs = retryProviderError
				? providerRetryWaitMs(
						failedMessage?.provider,
						failedMessage?.errorMessage,
						failedMessage?.errorRetryAfterMs,
					)
				: undefined;
			const delayMs = retryEmpty
				? EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** emptyRetries
				: retryProviderError &&
					  !retryWaitBounds(options, DEFAULT_MAX_RETRY_DELAY_MS).declines(statedWaitMs, failedMessage)
					? Math.max(statedWaitMs ?? 0, EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** providerErrorRetries)
					: undefined;

			if (delayMs !== undefined && !signal?.aborted) {
				try {
					await sleepBeforeRetry(options, delayMs, signal);
				} catch (waitError) {
					flush();
					if (signal?.aborted) {
						if (terminal) forwardTerminal(terminal);
					} else {
						outer.fail(waitError);
					}
					return;
				}
				if (retryEmpty) emptyRetries++;
				else providerErrorRetries++;
				const discarded = terminal ? terminalReplays(terminal) : undefined;
				if (discarded === undefined) unreportedAttempt = true;
				else replayFloor = Math.max(replayFloor, discarded);
				continue;
			}

			flush();
			if (terminal) {
				forwardTerminal(retryProviderError && delayMs === undefined ? withRefusalNote(terminal) : terminal);
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

/**
 * `event`, when this wrapper refused the wait its failed message states
 * (`RetryWaitBounds.declines`), with the message saying so, unless the layer
 * below already did. The note's text is kept out of the classification
 * (`errorClassificationMessage`). A copy: the message belongs to the layer below.
 */
function withRefusalNote(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type !== "error") return event;
	const refused = retryWaitRefusal(event.error);
	const message = event.error.errorMessage;
	if (refused === undefined || message === undefined) return event;
	const noted = hasRefusedRetryWaitNote(message);
	const note = noted ? message : `${message} ${refusedRetryWaitNote(refused)}`;
	return {
		...event,
		error: {
			...event.error,
			errorRetryWaitRefusal: refused,
			errorMessage: note,
			errorClassificationMessage: event.error.errorClassificationMessage ?? message,
		},
	};
}

function terminalReplays(event: AssistantMessageEvent): number | undefined {
	if (event.type === "error") return event.error.providerReplays;
	if (event.type === "done") return event.message.providerReplays;
	return undefined;
}
