import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { logger } from "@oh-my-pi/pi-utils";
import { captureRequestHeaders, resolvePromptCacheKey } from "../auth-gateway/http";
import * as AIError from "../error";
import type {
	AnthropicMessagePayload,
	AnthropicServerToolContent,
	AssistantMessage,
	AssistantMessageEventStream,
	DeveloperMessage,
	Message,
	RedactedThinkingContent,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";
import {
	type AnthropicAssistantContentBlock,
	type AnthropicMessage,
	type AnthropicSystem,
	type AnthropicTool,
	type AnthropicToolChoice,
	type AnthropicToolResultContent,
	type AnthropicUserContentBlock,
	anthropicMessagesRequestSchema,
} from "./anthropic-messages-server-schema";
import { isAnthropicServerToolHistoryBlock, THINKING_BINDING_CONTROLS_BETA } from "./anthropic-wire";

/**
 * Anthropic Messages API (https://docs.anthropic.com/en/api/messages) ↔ pi-ai
 * gateway translation. Inbound: foreign HTTP body → omp Context. Outbound:
 * omp AssistantMessage[Stream] → Anthropic-shaped JSON / SSE.
 */

import type { AuthGatewayStreamControl, AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";

export type { ParsedRequest };

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

type ImageContentPart = { type: "image"; data: string; mimeType: string };

// Dedup noise from unknown-block-type warnings. Module-scoped so the warn
// fires once per (category, type) pair across the lifetime of the process.
const WARNED_UNKNOWN_BLOCK_TYPES = new Set<string>();
function warnUnknownBlockType(category: "user" | "assistant", blockType: string): void {
	const key = `${category}:${blockType}`;
	if (WARNED_UNKNOWN_BLOCK_TYPES.has(key)) return;
	WARNED_UNKNOWN_BLOCK_TYPES.add(key);
	logger.warn("anthropic-messages: unknown content block flattened to text placeholder", {
		category,
		blockType,
	});
}

// pi-ai's `ImageContent` only carries base64 + mimeType. When the inbound
// uses `url` or `file_id` sources we surface a text placeholder so the
// downstream provider still sees a sane history; warn once per source kind.
const WARNED_NON_BASE64_IMAGE_SOURCES = new Set<string>();
function warnNonBase64ImageSource(sourceType: string): void {
	if (WARNED_NON_BASE64_IMAGE_SOURCES.has(sourceType)) return;
	WARNED_NON_BASE64_IMAGE_SOURCES.add(sourceType);
	logger.warn("anthropic-messages: image source surfaced as text placeholder (pi-ai ImageContent lacks URL channel)", {
		sourceType,
	});
}

// Compact, log-safe stringification for unknown content blocks. Keeps the
// placeholder informative without dumping multi-KB structures into history.
function describeUnknownBlock(block: { type: string }): string {
	try {
		const json = JSON.stringify(block);
		if (json !== undefined && json.length <= 200) return `[${block.type}: ${json}]`;
	} catch {
		// fall through
	}
	return `[${block.type}]`;
}

function buildSystemPrompt(raw: AnthropicSystem): string[] | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return raw.length > 0 ? [raw] : undefined;
	const parts = raw.map(block => block.text).filter(text => text.length > 0);
	return parts.length > 0 ? [parts.join("\n\n")] : undefined;
}

function makeUserMessage(parts: (TextContent | ImageContentPart)[], timestamp: number): UserMessage {
	return {
		role: "user",
		content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
		timestamp,
	};
}

function toolResultPartsFromBlocks(
	content: AnthropicToolResultContent[] | string | undefined,
): (TextContent | ImageContentPart)[] {
	if (content === undefined) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	const out: (TextContent | ImageContentPart)[] = [];
	for (const block of content) {
		if (block.type === "text") {
			out.push({ type: "text", text: block.text });
			continue;
		}
		// block.type === "image" — schema only accepts base64 sources.
		if (block.source.type === "base64") {
			out.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
		}
	}
	return out;
}

function walkUserContent(
	blocks: string | AnthropicUserContentBlock[],
	timestamp: number,
): (UserMessage | ToolResultMessage)[] {
	const messages: (UserMessage | ToolResultMessage)[] = [];
	const userParts: (TextContent | ImageContentPart)[] = [];
	const flush = () => {
		if (userParts.length === 0) return;
		messages.push(makeUserMessage(userParts.splice(0), timestamp));
	};
	if (typeof blocks === "string") {
		if (blocks.length > 0) userParts.push({ type: "text", text: blocks });
		flush();
		return messages;
	}
	for (const block of blocks) {
		if (block.type === "text") {
			userParts.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			// SDK's typed source covers base64+url; our schema also accepts the
			// forward-compat `file` variant. Narrow against a widened shape so
			// every variant is handled at runtime regardless of SDK lag.
			const source = block.source as {
				type: string;
				data?: string;
				media_type?: string;
				url?: string;
				file_id?: string;
			};
			if (source.type === "base64" && source.data && source.media_type) {
				userParts.push({ type: "image", data: source.data, mimeType: source.media_type });
			} else {
				warnNonBase64ImageSource(source.type);
				const ref =
					source.type === "url" ? (source.url ?? "") : source.type === "file" ? (source.file_id ?? "") : "";
				userParts.push({ type: "text", text: `[image: ${ref}]` });
			}
		} else if (block.type === "tool_result") {
			// Anthropic permits tool_result blocks to follow plain text/image
			// siblings in the same user message. pi-ai's history is a flat
			// sequence of typed messages, so flush the accumulated parts as a
			// separate UserMessage before emitting the ToolResultMessage.
			flush();
			messages.push({
				role: "toolResult",
				toolCallId: block.tool_use_id,
				// Anthropic tool_results don't carry the tool name; downstream can rehydrate.
				toolName: "",
				content: toolResultPartsFromBlocks(block.content as AnthropicToolResultContent[] | string | undefined),
				isError: block.is_error === true,
				timestamp,
			});
		} else {
			// Unknown variant (server_tool_use, mcp_*, document, web_search_tool_result,
			// container_upload, code_execution_*, …). Flatten to a text placeholder
			// so the downstream provider still gets a coherent transcript.
			const unknown = block as { type: string };
			warnUnknownBlockType("user", unknown.type);
			userParts.push({ type: "text", text: describeUnknownBlock(unknown) });
		}
	}
	flush();
	return messages;
}

function walkAssistantContent(
	blocks: string | AnthropicAssistantContentBlock[],
): (TextContent | ThinkingContent | RedactedThinkingContent | AnthropicServerToolContent | ToolCall)[] {
	const out: (TextContent | ThinkingContent | RedactedThinkingContent | AnthropicServerToolContent | ToolCall)[] = [];
	if (typeof blocks === "string") {
		if (blocks.length > 0) out.push({ type: "text", text: blocks });
		return out;
	}
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				out.push({ type: "text", text: block.text });
				break;
			case "thinking": {
				const tc: ThinkingContent = { type: "thinking", thinking: block.thinking };
				if (block.signature !== undefined) tc.thinkingSignature = block.signature;
				out.push(tc);
				break;
			}
			case "redacted_thinking":
				out.push({ type: "redactedThinking", data: block.data });
				break;
			case "tool_use":
				out.push({
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments:
						block.input && typeof block.input === "object" && !Array.isArray(block.input)
							? (block.input as Record<string, unknown>)
							: {},
				});
				break;
			case "server_tool_use":
			case "web_search_tool_result":
			case "tool_search_tool_result":
				if (isAnthropicServerToolHistoryBlock(block)) {
					// Anthropic requires supported server-tool call/results replayed
					// verbatim, so retain each opaque block instead of flattening it.
					out.push({ type: "anthropicServerTool", block: { ...block } });
				} else {
					// Other server tools use distinct result block types that omp
					// cannot yet replay atomically. Flatten both sides rather than
					// persisting a lone server_tool_use without its matching result.
					const unknown = block as { type: string };
					warnUnknownBlockType("assistant", unknown.type);
					out.push({ type: "text", text: describeUnknownBlock(unknown) });
				}
				break;
			default: {
				// Unknown assistant variant (mcp_tool_use, code_execution_*, …).
				// Flatten to a text placeholder; warn once per unknown type.
				const unknown = block as { type: string };
				warnUnknownBlockType("assistant", unknown.type);
				out.push({ type: "text", text: describeUnknownBlock(unknown) });
				break;
			}
		}
	}
	return out;
}

