import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { resolvePromptCacheKey } from "../auth-gateway/http";
/**
 * Parsed inbound OpenAI chat-completions request, ready to feed into pi-ai
 * `stream(model, context, options)`.
 */
import type { AuthGatewayStreamControl, AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import * as AIError from "../error";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	ResolvedServiceTier,
	StopReason,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	TSchema,
} from "../types";
import {
	type OpenAIChatContentPart,
	type OpenAIChatMessage,
	type OpenAIChatTool,
	type OpenAIChatToolCall,
	type OpenAIChatToolChoice,
	openaiChatRequestSchema,
} from "./openai-chat-server-schema";

export type { ParsedRequest };

type ReasoningEffort = NonNullable<ParsedRequest["options"]["reasoning"]>;

function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isServiceTier(value: unknown): value is ResolvedServiceTier {
	return value === "auto" || value === "default" || value === "flex" || value === "scale" || value === "priority";
}

// ---------------------------------------------------------------------------
// parseRequest
// ---------------------------------------------------------------------------

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	// Header capture is centralized in `auth-gateway/server.ts` (allow-listed
	// headers like openai-organization/openai-project/openai-beta/x-stainless-*
	// land on `options.headers` automatically). We consult `headers` here too
	// for `resolvePromptCacheKey` to pull a cache identity out of inbound
	// vendor-neutral headers when the body doesn't carry one.
	const parsed = openaiChatRequestSchema(body);
	if (parsed instanceof type.errors) {
		throw new AIError.ValidationError(`openai-chat: ${parsed.summary}`);
	}
	const data = parsed;

	const now = Date.now();
	const systemParts: string[] = [];
	const messages: Message[] = [];
	// Map of `tool_call_id` → function name, populated as we walk assistant
	// turns. The OpenAI wire spec drops `name` from `role:"tool"` messages,
	// but downstream providers (notably Google: `functionResponse.name` is
	// required) need it. We back-resolve from the matching call. If the
	// client did send a wire `name` we still prefer that (forward-compat).
	const toolNamesById = new Map<string, string>();

	for (const m of data.messages as OpenAIChatMessage[]) {
		switch (m.role) {
			case "system": {
				const text = stringifyContent(m.content);
				if (text.length > 0) systemParts.push(text);
				break;
			}
			case "developer":
				messages.push({ role: "developer", content: parseUserLikeContent(m.content), timestamp: now });
				break;
			case "user":
				messages.push({ role: "user", content: parseUserLikeContent(m.content), timestamp: now });
				break;
			case "assistant":
				if (m.tool_calls) {
					for (const raw of m.tool_calls) {
						if (raw.type !== undefined && raw.type !== "function") continue;
						const fn = (raw as { function?: { name?: string } }).function;
						if (raw.id && fn?.name) toolNamesById.set(raw.id, fn.name);
					}
				}
				messages.push(
					buildAssistantMessage(
						(m.content ?? undefined) as string | OpenAIChatContentPart[] | undefined,
						m.tool_calls,
						(m as { reasoning_content?: string | null }).reasoning_content ?? undefined,
						data.model,
						now,
					),
				);
				break;
			case "tool": {
				// Prefer the wire `name` when present; otherwise back-resolve from
				// the assistant `tool_calls` map. Falls through to "" only when no
				// prior call shares this id, which is the well-known broken case.
				const wireName = (m as { name?: string }).name;
				const resolvedName = wireName ?? (m.tool_call_id ? toolNamesById.get(m.tool_call_id) : undefined);
				pushToolResultMessages(messages, m.content, m.tool_call_id, resolvedName, now);
				break;
			}
			case "function": {
				// Legacy `function` role (pre-tools API): the message carries the tool's
				// name on `name` and its output on `content`. Translate to a canonical
				// `toolResult` with a synthetic id (no original id on the wire).
				const fn = m as { role: "function"; name: string; content: string | null };
				pushToolResultMessages(messages, fn.content ?? "", undefined, fn.name, now);
				break;
			}
		}
	}

	const tools = data.tools ? buildTools(data.tools as OpenAIChatTool[]) : undefined;

	const context: Context = {
		messages,
		...(systemParts.length > 0 ? { systemPrompt: [systemParts.join("\n\n")] } : {}),
		...(tools ? { tools } : {}),
	};

	// Prefer max_completion_tokens (newer) over max_tokens.
	const maxOutputTokens = data.max_completion_tokens ?? data.max_tokens;
	const stopSequences = normalizeStop(data.stop);
	// Schema accepts the Anthropic-style {type:'tool', name} variant that the SDK
	// union doesn't model; the normalizer collapses it to a plain name lookup.
	const toolChoice = normalizeToolChoice(data.tool_choice as Parameters<typeof normalizeToolChoice>[0]);
	const includeStreamingUsage = data.stream_options?.include_usage === true;

	// `includeStreamingUsage` is the one genuinely-opaque flag — the streaming
	// encoder reads it later off `options.extra`. Everything else now lives on
	// a typed field; `extra` stays undefined when only typed values are set.
	const extra: Record<string, unknown> = {};
	let hasExtra = false;
	if (includeStreamingUsage) {
		extra.includeStreamingUsage = true;
		hasExtra = true;
	}

	const options: ParsedRequest["options"] = {};
	if (maxOutputTokens !== undefined) options.maxOutputTokens = maxOutputTokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (stopSequences) options.stopSequences = stopSequences;
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
	if (data.seed !== undefined) options.seed = data.seed;
	if (data.logit_bias !== undefined) options.logitBias = data.logit_bias;
	if (data.user !== undefined) options.user = data.user;
	if (data.response_format !== undefined) options.responseFormat = data.response_format;
	if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
	if (data.reasoning_effort !== undefined && isReasoningEffort(data.reasoning_effort)) {
		options.reasoning = data.reasoning_effort;
	}
	if (data.service_tier !== undefined && isServiceTier(data.service_tier)) {
		options.serviceTier = data.service_tier;
	}
	if (data.metadata !== undefined) options.metadata = data.metadata;
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	if (hasExtra) options.extra = extra;

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options,
	};
}

