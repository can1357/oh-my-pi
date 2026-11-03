import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import {
	kiroRuntimeBaseUrl,
	parseKiroEndpoint,
	parseKiroProfileArn,
	validateKiroApiRegion,
} from "@oh-my-pi/pi-catalog/wire/kiro";
import * as AIError from "../../error";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
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
import { decodeEventStream } from "../aws-eventstream";
import {
	isKiroCapacityError,
	isKiroTransientToolFormatError,
	KiroApiError,
	KiroStreamError,
	kiroHttpError,
} from "./errors";

import { mergeKiroUsage, normalizeKiroFrame } from "./event-normalizer";
import { KiroToolAssembler } from "./tool-assembler";
import { transformKiroRequest } from "./transform";
import type { KiroNormalizedEvent, KiroOptions, KiroStreamCredential, KiroUsageMetrics } from "./types";

const KIRO_RUNTIME_TARGET = "KiroRuntimeService.GenerateAssistantResponse";
const KIRO_USER_AGENT = "oh-my-pi/kiro-api";
const MAX_PRE_OUTPUT_RECOVERY_ATTEMPTS = 1;

function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	const keyByLower = new Map<string, string>();
	for (const headers of headerSources) {
		if (!headers) continue;
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			const existing = keyByLower.get(lower);
			if (existing !== undefined && existing !== key) delete merged[existing];
			keyByLower.set(lower, key);
			merged[key] = value;
		}
	}
	return merged;
}

const INLINE_THINKING_TAGS: ReadonlyArray<readonly [string, string]> = [
	["<thinking>", "</thinking>"],
	["<think>", "</think>"],
	["<reasoning>", "</reasoning>"],
	["<thought>", "</thought>"],
];

interface AttemptState {
	output: AssistantMessage;
	visible: boolean;
	started: boolean;
	firstOutputTime?: number;
	textIndex?: number;
	thinkingIndex?: number;
	nativeReasoning: boolean;
	inlineMode: "undecided" | "thinking" | "text";
	inlineBuffer: string;
	inlineClose?: string;
	pendingThinkingSignature?: string;
	usage: KiroUsageMetrics;
	contextUsagePercentage?: number;
	stopReason?: string;
	semanticEvents: number;
	toolAssembler: KiroToolAssembler;
}