function walkTools(tools: AnthropicTool[] | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description ?? "",
		parameters: tool.input_schema as Record<string, unknown>,
		deferLoading: tool.defer_loading,
	}));
}

function mapToolChoice(choice: AnthropicToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (!choice) return undefined;
	switch (choice.type) {
		case "auto":
			return "auto";
		case "any":
			return "required";
		case "none":
			return "none";
		case "tool":
			return { name: choice.name };
	}
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" | "5m" };
type HasCacheControl = { cache_control?: AnthropicCacheControl };

function readCacheControl(value: unknown): AnthropicCacheControl | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const cc = (value as HasCacheControl).cache_control;
	if (!cc || typeof cc !== "object" || cc.type !== "ephemeral") return undefined;
	return cc;
}

/**
 * Anthropic clients annotate caching breakpoints per block via
 * `cache_control: { type: "ephemeral", ttl?: "1h"|"5m" }`. pi-ai's
 * `cacheRetention` is per-request, not per-block, and its anthropic provider
 * re-applies breakpoints itself on the rebuilt outbound wire. Scan every
 * block once and return the strongest retention requested: any `ttl: "1h"`
 * promotes the request to "long", anything else ephemeral maps to "short".
 */
function deriveCacheRetention(data: {
	system?: unknown;
	messages: readonly unknown[];
	tools?: readonly unknown[];
}): "short" | "long" | undefined {
	let strongest: "short" | "long" | undefined;
	const visit = (cc: AnthropicCacheControl | undefined): void => {
		if (!cc) return;
		if (cc.ttl === "1h") strongest = "long";
		else strongest ??= "short";
	};
	if (Array.isArray(data.system)) {
		for (const block of data.system) visit(readCacheControl(block));
	}
	for (const message of data.messages) {
		if (message === null || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) visit(readCacheControl(block));
	}
	if (data.tools) {
		for (const tool of data.tools) visit(readCacheControl(tool));
	}
	return strongest;
}