function stringifyContent(content: string | OpenAIChatContentPart[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	const out: string[] = [];
	for (const part of content) {
		if (part.type === "text") out.push(part.text);
	}
	return out.join("");
}

function parseUserLikeContent(
	content: string | OpenAIChatContentPart[] | undefined,
): string | (TextContent | ImageContent)[] {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	const parts: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "text") {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type !== "image_url") continue;
		// input_audio / file / refusal / unknown-type parts are accepted by the
		// schema for forward-compat but dropped here — pi-ai's canonical user
		// content only models text and image today.
		const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
		const decoded = decodeDataUri(url);
		if (decoded) {
			parts.push({ type: "image", data: decoded.data, mimeType: decoded.mimeType });
		} else {
			// No image fetcher available in the gateway; surface as a text placeholder so
			// downstream providers still receive a coherent message.
			parts.push({ type: "text", text: `[image: ${url}]` });
		}
	}
	return parts;
}

function decodeDataUri(url: string): { data: string; mimeType: string } | undefined {
	if (!url.startsWith("data:")) return undefined;
	const comma = url.indexOf(",");
	if (comma < 0) return undefined;
	const header = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isBase64 = header.endsWith(";base64");
	const mimeType = (isBase64 ? header.slice(0, -";base64".length) : header) || "application/octet-stream";
	const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");
	return { data, mimeType };
}

