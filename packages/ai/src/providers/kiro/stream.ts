import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { decodeKiroCredential, kiroRuntimeBaseUrl } from "@oh-my-pi/pi-catalog/wire/kiro";
import { kiroCliServiceHeaders } from "@oh-my-pi/pi-catalog/wire/kiro-cli";
import { isRecord } from "@oh-my-pi/pi-utils";
import { readBoundedBody } from "@oh-my-pi/pi-utils/bounded-json";
import * as AIError from "../../error";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../../types";
import { hasVisibleAssistantContent } from "../../utils/empty-completion-retry";
import { AssistantMessageEventStream as MessageEventStream } from "../../utils/event-stream";
import {
	armPreResponseTimeout,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../../utils/idle-iterator";
import { notifyProviderResponse } from "../../utils/provider-response";
import { waitForRetry } from "../../utils/retry-wait";
import { decodeEventStream, type EventStreamMessage } from "../aws-eventstream";
import { transformKiroRequest } from "./transform";

export interface KiroOptions extends SimpleStreamOptions {
	/** A raw `ksk_…` key or the `encodeKiroCredential` string auth resolves for Kiro. */
	apiKey?: string;
}

/** Requests per call: the first plus at most one pre-output retry. */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const IDLE_TIMEOUT_ERROR = "Kiro stream timed out while waiting for the next event";
const FIRST_EVENT_TIMEOUT_ERROR = "Kiro stream timed out while waiting for the first visible output";
/** `ThrottlingError.reason` when the selected model has no capacity (Smithy model in aws/amazon-q-developer-cli). */
const INSUFFICIENT_MODEL_CAPACITY = "INSUFFICIENT_MODEL_CAPACITY";
/**
 * Body text of Kiro's context-window rejection. The Kiro CLI treats any error
 * body containing it as a context overflow, whatever the HTTP status
 * (`classify_error_kind` in aws/amazon-q-developer-cli `api_client/mod.rs`).
 */
const INPUT_TOO_LONG = "Input is too long.";
/** Kiro runtime's structured rejection when serialized input exceeds its content threshold. */
const CONTENT_LENGTH_EXCEEDS_THRESHOLD = "CONTENT_LENGTH_EXCEEDS_THRESHOLD";
/**
 * HTTP-equivalent status of in-stream exception shapes, keyed lowercase. Exception
 * frames ride inside an HTTP 200, so without this the shared retry classifier
 * would read a temporary throttle as terminal. Unknown shapes stay status-less.
 */
const STREAM_EXCEPTION_STATUS: Record<string, number> = {
	accessdeniedexception: 403,
	internalserverexception: 500,
	internalservererror: 500,
	modeltimeoutexception: 408,
	serviceunavailableexception: 503,
	throttlingerror: 429,
	throttlingexception: 429,
};
/** Event frames this provider reads; every other event type is skipped undecoded. */
const HANDLED_EVENTS: Record<string, true> = {
	"initial-response": true,
	metadataEvent: true,
	reasoningContentEvent: true,
	assistantResponseEvent: true,
	toolUseEvent: true,
	contextUsageEvent: true,
	meteringEvent: true,
};
const PAYLOAD_DECODER = new TextDecoder("utf-8", { fatal: true });

class KiroApiError extends AIError.ProviderHttpError {
	override readonly name = "KiroApiError";
	/**
	 * The identical request is known to succeed on replay: a model-capacity
	 * throttle, or the fleet's transient `ValidationException: Invalid tool use
	 * format.` that a byte-identical retry clears.
	 */
	readonly replayable: boolean;

	constructor(message: string, status: number, code: string | undefined, reason: unknown, headers?: Headers) {
		super(message, status, { code, headers });
		this.replayable =
			reason === INSUFFICIENT_MODEL_CAPACITY ||
			(status === 400 && code === "ValidationException" && /invalid tool use format[.\s]*$/i.test(message));
	}
}

const kiroString = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function responseError(message: string, kind: AIError.ProviderResponseErrorKind = "output"): Error {
	return new AIError.ProviderResponseError(message, { provider: "kiro", kind });
}

function parsePayload(bytes: Uint8Array): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(PAYLOAD_DECODER.decode(bytes));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function httpError(response: Response, signal: AbortSignal | undefined): Promise<Error> {
	// A proxy can answer 429/503 with a short body and hold the connection open,
	// so the body read honours the caller's deadline.
	const body = await readBoundedBody(response, MAX_ERROR_BODY_BYTES, { signal });
	const payload = (body && parsePayload(body.bytes)) ?? {};
	const code = kiroString(payload.__type ?? payload.code)
		?.split("#")
		.at(-1);
	const detail = kiroString(payload.message) ?? kiroString(payload.reason);
	const message = `Kiro HTTP ${response.status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`;
	const error = new KiroApiError(message, response.status, code, payload.reason, response.headers);
	const overflow =
		response.status === 413 ||
		payload.reason === CONTENT_LENGTH_EXCEEDS_THRESHOLD ||
		(body !== null && new TextDecoder().decode(body.bytes).includes(INPUT_TOO_LONG));
	return overflow ? AIError.attach(error, AIError.create(AIError.Flag.ContextOverflow)) : error;
}

/** An `exception`/`error` frame: the failure is in its headers, a payload (when present) adds the shape's fields. */
function frameError(frame: EventStreamMessage): Error {
	const payload = parsePayload(frame.payload) ?? {};
	const code =
		frame.headers[":exception-type"] ??
		frame.headers[":error-code"] ??
		kiroString(payload.code ?? payload.__type) ??
		"KIRO_EVENTSTREAM_ERROR";
	const detail = kiroString(payload.message) ?? frame.headers[":error-message"];
	const message = `${code}${detail ? `: ${detail}` : ""}`;
	// A capacity reason is a throttle whatever shape carries it.
	const status =
		STREAM_EXCEPTION_STATUS[code.toLowerCase()] ?? (payload.reason === INSUFFICIENT_MODEL_CAPACITY ? 429 : undefined);
	return status === undefined ? responseError(message) : new KiroApiError(message, status, code, payload.reason);
}

interface KiroEvent {
	type: string;
	payload: Record<string, unknown>;
}

async function* kiroEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<KiroEvent> {
	for await (const frame of decodeEventStream(body)) {
		const messageType = frame.headers[":message-type"];
		if (messageType === "exception" || messageType === "error") throw frameError(frame);
		const type = frame.headers[":event-type"];
		if (messageType !== "event" || !type || HANDLED_EVENTS[type] !== true) continue;
		const payload = parsePayload(frame.payload);
		if (!payload) throw responseError(`Kiro sent a malformed ${type} payload`, "envelope");
		yield { type, payload };
	}
}

function isProgressEvent({ type, payload }: KiroEvent): boolean {
	if (type === "toolUseEvent") return true;
	if (type === "reasoningContentEvent") return Boolean(kiroString(payload.text));
	return type === "assistantResponseEvent" && Boolean(kiroString(payload.content)?.trim());
}

interface PendingTool {
	index: number;
	fragments: string;
	snapshot?: Record<string, unknown>;
	done: boolean;
}

/** One request's output: content blocks, tool-call assembly, and the terminal metadata. */
class KiroAttempt {
	readonly output: AssistantMessage;
	/** Output reached the consumer; the request is no longer replayable. */
	visible = false;
	/** The service sent `meteringEvent`: this request was billed and must not be replayed. */
	metered = false;
	stopReason: string | undefined;
	refusal: Record<string, unknown> | undefined;
	tokenUsage: Record<string, unknown> = {};
	contextUsagePercentage: number | undefined;
	firstOutputTime: number | undefined;
	emittedTools = 0;
	readonly #stream: AssistantMessageEventStream;
	#textIndex: number | undefined;
	#thinkingIndex: number | undefined;
	readonly #tools = new Map<string, PendingTool>();

	constructor(model: Model, stream: AssistantMessageEventStream, timestamp: number) {
		this.#stream = stream;
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		};
	}

	#markVisible(): void {
		if (!this.visible) this.#stream.push({ type: "start", partial: this.output });
		this.visible = true;
		this.firstOutputTime ??= performance.now();
	}

	#closeThinking(): void {
		if (this.#thinkingIndex === undefined) return;
		const block = this.output.content[this.#thinkingIndex] as ThinkingContent;
		this.#stream.push({
			type: "thinking_end",
			contentIndex: this.#thinkingIndex,
			content: block.thinking,
			partial: this.output,
		});
		this.#thinkingIndex = undefined;
	}

	/** Close the open text block so a tool call or later text cannot merge into it. */
	#closeText(): void {
		if (this.#textIndex === undefined) return;
		const block = this.output.content[this.#textIndex] as TextContent;
		this.#stream.push({ type: "text_end", contentIndex: this.#textIndex, content: block.text, partial: this.output });
		this.#textIndex = undefined;
	}

	text(text: string): void {
		if (!text) return;
		this.#markVisible();
		this.#closeThinking();
		if (this.#textIndex === undefined) {
			this.#textIndex = this.output.content.push({ type: "text", text: "" }) - 1;
			this.#stream.push({ type: "text_start", contentIndex: this.#textIndex, partial: this.output });
		}
		(this.output.content[this.#textIndex] as TextContent).text += text;
		this.#stream.push({ type: "text_delta", contentIndex: this.#textIndex, delta: text, partial: this.output });
	}

	thinking(text: string, signature: string | undefined): void {
		if (text) {
			this.#markVisible();
			if (this.#thinkingIndex === undefined) {
				this.#thinkingIndex = this.output.content.push({ type: "thinking", thinking: "" }) - 1;
				this.#stream.push({ type: "thinking_start", contentIndex: this.#thinkingIndex, partial: this.output });
			}
		}
		if (this.#thinkingIndex === undefined) return;
		const block = this.output.content[this.#thinkingIndex] as ThinkingContent;
		block.thinking += text;
		if (signature) block.thinkingSignature = signature;
		if (text) {
			this.#stream.push({
				type: "thinking_delta",
				contentIndex: this.#thinkingIndex,
				delta: text,
				partial: this.output,
			});
		}
	}

	/** A `toolUseEvent`: string `input` streams argument JSON fragments; an object `input` is a full snapshot. */
	tool(payload: Record<string, unknown>): void {
		const id = kiroString(payload.toolUseId);
		if (!id) throw responseError("Kiro tool event has no toolUseId");
		let tool = this.#tools.get(id);
		if (tool?.done) throw responseError(`Kiro tool ${id} received data after completion`);
		if (!tool) {
			const name = kiroString(payload.name);
			if (!name) throw responseError(`Kiro tool ${id} started without a name`);
			this.#markVisible();
			this.#closeThinking();
			this.#closeText();
			const index = this.output.content.push({ type: "toolCall", id, name, arguments: {} }) - 1;
			tool = { index, fragments: "", done: false };
			this.#tools.set(id, tool);
			this.#stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
		}
		const input = payload.input;
		if (typeof input === "string" && input) {
			tool.fragments += input;
			this.#stream.push({ type: "toolcall_delta", contentIndex: tool.index, delta: input, partial: this.output });
		} else if (isRecord(input)) {
			tool.snapshot = input;
		}
		if (payload.stop === true) this.#finishTool(tool);
	}

	#finishTool(tool: PendingTool): void {
		let args = tool.snapshot;
		if (!args) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(tool.fragments.trim() || "{}");
			} catch {}
			if (!isRecord(parsed)) {
				const { id } = this.output.content[tool.index] as ToolCall;
				throw responseError(`Kiro tool ${id} completed with malformed JSON input`);
			}
			args = parsed;
		}
		const block = this.output.content[tool.index] as ToolCall;
		block.arguments = args;
		tool.done = true;
		this.emittedTools++;
		this.#stream.push({ type: "toolcall_end", contentIndex: tool.index, toolCall: block, partial: this.output });
	}

	/**
	 * Close open blocks and finalize tools that never got `stop`. A truncated or
	 * filtered turn's unfinished calls carry cut-off arguments, so they are
	 * dropped instead and never reach the agent loop.
	 */
	finish(dropUnfinishedTools: boolean): void {
		this.#closeThinking();
		this.#closeText();
		const dropped: number[] = [];
		for (const tool of this.#tools.values()) {
			if (tool.done) continue;
			if (dropUnfinishedTools) dropped.push(tool.index);
			else this.#finishTool(tool);
		}
		// Splice from the end so earlier indices stay valid.
		for (const index of dropped.reverse()) this.output.content.splice(index, 1);
	}

	/**
	 * Usage comes from `metadataEvent.tokenUsage` (the runtime's `TokenUsage`;
	 * `uncachedInputTokens` excludes cache reads and writes). `contextUsageEvent`
	 * reports occupancy as a share of the model's window.
	 */
	finalizeUsage(model: Model): void {
		const count = (value: unknown) => (typeof value === "number" && value >= 0 ? value : 0);
		const usage = this.output.usage;
		usage.input = count(this.tokenUsage.uncachedInputTokens);
		usage.output = count(this.tokenUsage.outputTokens);
		usage.cacheRead = count(this.tokenUsage.cacheReadInputTokens);
		usage.cacheWrite = count(this.tokenUsage.cacheWriteInputTokens);
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (this.contextUsagePercentage !== undefined && model.contextWindow) {
			usage.contextTokens = Math.round((this.contextUsagePercentage / 100) * model.contextWindow);
		}
		calculateCost(model, usage);
	}
}