/**
 * Inbound `output_config.effort` wire literal → catalog `Effort` (1:1).
 * Values outside this table (none exist in the schema today) are ignored
 * rather than guessed at.
 */
function walkSystemMessage(message: AnthropicMessage, timestamp: number): DeveloperMessage {
	const text: TextContent[] = [];
	const toolChanges: NonNullable<AnthropicMessagePayload["toolChanges"]> = [];
	if (typeof message.content === "string") {
		if (message.content.length > 0) text.push({ type: "text", text: message.content });
	} else {
		for (const block of message.content) {
			if (block.type === "text") {
				if (block.text.length > 0) text.push({ type: "text", text: block.text });
			} else if (block.type === "tool_addition" || block.type === "tool_removal") {
				toolChanges.push({ type: block.type, name: block.tool.name });
			}
		}
	}
	const payload: AnthropicMessagePayload = {
		type: "anthropicMessage",
		clearAt: message.clear_at,
		effort: message.output_config?.effort ?? undefined,
		toolChanges: toolChanges.length > 0 ? toolChanges : undefined,
	};
	return {
		role: "developer",
		content: text,
		providerPayload: payload,
		timestamp,
	};
}

const REASONING_EFFORT_BY_WIRE: Partial<Record<string, Effort>> = {
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	const data = anthropicMessagesRequestSchema(body);
	if (data instanceof type.errors) {
		throw new AIError.ValidationError(`anthropic-messages: ${data.summary}`);
	}

	const now = Date.now();
	const messages: Message[] = [];
	for (const message of data.messages as AnthropicMessage[]) {
		if (message.role === "user") {
			for (const m of walkUserContent(message.content, now)) messages.push(m);
		} else if (message.role === "system") {
			messages.push(walkSystemMessage(message, now));
		} else {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: walkAssistantContent(message.content),
				api: "anthropic-messages",
				provider: "anthropic",
				model: data.model,
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: now,
			};
			messages.push(assistant);
		}
	}

	const options: ParsedRequest["options"] = {
		maxOutputTokens: data.max_tokens,
	};
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.top_k !== undefined) options.topK = data.top_k;
	if (data.stop_sequences) options.stopSequences = data.stop_sequences;
	const toolChoice = mapToolChoice(data.tool_choice as AnthropicToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	// `disable_parallel_tool_use === true` means the client wants the model to
	// emit at most one tool call per turn; map to pi-ai's negated boolean.
	// Leave undefined when the field is absent or explicitly `false` so we
	// don't override provider defaults.
	if (data.tool_choice?.disable_parallel_tool_use === true) {
		options.parallelToolCalls = false;
	}
	if (data.thinking) {
		if (data.thinking.type !== "disabled" && data.thinking.block_binding) {
			options.anthropicPrefixMismatchBehavior = data.thinking.block_binding.prefix_mismatch_behavior;
		}
		switch (data.thinking.type) {
			case "enabled":
				options.explicitThinkingBudgetTokens = data.thinking.budget_tokens;
				break;
			case "disabled":
				options.disableReasoning = true;
				break;
			case "adaptive":
				if (data.thinking.budget_tokens !== undefined) {
					options.explicitThinkingBudgetTokens = data.thinking.budget_tokens;
				}
				break;
		}
	}
	if (data.output_config?.task_budget) {
		options.taskBudget = data.output_config.task_budget;
	}
	if (data.output_config?.effort) {
		const mapped = REASONING_EFFORT_BY_WIRE[data.output_config.effort];
		if (mapped !== undefined) options.reasoning = mapped;
	}
	const cacheRetention = deriveCacheRetention(data);
	if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;
	// Anthropic clients commonly send `metadata: { user_id }`; forward verbatim
	// so downstream providers (and our anthropic-passthrough fast-path) can
	// preserve abuse-tracking signal.
	if (data.metadata !== undefined) {
		options.metadata = data.metadata as Record<string, unknown>;
	}
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	// Allow-listed header capture. The gateway's `handleFormatEndpoint`
	// already merges its own pre-capture under whatever the parser sets, but
	// we populate here too so direct callers of `parseRequest` (tests, custom
	// wrappers) see the same surface. `anthropic-version` is the most
	// load-bearing — some downstream Anthropic-API targets reject requests
	// missing it.
	if (headers) {
		const captured = captureRequestHeaders(headers);
		if (Object.keys(captured).length > 0) options.headers = captured;
	}

	return {
		modelId: data.model,
		context: {
			systemPrompt: buildSystemPrompt(data.system as AnthropicSystem),
			messages,
			tools: walkTools(data.tools as AnthropicTool[] | undefined),
		},
		stream: data.stream === true,
		options,
	};
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ---------------------------------------------------------------------------
// Outbound encoding
// ---------------------------------------------------------------------------

function newMessageId(): string {
	const hex = (globalThis.crypto?.randomUUID?.() ?? randomFallback()).replace(/-/g, "").slice(0, 24);
	return `msg_${hex}`;
}

function randomFallback(): string {
	// Sufficient for tests / environments without crypto.randomUUID
	const buf = new Uint8Array(16);
	for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
	const hex = Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapStopReasonOut(reason: StopReason): "end_turn" | "max_tokens" | "tool_use" {
	switch (reason) {
		case "length":
			return "max_tokens";
		case "toolUse":
			return "tool_use";
		default:
			return "end_turn";
	}
}

function encodeContentBlocks(message: AssistantMessage): Record<string, unknown>[] {
	const blocks: Record<string, unknown>[] = [];
	for (const c of message.content) {
		switch (c.type) {
			case "text":
				blocks.push({ type: "text", text: c.text });
				break;
			case "thinking": {
				const b: Record<string, unknown> = { type: "thinking", thinking: c.thinking };
				if (c.thinkingSignature) b.signature = c.thinkingSignature;
				blocks.push(b);
				break;
			}
			case "redactedThinking":
				blocks.push({ type: "redacted_thinking", data: c.data });
				break;
			case "anthropicServerTool":
				blocks.push(c.block);
				break;
			case "toolCall":
				blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
				break;
		}
	}
	return blocks;
}

function encodeUsage(message: AssistantMessage): Record<string, unknown> {
	return {
		input_tokens: message.usage.input,
		output_tokens: message.usage.output,
		cache_read_input_tokens: message.usage.cacheRead,
		cache_creation_input_tokens: message.usage.cacheWrite,
	};
}

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new AIError.ProviderResponseError(
			message.errorMessage ?? `anthropic-messages: upstream ${message.stopReason}`,
			{
				provider: "anthropic",
				kind: "output",
			},
		);
	}
	return {
		id: message.responseId ?? newMessageId(),
		type: "message",
		role: "assistant",
		model: requestedModelId,
		content: encodeContentBlocks(message),
		stop_reason: mapStopReasonOut(message.stopReason),
		// TODO: surface the matched stop sequence once pi-ai's
		// `AssistantMessage.stopReason` carries the matched string. Intentionally
		// `null` for now (Anthropic schema allows it).
		stop_sequence: null,
		...(message.inputTransformations ? { input_transformations: message.inputTransformations } : {}),
		usage: encodeUsage(message),
	};
}