function buildAssistantMessage(
	content: string | OpenAIChatContentPart[] | undefined,
	toolCalls: OpenAIChatToolCall[] | undefined,
	reasoningContent: string | undefined,
	modelId: string,
	now: number,
): AssistantMessage {
	const parts: AssistantMessage["content"] = [];
	if (reasoningContent !== undefined && reasoningContent.length > 0) {
		// Replayed reasoning channel. The signature names the wire field so
		// completions providers that demand exact `reasoning_content` replay
		// (DeepSeek/Kimi) echo the model's actual reasoning back verbatim.
		parts.push({ type: "thinking", thinking: reasoningContent, thinkingSignature: "reasoning_content" });
	}
	const text = stringifyContent(content);
	if (text.length > 0) parts.push({ type: "text", text });
	if (toolCalls) {
		for (const raw of toolCalls) {
			// Schema only accepts type:"function" (or omitted); narrow the SDK
			// union here so the custom-tool variant doesn't trip TS.
			if (raw.type !== undefined && raw.type !== "function") continue;
			const fn = (raw as { function: { name: string; arguments: string } }).function;
			const argsStr = fn.arguments;
			let args: Record<string, unknown> = {};
			if (argsStr.length > 0) {
				try {
					const v: unknown = JSON.parse(argsStr);
					args =
						v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { __raw: argsStr };
				} catch {
					args = { __raw: argsStr };
				}
			}
			const call: ToolCall = { type: "toolCall", id: raw.id, name: fn.name, arguments: args };
			parts.push(call);
		}
	}
	return {
		role: "assistant",
		content: parts,
		api: "openai-completions",
		provider: "openai",
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: now,
	};
}

/**
 * Walk a wire `tool` (or legacy `function`) message into canonical messages.
 * Tool-result content may carry images alongside text; pi-ai's
 * `ToolResultMessage` accepts both, but most downstream providers ignore
 * images on tool results. To mirror Rust's `encode_messages` behavior we
 * keep text inside the tool-result message and hoist any image parts into a
 * follow-up `user` message so they still reach the model.
 */
function pushToolResultMessages(
	messages: Message[],
	content: string | OpenAIChatContentPart[] | undefined | null,
	toolCallId: string | undefined,
	toolName: string | undefined,
	now: number,
): void {
	const textParts: TextContent[] = [];
	const imageParts: ImageContent[] = [];

	if (typeof content === "string") {
		if (content.length > 0) textParts.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const part of content) {
			if (part.type === "text") {
				textParts.push({ type: "text", text: part.text });
				continue;
			}
			if (part.type !== "image_url") continue;
			const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
			const decoded = decodeDataUri(url);
			if (decoded) {
				imageParts.push({ type: "image", data: decoded.data, mimeType: decoded.mimeType });
			} else {
				// No fetcher available; degrade gracefully to a text placeholder.
				textParts.push({ type: "text", text: `[image: ${url}]` });
			}
		}
	}

	const toolMsg: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId ?? "",
		// OpenAI's `tool` role omits the tool name on the wire; the legacy
		// `function` role supplies it. Downstream providers tolerate empty.
		toolName: toolName ?? "",
		content: textParts.length > 0 ? textParts : [{ type: "text", text: "" }],
		isError: false,
		timestamp: now,
	};
	messages.push(toolMsg);

	if (imageParts.length > 0) {
		messages.push({
			role: "user",
			content: imageParts,
			timestamp: now,
		});
	}
}

function buildTools(tools: OpenAIChatTool[]): Tool[] | undefined {
	if (tools.length === 0) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		if (t.type !== "function") continue;
		out.push({
			name: t.function.name,
			description: t.function.description ?? "",
			parameters: (t.function.parameters ?? {}) as Record<string, unknown> as TSchema,
		});
	}
	return out;
}

function normalizeStop(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return [value];
	return value.length > 0 ? value : undefined;
}