function emptyOutput(model: Model, timestamp: number): AssistantMessage {
	return {
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

function parseCredential(value: string | undefined): KiroStreamCredential {
	if (!value) throw new KiroApiError("Kiro credential is missing", 401, { code: "AUTH_MISSING" });
	if (!value.startsWith("{")) return { token: value };
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
		const credential = parsed as Record<string, unknown>;
		if (typeof credential.token !== "string" || credential.token.length === 0) throw new Error("token missing");
		if (credential.profileArn !== undefined && typeof credential.profileArn !== "string") {
			throw new Error("profileArn invalid");
		}
		if (credential.apiEndpoint !== undefined && typeof credential.apiEndpoint !== "string") {
			throw new Error("apiEndpoint invalid");
		}
		return {
			token: credential.token,
			...(typeof credential.profileArn === "string" ? { profileArn: credential.profileArn } : {}),
			...(typeof credential.apiEndpoint === "string" ? { apiEndpoint: credential.apiEndpoint } : {}),
		};
	} catch (error) {
		throw new KiroApiError("Kiro credential projection is invalid", 401, {
			code: "AUTH_INVALID",
			cause: error,
		});
	}
}

function resolveKiroRuntimeBaseUrl(model: Model, credential: KiroStreamCredential): string {
	if (credential.profileArn !== undefined) {
		const profile = parseKiroProfileArn(credential.profileArn);
		if (!profile) {
			throw new KiroApiError("Invalid Kiro profile ARN", 0, { code: "INVALID_PROFILE" });
		}
		return kiroRuntimeBaseUrl(profile.apiRegion);
	}

	if (credential.apiEndpoint !== undefined) {
		const endpoint = parseKiroEndpoint(credential.apiEndpoint);
		if (endpoint?.kind !== "runtime") {
			throw new KiroApiError("Invalid Kiro runtime endpoint", 0, { code: "INVALID_ENDPOINT" });
		}
		return endpoint.baseUrl;
	}

	const configuredRegion = Bun.env.KIRO_API_REGION;
	if (configuredRegion !== undefined) {
		const apiRegion = validateKiroApiRegion(configuredRegion);
		if (!apiRegion) {
			throw new KiroApiError("KIRO_API_REGION is not a valid AWS region", 0, { code: "INVALID_REGION" });
		}
		return kiroRuntimeBaseUrl(apiRegion);
	}

	const modelEndpoint = parseKiroEndpoint(model.baseUrl);
	if (modelEndpoint?.kind !== "runtime") {
		throw new KiroApiError("Invalid Kiro runtime endpoint", 0, { code: "INVALID_ENDPOINT" });
	}
	return modelEndpoint.baseUrl;
}

function mapStopReason(
	reason: string | undefined,
	toolCalls: number,
): Extract<StopReason, "stop" | "length" | "toolUse"> {
	// Truncation wins over an emitted tool call: a tool frame cut off by
	// MAX_TOKENS holds incomplete arguments, and reporting `toolUse` would let
	// the agent loop execute it instead of applying its length safeguard.
	if (reason === "MAX_TOKENS" || reason === "LENGTH") return "length";
	if (toolCalls > 0) return "toolUse";
	return reason === "TOOL_USE" ? "toolUse" : "stop";
}

function markVisible(state: AttemptState, stream: AssistantMessageEventStream): void {
	if (!state.started) {
		state.started = true;
		stream.push({ type: "start", partial: state.output });
	}
	state.visible = true;
	state.firstOutputTime ??= performance.now();
}

function emitText(state: AttemptState, stream: AssistantMessageEventStream, text: string): void {
	if (!text) return;
	markVisible(state, stream);
	if (state.textIndex === undefined) {
		state.textIndex = state.output.content.length;
		state.output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: state.textIndex, partial: state.output });
	}
	const block = state.output.content[state.textIndex] as TextContent;
	block.text += text;
	stream.push({ type: "text_delta", contentIndex: state.textIndex, delta: text, partial: state.output });
}

function emitThinking(
	state: AttemptState,
	stream: AssistantMessageEventStream,
	text: string,
	signature?: string,
): void {
	if (signature !== undefined) state.pendingThinkingSignature = signature;
	if (!text) {
		if (state.thinkingIndex !== undefined && signature !== undefined) {
			const block = state.output.content[state.thinkingIndex] as ThinkingContent;
			block.thinkingSignature = signature;
		}
		return;
	}
	markVisible(state, stream);
	if (state.thinkingIndex === undefined) {
		state.thinkingIndex = state.output.content.length;
		state.output.content.push({ type: "thinking", thinking: "" });
		stream.push({ type: "thinking_start", contentIndex: state.thinkingIndex, partial: state.output });
	}
	const block = state.output.content[state.thinkingIndex] as ThinkingContent;
	block.thinking += text;
	if (state.pendingThinkingSignature !== undefined) block.thinkingSignature = state.pendingThinkingSignature;
	stream.push({ type: "thinking_delta", contentIndex: state.thinkingIndex, delta: text, partial: state.output });
}

function closeThinking(state: AttemptState, stream: AssistantMessageEventStream): void {
	if (state.thinkingIndex === undefined) return;
	const block = state.output.content[state.thinkingIndex] as ThinkingContent;
	stream.push({
		type: "thinking_end",
		contentIndex: state.thinkingIndex,
		content: block.thinking,
		partial: state.output,
	});
	state.thinkingIndex = undefined;
}

/**
 * Close the open text block so a tool call cannot be appended into it. Without
 * this, `text_end` trails `toolcall_end` and later text merges into the block
 * that preceded the tool.
 */
function closeText(state: AttemptState, stream: AssistantMessageEventStream): void {
	if (state.textIndex === undefined) return;
	const block = state.output.content[state.textIndex] as TextContent;
	stream.push({ type: "text_end", contentIndex: state.textIndex, content: block.text, partial: state.output });
	state.textIndex = undefined;
}

function hasVisibleInlineText(value: string): boolean {
	return value.trim().length > 0;
}