/**
 * One replay, only while nothing is visible or billed, and only for failures
 * where the identical request is known to succeed: a capacity throttle, a
 * transient tool-format rejection, or a body cut off inside a frame.
 */
function shouldRetry(attempt: KiroAttempt, attemptNumber: number, error: unknown): boolean {
	if (attemptNumber >= MAX_ATTEMPTS || attempt.visible || attempt.metered) return false;
	return (
		(error instanceof KiroApiError && error.replayable) ||
		(error instanceof AIError.EventStreamFrameError && error.kind === "truncated")
	);
}

/** Native Kiro stream implementation. */
export function streamKiro(model: Model, context: Context, options: KiroOptions = {}): AssistantMessageEventStream {
	const stream = new MessageEventStream();
	const timestamp = Date.now();
	const startTime = performance.now();
	void (async () => {
		let attempt = new KiroAttempt(model, stream, timestamp);
		try {
			if (!options.apiKey) throw new AIError.ProviderHttpError("Kiro credential is missing", 401);
			const credential = decodeKiroCredential(options.apiKey);
			// An API key without a pinned region uses the runtime discovery resolved for this model.
			const url = credential.region ? kiroRuntimeBaseUrl(credential.region) : model.baseUrl;
			// Built once: a retry replays byte-identical bytes and never reruns a stateful payload hook.
			let payload = transformKiroRequest(model, context, {
				reasoning: options.reasoning,
				disableReasoning: options.disableReasoning,
				hideThinkingSummary: options.hideThinkingSummary,
				maxTokens: options.maxTokens,
				conversationId: options.sessionId,
			});
			if (credential.kind === "oauth" && credential.profileArn) payload.profileArn = credential.profileArn;
			payload = ((await options.onPayload?.(payload, model)) as typeof payload | undefined) ?? payload;
			const body = JSON.stringify(payload);
			const idleTimeoutMs = options.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			for (let attemptNumber = 1; ; attemptNumber++) {
				attempt = new KiroAttempt(model, stream, timestamp);
				const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
				// Aborted by the watchdogs and before a retry: the frame decoder holds the
				// body's reader lock while a read is pending, so only aborting the fetch
				// releases a stalled connection.
				const transport = new AbortController();
				try {
					const headers = new Headers(model.headers);
					for (const [key, value] of Object.entries({
						...options.headers,
						...kiroCliServiceHeaders("GenerateAssistantResponse", credential.token, {
							attempt: attemptNumber,
							maxAttempts: MAX_ATTEMPTS,
						}),
					})) {
						headers.set(key, value);
					}
					const response = await (options.fetch ?? globalThis.fetch)(url, {
						method: "POST",
						headers,
						body,
						signal: watchdog.signal ? AbortSignal.any([watchdog.signal, transport.signal]) : transport.signal,
					});
					// On success the idle iterator owns the deadline; an error body read keeps the watchdog.
					if (response.ok) watchdog.clear();
					const requestId = response.headers.get("x-amzn-requestid") ?? response.headers.get("x-amz-request-id");
					await notifyProviderResponse(options, response, model, requestId);
					if (!response.ok) throw await httpError(response, watchdog.signal);
					if (!response.body) throw responseError("Kiro response has no body", "empty-body");
					attempt.output.responseId = requestId ?? undefined;
					const events = iterateWithIdleTimeout(kiroEvents(response.body), {
						idleTimeoutMs,
						firstItemTimeoutMs: firstEventTimeoutMs,
						errorMessage: IDLE_TIMEOUT_ERROR,
						firstItemErrorMessage: FIRST_EVENT_TIMEOUT_ERROR,
						onIdle: () => transport.abort(new AIError.StreamTimeoutError(IDLE_TIMEOUT_ERROR)),
						onFirstItemTimeout: () => transport.abort(new AIError.StreamTimeoutError(FIRST_EVENT_TIMEOUT_ERROR)),
						abortSignal: options.signal,
						isProgressItem: event => isProgressEvent(event as KiroEvent),
					});
					for await (const { type, payload: event } of events) {
						switch (type) {
							case "initial-response":
							case "metadataEvent":
								// The runtime reports stopReason, classifier details, and token usage here.
								attempt.output.responseId = kiroString(event.requestId) ?? attempt.output.responseId;
								attempt.stopReason = kiroString(event.stopReason) ?? attempt.stopReason;
								if (isRecord(event.stopDetails) && isRecord(event.stopDetails.refusal)) {
									attempt.refusal = event.stopDetails.refusal;
								}
								if (isRecord(event.tokenUsage)) attempt.tokenUsage = event.tokenUsage;
								break;
							case "reasoningContentEvent":
								attempt.thinking(kiroString(event.text) ?? "", kiroString(event.signature));
								break;
							case "assistantResponseEvent":
								if (typeof event.content !== "string") {
									throw responseError("Kiro assistant event has no content", "envelope");
								}
								attempt.text(event.content);
								break;
							case "toolUseEvent":
								attempt.tool(event);
								break;
							case "contextUsageEvent": {
								const percentage = event.contextUsagePercentage;
								if (typeof percentage === "number" && percentage >= 0 && percentage <= 100) {
									attempt.contextUsagePercentage = percentage;
								}
								break;
							}
							case "meteringEvent":
								attempt.metered = true;
								break;
						}
					}
				} catch (error) {
					transport.abort();
					if (!shouldRetry(attempt, attemptNumber, error)) throw error;
					await waitForRetry(options.providerRetryWait, RETRY_DELAY_MS, options.signal);
					continue;
				} finally {
					watchdog.clear();
				}

				const contentFiltered = attempt.stopReason === "CONTENT_FILTERED" || attempt.refusal !== undefined;
				const truncated = attempt.stopReason === "MAX_TOKENS" || attempt.stopReason === "LENGTH";
				attempt.finish(contentFiltered || truncated);
				attempt.finalizeUsage(model);
				if (contentFiltered) {
					const category = kiroString(attempt.refusal?.category);
					const explanation = kiroString(attempt.refusal?.explanation);
					attempt.output.stopDetails = {
						type: "refusal",
						category: category ?? null,
						explanation: explanation ?? null,
					};
					const label = category ? `Refusal (${category})` : "Refusal";
					throw responseError(`${label}: ${explanation ?? "content was filtered by Kiro"}`, "content-blocked");
				}
				if (!attempt.visible) {
					throw responseError("Kiro stream ended without visible output", "incomplete-stream");
				}
				if (!hasVisibleAssistantContent(attempt.output) && options.acceptEmptyResponse !== true) {
					throw responseError("Kiro stream ended with reasoning but without final output", "empty-output");
				}
				// Truncation wins over an emitted tool call: its arguments may be cut off.
				const stopReason = truncated ? "length" : attempt.emittedTools > 0 ? "toolUse" : "stop";
				attempt.output.stopReason = stopReason;
				attempt.output.duration = performance.now() - startTime;
				if (attempt.firstOutputTime !== undefined) attempt.output.ttft = attempt.firstOutputTime - startTime;
				stream.push({ type: "done", reason: stopReason, message: attempt.output });
				stream.end();
				return;
			}
		} catch (error) {
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				signal: options.signal,
			});
			attempt.finalizeUsage(model);
			attempt.output.stopReason = result.stopReason;
			attempt.output.errorMessage = result.message;
			attempt.output.errorStatus = result.status;
			attempt.output.errorId = result.id;
			attempt.output.duration = performance.now() - startTime;
			if (attempt.firstOutputTime !== undefined) attempt.output.ttft = attempt.firstOutputTime - startTime;
			stream.push({ type: "error", reason: result.stopReason, error: attempt.output });
			stream.end();
		}
	})().catch(error => stream.fail(error));
	return stream;
}
