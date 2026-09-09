/**
 * Replay-safe retries for provider streams.
 *
 * A provider attempt can be discarded only until meaningful assistant output is
 * emitted. Pre-output markers are buffered so transient transport failures and
 * benign empty completions can re-issue a fresh request without duplicating
 * content; the first text, thinking, image, or tool event commits the attempt
 * and restores live streaming.
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

/** A streamed event that delivers content worth committing the attempt for. */
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
			return true;
		default:
			return false;
	}
}

interface StreamRetryOptions {
	signal?: AbortSignal;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	acceptEmptyResponse?: boolean;
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
				inner = attempt(model, context, options);
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
				providerErrorRetries < (policy.maxProviderErrorRetries ?? 0) &&
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