function isInlineContentProgress(state: AttemptState, chunk: string): boolean {
	if (!hasVisibleInlineText(chunk)) return false;
	if (state.nativeReasoning || state.inlineMode === "text") return true;

	let buffer = state.inlineBuffer + chunk;
	let close = state.inlineClose;
	if (state.inlineMode === "undecided") {
		const match = INLINE_THINKING_TAGS.find(([open]) => buffer.startsWith(open));
		if (match) {
			close = match[1];
			buffer = buffer.slice(match[0].length);
		} else if (INLINE_THINKING_TAGS.some(([open]) => open.startsWith(buffer))) {
			return false;
		} else {
			return true;
		}
	}

	if (!close) return true;
	const end = buffer.indexOf(close);
	if (end < 0) {
		const safeLength = Math.max(0, buffer.length - close.length + 1);
		return hasVisibleInlineText(buffer.slice(0, safeLength));
	}
	const remainder = buffer.slice(end + close.length).replace(/^\n\n/, "");
	return hasVisibleInlineText(buffer.slice(0, end)) || hasVisibleInlineText(remainder);
}

function processInlineContent(state: AttemptState, stream: AssistantMessageEventStream, chunk: string): void {
	if (state.nativeReasoning || state.inlineMode === "text") {
		closeThinking(state, stream);
		emitText(state, stream, chunk);
		return;
	}
	state.inlineBuffer += chunk;
	if (state.inlineMode === "undecided") {
		const match = INLINE_THINKING_TAGS.find(([open]) => state.inlineBuffer.startsWith(open));
		if (match) {
			state.inlineMode = "thinking";
			state.inlineClose = match[1];
			state.inlineBuffer = state.inlineBuffer.slice(match[0].length);
		} else if (INLINE_THINKING_TAGS.some(([open]) => open.startsWith(state.inlineBuffer))) {
			return;
		} else {
			state.inlineMode = "text";
			const buffered = state.inlineBuffer;
			state.inlineBuffer = "";
			emitText(state, stream, buffered);
			return;
		}
	}
	if (state.inlineMode !== "thinking" || !state.inlineClose) return;
	const end = state.inlineBuffer.indexOf(state.inlineClose);
	if (end < 0) {
		const safeLength = Math.max(0, state.inlineBuffer.length - state.inlineClose.length + 1);
		emitThinking(state, stream, state.inlineBuffer.slice(0, safeLength));
		state.inlineBuffer = state.inlineBuffer.slice(safeLength);
		return;
	}
	emitThinking(state, stream, state.inlineBuffer.slice(0, end));
	closeThinking(state, stream);
	const remainder = state.inlineBuffer.slice(end + state.inlineClose.length).replace(/^\n\n/, "");
	state.inlineBuffer = "";
	state.inlineMode = "text";
	emitText(state, stream, remainder);
}

function finalizeInline(state: AttemptState, stream: AssistantMessageEventStream): void {
	if (state.inlineBuffer) {
		if (state.inlineMode === "thinking") emitThinking(state, stream, state.inlineBuffer);
		else emitText(state, stream, state.inlineBuffer);
		state.inlineBuffer = "";
	}
	closeThinking(state, stream);
	closeText(state, stream);
}

function estimateOutputTokens(output: AssistantMessage): number {
	let bytes = 0;
	for (const block of output.content) {
		if (block.type === "text") bytes += Buffer.byteLength(block.text);
		else if (block.type === "thinking") bytes += Buffer.byteLength(block.thinking);
		else if (block.type === "toolCall") bytes += Buffer.byteLength(JSON.stringify(block.arguments));
	}
	return (bytes + 3) >> 2;
}

function finalizeUsage(state: AttemptState, model: Model): void {
	const usage = state.output.usage;
	usage.input =
		state.usage.inputTokens ?? Math.round(((state.contextUsagePercentage ?? 0) / 100) * (model.contextWindow ?? 0));
	usage.output = state.usage.outputTokens ?? estimateOutputTokens(state.output);
	usage.cacheRead = state.usage.cacheReadTokens ?? 0;
	usage.cacheWrite = state.usage.cacheWriteTokens ?? 0;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (state.usage.reasoningTokens !== undefined && state.usage.reasoningTokens <= usage.output) {
		usage.reasoningTokens = state.usage.reasoningTokens;
	}
	calculateCost(model, usage);
}

