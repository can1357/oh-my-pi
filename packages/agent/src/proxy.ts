/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type FetchImpl,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import {
	clearStreamingPartialJson,
	kStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import { parseStreamingJson, parseStreamingJsonThrottled, readSseJson } from "@oh-my-pi/pi-utils";

// Event stream adapter for proxy SSE events
export class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "image_end"; contentIndex: number; content: ImageContent }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
			content?: AssistantMessage["content"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
			content?: AssistantMessage["content"];
	  };

export interface ProxyStreamOptions extends SimpleStreamOptions {
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
	/** Optional fetch implementation; defaults to global fetch. */
	fetch?: FetchImpl;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
export function streamProxy(model: Model, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "stop",
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
			timestamp: Date.now(),
		};

		let response: Response | null = null;
		// Declared outside try so the disconnect path (catch) can finalize
		// still-buffered tool-call arguments before emitting the error event.
		const partialJsonByIndex = new Map<number, string>();
		const parsedLenByIndex = new Map<number, number>();
		const abortHandler = () => {
			const body = response?.body;
			if (body) {
				body.cancel("Request aborted by user").catch(() => {});
			}
		};
		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			response = await (options.fetch ?? fetch)(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: {
						temperature: options.temperature,
						topP: options.topP,
						topK: options.topK,
						minP: options.minP,
						presencePenalty: options.presencePenalty,
						repetitionPenalty: options.repetitionPenalty,
						maxTokens: options.maxTokens,
						reasoning: options.reasoning,
						thinkingMode: options.thinkingMode,
						anthropicThinkingMode: options.anthropicThinkingMode,
						disableReasoning: options.disableReasoning,
						forceReasoningOff: options.forceReasoningOff,
					},
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

			let sawTerminalEvent = false;
			for await (const event of readSseJson<ProxyAssistantMessageEvent>(
				response.body as ReadableStream<Uint8Array>,
				options.signal,
			)) {
				const parsedEvent = processProxyEvent(event, partial, partialJsonByIndex, parsedLenByIndex);
				if (parsedEvent) {
					if (parsedEvent.type === "done" || parsedEvent.type === "error") {
						sawTerminalEvent = true;
					}
					stream.push(parsedEvent);
				}
			}

			if (!sawTerminalEvent) {
				if (options.signal?.aborted) {
					const reason = options.signal.reason;
					throw reason instanceof Error ? reason : new Error(String(reason ?? "Request aborted"));
				}
				throw new Error("Proxy stream ended without a terminal event (done or error)");
			}

			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			// Disconnect/abort path: no terminal event ran, so trailing
			// throttled deltas never reached content.arguments. Finalize
			// them here so the persisted/retried transcript is complete.
			finalizeBufferedArguments(partial, partialJsonByIndex);
			scrubPartialJson(partial);
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * Clear the `partialJson` streaming symbol from any tool-call content blocks
 * that still carry it (e.g. when the stream ended without a `toolcall_end`), so
 * the finalized `AssistantMessage` no longer reads as still-streaming.
 */
function scrubPartialJson(partial: AssistantMessage): void {
	for (const block of partial.content) {
		if (block?.type === "toolCall") clearStreamingPartialJson(block);
	}
}

/**
 * Process a proxy event and update the partial message.
 *
 * Streaming `partialJson` for in-progress tool calls is accumulated in a
 * side-channel map keyed by `contentIndex` and also written onto the content
 * object as a symbol-keyed field so downstream renderers can read it
 * during streaming. The field is cleared at `toolcall_end` and scrubbed from any
 * remaining blocks at `done`/`error` so the finalized `AssistantMessage` never
 * reads as still-streaming.
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
	partialJsonByIndex: Map<number, string>,
	parsedLenByIndex: Map<number, number>,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			partial.content.length = 0;
			partial.usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			partial.errorMessage = undefined;
			partial.errorId = undefined;
			partial.duration = undefined;
			(partial as { stopReason?: string }).stopReason = undefined;
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "image_end":
			partial.content[proxyEvent.contentIndex] = proxyEvent.content;
			return {
				type: "image_end",
				contentIndex: proxyEvent.contentIndex,
				content: proxyEvent.content,
				partial,
			};

		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				[kStreamingPartialJson]: "",
			} as ToolCall & StreamingPartialJsonCarrier;
			partialJsonByIndex.set(proxyEvent.contentIndex, "");
			parsedLenByIndex.set(proxyEvent.contentIndex, 0);
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const acc = (partialJsonByIndex.get(proxyEvent.contentIndex) ?? "") + proxyEvent.delta;
				partialJsonByIndex.set(proxyEvent.contentIndex, acc);
				// Geometric throttle (same contract as native providers): the
				// authoritative parse lands at toolcall_end; mid-stream
				// previews refresh at most ~3% late on large buffers.
				const lastLen = parsedLenByIndex.get(proxyEvent.contentIndex) ?? 0;
				const parsed = parseStreamingJsonThrottled(acc, lastLen);
				if (parsed !== null) {
					content.arguments = parsed.value || {};
					parsedLenByIndex.set(proxyEvent.contentIndex, parsed.parsedLen);
				}
				setStreamingPartialJson(content, acc);
				partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				// Authoritative final parse (mirrors native providers): the
				// throttle may have skipped trailing deltas, so the last
				// parsed arguments can lag the accumulated buffer.
				const acc = partialJsonByIndex.get(proxyEvent.contentIndex);
				if (acc !== undefined && acc.length > 0) content.arguments = parseStreamingJson(acc) || {};
				partialJsonByIndex.delete(proxyEvent.contentIndex);
				parsedLenByIndex.delete(proxyEvent.contentIndex);
				clearStreamingPartialJson(content);
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			if (proxyEvent.content !== undefined) partial.content = proxyEvent.content;
			else finalizeBufferedArguments(partial, partialJsonByIndex);
			scrubPartialJson(partial);
			partialJsonByIndex.clear();
			parsedLenByIndex.clear();
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			if (proxyEvent.content !== undefined) partial.content = proxyEvent.content;
			else finalizeBufferedArguments(partial, partialJsonByIndex);
			scrubPartialJson(partial);
			partialJsonByIndex.clear();
			parsedLenByIndex.clear();
			return { type: "error", reason: proxyEvent.reason, error: partial };
	}
}

/**
 * Authoritatively parse every still-buffered tool-call argument accumulator
 * into its content block. Terminal `done`/`error` events without a preceding
 * `toolcall_end` (and with `content` omitted) finalize the partial message as
 *-is; without this, trailing deltas below the throttle gate never reach
 * `content.arguments` and the finalized call carries stale arguments.
 */
function finalizeBufferedArguments(partial: AssistantMessage, partialJsonByIndex: Map<number, string>): void {
	if (partialJsonByIndex.size === 0) return;
	for (const [index, acc] of partialJsonByIndex) {
		if (acc.length === 0) continue;
		const content = partial.content[index];
		if (content?.type === "toolCall") content.arguments = parseStreamingJson(acc) || {};
	}
}