// ---------------------------------------------------------------------------
// Streaming encoder
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

function sseFrame(event: string, data: Record<string, unknown>): Uint8Array {
	return ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

type BlockKind = "text" | "thinking" | "tool_use";

interface OpenBlock {
	index: number;
	kind: BlockKind;
}

// Keepalive cadence for the SSE encoder. Anthropic's API pings periodically;
// without frames between message_start and the first content block (slow first
// token) SDK first-event/idle watchdogs classify the stream as stalled.
const STREAM_PING_INTERVAL_MS = 15_000;

const ZERO_WIRE_USAGE: Record<string, unknown> = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
};

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	options?: ParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	let pingTimer: NodeJS.Timeout | undefined;
	const bindingControlsRequested =
		options?.headers?.["anthropic-beta"]?.split(",").some(beta => beta.trim() === THINKING_BINDING_CONTROLS_BETA) ??
		false;
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });
	const stopPings = () => {
		if (pingTimer !== undefined) {
			clearInterval(pingTimer);
			pingTimer = undefined;
		}
	};
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const messageId = newMessageId();
			let started = false;
			const open = new Map<number, OpenBlock>();

			const ensureStart = (partial: AssistantMessage | undefined) => {
				if (started) return;
				started = true;
				controller.enqueue(
					sseFrame("message_start", {
						type: "message_start",
						message: {
							id: messageId,
							type: "message",
							role: "assistant",
							model: requestedModelId,
							content: [],
							stop_reason: null,
							// TODO: same as encodeResponse — surface matched stop sequence
							// once pi-ai propagates it.
							stop_sequence: null,
							...(bindingControlsRequested
								? { input_transformations: partial?.inputTransformations ?? [] }
								: {}),
							usage: partial ? encodeUsage(partial) : ZERO_WIRE_USAGE,
						},
					}),
				);
			};

			let nextContentIndexToInspect = 0;
			const emitServerToolBlocksBefore = (message: AssistantMessage, beforeIndex: number) => {
				const limit = Math.min(beforeIndex, message.content.length);
				while (nextContentIndexToInspect < limit) {
					const index = nextContentIndexToInspect++;
					const content = message.content[index];
					if (content?.type !== "anthropicServerTool") continue;
					ensureStart(message);
					controller.enqueue(
						sseFrame("content_block_start", {
							type: "content_block_start",
							index,
							content_block: content.block,
						}),
					);
					controller.enqueue(sseFrame("content_block_stop", { type: "content_block_stop", index }));
				}
			};

			const closeBlock = (index: number) => {
				if (!open.has(index)) return;
				controller.enqueue(sseFrame("content_block_stop", { type: "content_block_stop", index }));
				open.delete(index);
			};

			pingTimer = setInterval(() => {
				try {
					if (cancelled) {
						stopPings();
						return;
					}
					controller.enqueue(sseFrame("ping", { type: "ping" }));
				} catch {
					// Controller already closed/errored (client gone); stop the timer.
					stopPings();
				}
			}, STREAM_PING_INTERVAL_MS);

			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const ev of events) {
					if (cancelled) return;
					switch (ev.type) {
						case "start":
							ensureStart(ev.partial);
							break;
						case "text_start": {
							emitServerToolBlocksBefore(ev.partial, ev.contentIndex);
							ensureStart(ev.partial);
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "text" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: { type: "text", text: "" },
								}),
							);
							break;
						}
						case "text_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "text_delta", text: ev.delta },
								}),
							);
							break;
						case "text_end":
							closeBlock(ev.contentIndex);
							break;
						case "thinking_start": {
							emitServerToolBlocksBefore(ev.partial, ev.contentIndex);
							ensureStart(ev.partial);
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "thinking" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: { type: "thinking", thinking: "" },
								}),
							);
							break;
						}
						case "thinking_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "thinking_delta", thinking: ev.delta },
								}),
							);
							break;
						case "thinking_end": {
							const c = ev.partial.content[ev.contentIndex];
							if (c?.type === "thinking" && c.thinkingSignature) {
								controller.enqueue(
									sseFrame("content_block_delta", {
										type: "content_block_delta",
										index: ev.contentIndex,
										delta: { type: "signature_delta", signature: c.thinkingSignature },
									}),
								);
							}
							closeBlock(ev.contentIndex);
							break;
						}
						case "toolcall_start": {
							emitServerToolBlocksBefore(ev.partial, ev.contentIndex);
							ensureStart(ev.partial);
							const tc = ev.partial.content[ev.contentIndex] as ToolCall | undefined;
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "tool_use" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: {
										type: "tool_use",
										id: tc?.id ?? "",
										name: tc?.name ?? "",
										input: {},
									},
								}),
							);
							break;
						}
						case "toolcall_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "input_json_delta", partial_json: ev.delta },
								}),
							);
							break;
						case "toolcall_end":
							closeBlock(ev.contentIndex);
							break;
						case "done": {
							for (const idx of Array.from(open.keys())) closeBlock(idx);
							emitServerToolBlocksBefore(ev.message, ev.message.content.length);
							controller.enqueue(
								sseFrame("message_delta", {
									type: "message_delta",
									// TODO: surface matched stop sequence once pi-ai
									// propagates it on the `done` event.
									delta: {
										stop_reason: mapStopReasonOut(ev.reason),
										stop_sequence: null,
									},
									...(bindingControlsRequested
										? { input_transformations: ev.message.inputTransformations ?? [] }
										: {}),
									usage: encodeUsage(ev.message),
								}),
							);
							controller.enqueue(sseFrame("message_stop", { type: "message_stop" }));
							controller.close();
							return;
						}
						case "error": {
							const msg = ev.error.errorMessage ?? "stream error";
							controller.enqueue(
								sseFrame("error", { type: "error", error: { type: "api_error", message: msg } }),
							);
							controller.close();
							return;
						}
					}
				}
				// Stream ended without an explicit done: emit a complete envelope
				// (message_start + message_delta carrying a stop_reason) so strict
				// clients don't reject the response as a protocol error.
				ensureStart(undefined);
				for (const idx of Array.from(open.keys())) closeBlock(idx);
				controller.enqueue(
					sseFrame("message_delta", {
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: ZERO_WIRE_USAGE,
					}),
				);
				controller.enqueue(sseFrame("message_stop", { type: "message_stop" }));
				controller.close();
			} catch (err) {
				if (!cancelled) {
					controller.enqueue(
						sseFrame("error", {
							type: "error",
							error: { type: "api_error", message: err instanceof Error ? err.message : String(err) },
						}),
					);
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
				stopPings();
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
			stopPings();
		},
	});
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Anthropic error envelope: `{ type: "error", error: { type, message } }`.
 * See https://docs.anthropic.com/en/api/errors. Returned as a `Response` so
 * the gateway can hand it straight back to the client without extra wrapping.
 */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