function normalizeToolChoice(value: OpenAIChatToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "none" || value === "required") return value;
	if (typeof value === "object" && value !== null) {
		// OpenAI canonical: { type: 'function', function: { name } }
		if ("function" in value && value.function) return { name: value.function.name };
		// Anthropic-style passthrough (schema-allowed): { type: 'tool', name }
		const anthropicLike = value as unknown as { type?: string; name?: string };
		if (anthropicLike.type === "tool" && typeof anthropicLike.name === "string") {
			return { name: anthropicLike.name };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// encodeResponse (non-streaming)
// ---------------------------------------------------------------------------

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const { text, reasoning, toolCalls } = flattenAssistant(message);

	const responseMessage: Record<string, unknown> = {
		role: "assistant",
		content: text.length > 0 ? text : null,
		// pi-ai does not surface real refusals yet; emit `null` so SDKs that
		// probe `.refusal` see the documented field shape rather than missing.
		refusal: null,
	};
	if (reasoning.length > 0) {
		// DeepSeek-style / o-series reasoning channel.
		responseMessage.reasoning_content = reasoning;
	}
	if (toolCalls.length > 0) {
		responseMessage.tool_calls = toolCalls.map(tc => ({
			id: tc.id,
			type: "function",
			function: { name: tc.name, arguments: stringifyArgs(tc.arguments) },
		}));
	}

	return {
		id: makeId(),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: requestedModelId,
		// Real OpenAI always emits this key, even when the value is null. Mirror
		// the contract so probing SDKs do not throw on a missing field.
		system_fingerprint: null,
		choices: [
			{
				index: 0,
				message: responseMessage,
				finish_reason: mapFinishReason(message.stopReason, toolCalls.length > 0),
				logprobs: null,
			},
		],
		usage: buildUsage(message),
	};
}

function buildUsage(message: AssistantMessage): Record<string, unknown> {
	const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
	const usage: Record<string, unknown> = {
		prompt_tokens: promptTokens,
		completion_tokens: message.usage.output,
		total_tokens: promptTokens + message.usage.output,
		prompt_tokens_details: { cached_tokens: message.usage.cacheRead },
	};
	if (message.usage.reasoningTokens !== undefined) {
		usage.completion_tokens_details = { reasoning_tokens: message.usage.reasoningTokens };
	}
	return usage;
}

function flattenAssistant(message: AssistantMessage): {
	text: string;
	reasoning: string;
	toolCalls: ToolCall[];
} {
	let text = "";
	let reasoning = "";
	const toolCalls: ToolCall[] = [];
	for (const part of message.content) {
		switch (part.type) {
			case "text":
				text += part.text;
				break;
			case "thinking":
				reasoning += part.thinking;
				break;
			case "redactedThinking":
				// Opaque blob — surface verbatim on the reasoning channel so the
				// concatenation round-trips through clients that just echo it.
				reasoning += part.data;
				break;
			case "toolCall":
				toolCalls.push(part);
				break;
		}
	}
	return { text, reasoning, toolCalls };
}

function isOnlyRaw(args: Record<string, unknown>): boolean {
	for (const k in args) {
		if (k !== "__raw") return false;
	}
	return true;
}

function stringifyArgs(args: Record<string, unknown>): string {
	// `__raw` is our fallback marker for un-parseable inbound args; preserve it verbatim on the way out.
	if (typeof args.__raw === "string" && isOnlyRaw(args)) return args.__raw;
	try {
		return JSON.stringify(args);
	} catch {
		return "{}";
	}
}

function mapFinishReason(reason: StopReason, hasToolCalls: boolean): string {
	if (reason === "toolUse" || (hasToolCalls && reason === "stop")) return "tool_calls";
	if (reason === "length") return "length";
	// pi-ai's StopReason does not currently carry a content-filter signal;
	// when it does, map it to "content_filter" here.
	return "stop";
}

function makeId(): string {
	return `chatcmpl-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// encodeStream (SSE)
// ---------------------------------------------------------------------------

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	options?: ParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const id = makeId();
	const created = Math.floor(Date.now() / 1000);
	const includeUsage = options?.extra?.includeStreamingUsage === true;
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });

	const baseChunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model: requestedModelId,
		system_fingerprint: null,
		choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
		...(includeUsage ? { usage: null } : {}),
	});

	const writeSse = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown): void => {
		if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
	};

	const writeUsage = (controller: ReadableStreamDefaultController<Uint8Array>, message: AssistantMessage): void => {
		writeSse(controller, {
			id,
			object: "chat.completion.chunk",
			created,
			model: requestedModelId,
			system_fingerprint: null,
			choices: [],
			usage: buildUsage(message),
		});
	};

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			// contentIndex (from pi-ai events) -> tool_calls index on the wire.
			const toolIndexByContentIndex = new Map<number, number>();
			// wire index -> id/name emitted on the start chunk, to detect late-arriving
			// upstream id/name that needs a corrective chunk before the finish.
			const sentToolMeta = new Map<number, { id: string; name: string }>();
			let nextToolIndex = 0;
			let hasToolCalls = false;
			let finishReason: string = "stop";

			try {
				if (cancelled) {
					controller.close();
					return;
				}
				// Initial role chunk.
				writeSse(controller, baseChunk({ role: "assistant" }, null));

				for await (const event of events) {
					if (cancelled) return;
					switch (event.type) {
						case "text_delta":
							if (event.delta.length > 0) {
								writeSse(controller, baseChunk({ content: event.delta }, null));
							}
							break;

						case "thinking_delta":
							// DeepSeek-style / o-series reasoning channel. Clients that don't
							// understand it ignore the unknown delta key.
							if (event.delta.length > 0) {
								writeSse(controller, baseChunk({ reasoning_content: event.delta }, null));
							}
							break;

						case "toolcall_start": {
							hasToolCalls = true;
							const idx = nextToolIndex++;
							toolIndexByContentIndex.set(event.contentIndex, idx);
							const partial = event.partial.content[event.contentIndex];
							const call = partial && partial.type === "toolCall" ? partial : undefined;
							sentToolMeta.set(idx, { id: call?.id ?? "", name: call?.name ?? "" });
							writeSse(
								controller,
								baseChunk(
									{
										tool_calls: [
											{
												index: idx,
												id: call?.id ?? "",
												type: "function",
												function: { name: call?.name ?? "", arguments: "" },
											},
										],
									},
									null,
								),
							);
							break;
						}

						case "toolcall_delta": {
							const idx = toolIndexByContentIndex.get(event.contentIndex);
							if (idx === undefined) break;
							writeSse(
								controller,
								baseChunk({ tool_calls: [{ index: idx, function: { arguments: event.delta } }] }, null),
							);
							break;
						}

						case "toolcall_end": {
							const idx = toolIndexByContentIndex.get(event.contentIndex);
							if (idx === undefined) break;
							const sent = sentToolMeta.get(idx);
							if (sent === undefined) break;
							// Upstream completions providers can receive the real id/name in a
							// later chunk than toolcall_start. Emit a corrective chunk only when
							// the streamed value was empty: accumulating clients concatenate
							// string fields, so "" + value is the only safe correction.
							const correctId = sent.id === "" && event.toolCall.id !== "" ? event.toolCall.id : undefined;
							const correctName =
								sent.name === "" && event.toolCall.name !== "" ? event.toolCall.name : undefined;
							if (correctId !== undefined || correctName !== undefined) {
								writeSse(
									controller,
									baseChunk(
										{
											tool_calls: [
												{
													index: idx,
													...(correctId !== undefined ? { id: correctId } : {}),
													...(correctName !== undefined ? { function: { name: correctName } } : {}),
												},
											],
										},
										null,
									),
								);
							}
							break;
						}

						case "done":
							finishReason =
								event.reason === "toolUse"
									? "tool_calls"
									: event.reason === "length"
										? "length"
										: hasToolCalls
											? "tool_calls"
											: "stop";
							writeSse(controller, baseChunk({}, finishReason));
							if (includeUsage) writeUsage(controller, event.message);
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
							return;

						case "error": {
							const msg = event.error.errorMessage ?? "stream error";
							writeSse(controller, { error: { message: msg, type: "upstream_error" } });
							controller.close();
							return;
						}

						// Drop start / *_start and text/thinking *_end — chat-completions
						// wire only surfaces deltas and the terminal finish_reason.
						default:
							break;
					}
				}

				// Stream ended without a terminal `done` (defensive). Close gracefully.
				if (!cancelled) {
					writeSse(controller, baseChunk({}, hasToolCalls ? "tool_calls" : "stop"));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				}
			} catch (err) {
				if (!cancelled) {
					const msg = err instanceof Error ? err.message : String(err);
					writeSse(controller, { error: { message: msg, type: "upstream_error" } });
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
		},
	});
}

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

/**
 * OpenAI chat-completions error envelope:
 *   `{ error: { message, type } }`
 * Matches the shape the official SDK auto-parses into `APIError`.
 */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