function createAttempt(model: Model, stream: AssistantMessageEventStream, timestamp: number): AttemptState {
	const output = emptyOutput(model, timestamp);
	const state: AttemptState = {
		output,
		visible: false,
		started: false,
		nativeReasoning: false,
		inlineMode: "undecided",
		inlineBuffer: "",
		usage: {},
		semanticEvents: 0,
		toolAssembler: undefined as unknown as KiroToolAssembler,
	};
	state.toolAssembler = new KiroToolAssembler(output, stream, () => {
		markVisible(state, stream);
		closeThinking(state, stream);
		closeText(state, stream);
	});
	return state;
}

async function waitBeforeRecovery(options: KiroOptions | undefined, signal: AbortSignal | undefined): Promise<void> {
	const delayMs = 500;
	if (options?.providerRetryWait) {
		await options.providerRetryWait(delayMs, signal);
		return;
	}
	signal?.throwIfAborted();
	if (!signal) {
		await Bun.sleep(delayMs);
		return;
	}
	// `Bun.sleep` takes no signal, so race it against abort to keep pre-output
	// recovery cancellable.
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([Bun.sleep(delayMs), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function isRecoverablePreOutputStreamFailure(error: unknown): boolean {
	return error instanceof AIError.EventStreamFrameError && error.message.includes("truncated message");
}

/** Native Kiro stream implementation. */
export function streamKiro(model: Model, context: Context, options: KiroOptions = {}): AssistantMessageEventStream {
	const stream = new MessageEventStream();
	const timestamp = Date.now();
	const startTime = performance.now();
	const conversationId = options.sessionId ?? crypto.randomUUID();
	void (async () => {
		let state = createAttempt(model, stream, timestamp);
		try {
			const credential = parseCredential(typeof options.apiKey === "string" ? options.apiKey : undefined);
			const runtimeBaseUrl = resolveKiroRuntimeBaseUrl(model, credential);
			let recoveryAttempt = 0;
			// Resolved once per request: caller option → environment override → shared helper default.
			const idleTimeoutMs = options.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			while (true) {
				state = createAttempt(model, stream, timestamp);
				let payload = transformKiroRequest(model, context, {
					reasoning: options.reasoning,
					disableReasoning: options.disableReasoning,
					hideThinkingSummary: options.hideThinkingSummary,
					maxTokens: options.maxTokens,
					conversationId,
				});
				if (credential.profileArn) payload.profileArn = credential.profileArn;
				const replacement = await options.onPayload?.(payload, model);
				if (replacement !== undefined) payload = replacement as typeof payload;
				const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
				let response: Response;
				try {
					response = await (options.fetch ?? globalThis.fetch)(runtimeBaseUrl, {
						method: "POST",
						headers: mergeHeaders(model.headers, options.headers, {
							"content-type": "application/x-amz-json-1.0",
							accept: "application/vnd.amazon.eventstream",
							authorization: `Bearer ${credential.token}`,
							"x-amz-target": KIRO_RUNTIME_TARGET,
							"x-amzn-codewhisperer-optout": "true",
							"amz-sdk-invocation-id": crypto.randomUUID(),
							"amz-sdk-request": "attempt=1; max=1",
							"user-agent": KIRO_USER_AGENT,
						}),
						body: JSON.stringify(payload),
						signal: watchdog.signal,
					});
				} catch (error) {
					watchdog.clear();
					throw error;
				}
				// The success path hands the body to the idle-timeout iterator, which
				// owns its own deadline. The error path still needs this watchdog:
				// reading an error body must not outlive the deadline.
				if (response.ok) watchdog.clear();
				const headerRequestId =
					response.headers.get("x-amzn-requestid") ?? response.headers.get("x-amz-request-id");
				await notifyProviderResponse(options, response, model, headerRequestId);
				if (!response.ok) {
					try {
						const error = await kiroHttpError(response, watchdog.signal);
						if (
							(isKiroCapacityError(error) || isKiroTransientToolFormatError(error)) &&
							recoveryAttempt < MAX_PRE_OUTPUT_RECOVERY_ATTEMPTS &&
							!state.visible
						) {
							recoveryAttempt++;
							await waitBeforeRecovery(options, options.signal);
							continue;
						}
						throw error;
					} finally {
						watchdog.clear();
					}
				}
				const responseBody = response.body;
				if (!responseBody) {
					throw new KiroStreamError("Kiro response has no body", { code: "EMPTY_BODY", kind: "empty-body" });
				}
				state.output.responseId = headerRequestId ?? undefined;
				const normalizedFrames = (async function* () {
					for await (const frame of decodeEventStream(responseBody)) {
						yield normalizeKiroFrame(frame);
					}
				})();
				const frames = iterateWithIdleTimeout(normalizedFrames, {
					idleTimeoutMs,
					firstItemTimeoutMs: firstEventTimeoutMs,
					errorMessage: "Kiro stream timed out while waiting for the next event",
					firstItemErrorMessage: "Kiro stream timed out while waiting for the first visible output",
					onIdle: () => {
						void responseBody.cancel().catch(() => {});
					},
					onFirstItemTimeout: () => {
						void responseBody.cancel().catch(() => {});
					},
					abortSignal: options.signal,
					isProgressItem: event => {
						const normalizedEvent = event as KiroNormalizedEvent;
						switch (normalizedEvent.type) {
							case "reasoning":
								return Boolean(normalizedEvent.text);
							case "content":
								return isInlineContentProgress(state, normalizedEvent.content);
							case "tool":
								return true;
							default:
								return false;
						}
					},
				});
				try {
					for await (const event of frames) {
						if (event.type !== "ignored") state.semanticEvents++;
						switch (event.type) {
							case "metadata":
								if (event.requestId) state.output.responseId = event.requestId;
								if (event.stopReason) state.stopReason = event.stopReason;
								break;
							case "reasoning":
								state.nativeReasoning = true;
								emitThinking(state, stream, event.text ?? "", event.signature);
								break;
							case "content":
								processInlineContent(state, stream, event.content);
								if (event.stopReason) state.stopReason = event.stopReason;
								break;
							case "tool":
								state.toolAssembler.update(event);
								break;
							case "contextUsage":
								state.contextUsagePercentage = event.percentage;
								break;
							case "usage":
								mergeKiroUsage(state.usage, event.usage);
								break;
							case "ignored":
								break;
						}
					}
				} catch (error) {
					if (
						!state.visible &&
						recoveryAttempt < MAX_PRE_OUTPUT_RECOVERY_ATTEMPTS &&
						isRecoverablePreOutputStreamFailure(error)
					) {
						recoveryAttempt++;
						await waitBeforeRecovery(options, options.signal);
						continue;
					}
					throw error;
				}
				state.toolAssembler.finishAll(state.stopReason === "MAX_TOKENS" || state.stopReason === "LENGTH");
				finalizeInline(state, stream);
				if (!state.visible) {
					if (recoveryAttempt < MAX_PRE_OUTPUT_RECOVERY_ATTEMPTS) {
						recoveryAttempt++;
						await waitBeforeRecovery(options, options.signal);
						continue;
					}
					throw new KiroStreamError("Kiro stream ended without visible output", {
						code: "EMPTY_STREAM",
						kind: "incomplete-stream",
					});
				}
				if (!hasVisibleAssistantContent(state.output) && options.acceptEmptyResponse !== true) {
					throw new KiroStreamError("Kiro stream ended with reasoning but without final output", {
						code: "EMPTY_OUTPUT",
						kind: "empty-output",
					});
				}
				finalizeUsage(state, model);
				const stopReason = mapStopReason(state.stopReason, state.toolAssembler.emittedCount);
				state.output.stopReason = stopReason;
				state.output.duration = performance.now() - startTime;
				if (state.firstOutputTime !== undefined) state.output.ttft = state.firstOutputTime - startTime;
				stream.push({ type: "done", reason: stopReason, message: state.output });
				stream.end();
				return;
			}
		} catch (error) {
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				signal: options.signal,
			});
			state.output.stopReason = result.stopReason;
			state.output.errorMessage = result.message;
			state.output.errorStatus = result.status;
			state.output.errorId = result.id;
			state.output.duration = performance.now() - startTime;
			if (state.firstOutputTime !== undefined) state.output.ttft = state.firstOutputTime - startTime;
			stream.push({ type: "error", reason: result.stopReason, error: state.output });
			stream.end();
		}
	})().catch(error => stream.fail(error));
	return stream;
}
