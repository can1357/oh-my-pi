import { fetchWithRetry, parseStreamingJson, readJsonl } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolChoice,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { clearStreamingPartialJson, kStreamingPartialJson } from "../utils/block-symbols";
import { withReplaySafeStreamRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
} from "../utils/idle-iterator";
import { sanitizeSchemaForOllama, toolWireSchema } from "../utils/schema";
import {
	getStreamMarkupHealingPattern,
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, partitionVisionContent } from "./vision-guard";

export interface OllamaChatOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
}

type OllamaFunctionTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
};

type OllamaMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: string[];
	thinking?: string;
	tool_calls?: Array<{
		type: "function";
		function: {
			index?: number;
			name: string;
			arguments: Record<string, unknown>;
		};
	}>;
	tool_name?: string;
};

type OllamaChatChunk = {
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		tool_calls?: Array<{
			type?: string;
			function?: {
				index?: number;
				name?: string;
				arguments?: Record<string, unknown> | string;
			};
		}>;
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
};

type InternalToolCallBlock = AssistantMessage["content"][number] & {
	type: "toolCall";
	[kStreamingPartialJson]?: string;
};

function normalizeBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "https://ollama.com";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

type OllamaThinkValue = boolean | "low" | "medium" | "high" | "max" | undefined;

function mapReasoning(
	model: Model<"ollama-chat">,
	reasoning: OllamaChatOptions["reasoning"],
	disableReasoning: boolean | undefined,
): OllamaThinkValue {
	const modelReasoning = model.reasoning;
	if (disableReasoning && modelReasoning) {
		return false;
	}
	const mappedReasoning =
		model.provider === "ollama-cloud" && reasoning
			? (model.thinking?.effortMap?.[reasoning] ?? reasoning)
			: reasoning;
	switch (mappedReasoning) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "max":
			return "max";
		case "xhigh":
			return "high";
		default:
			return undefined;
	}
}

function mapToolChoice(toolChoice: ToolChoice | undefined): "auto" | "none" | "required" | undefined {
	if (!toolChoice || toolChoice === "auto") {
		return undefined;
	}
	if (toolChoice === "none") {
		return "none";
	}
	if (toolChoice === "required" || toolChoice === "any") {
		return "required";
	}
	if (typeof toolChoice === "object" && toolChoice.type === "computer") return undefined;
	if (typeof toolChoice === "object") {
		return "required";
	}
	return undefined;
}

function getNamedToolChoiceName(toolChoice: ToolChoice | undefined): string | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return undefined;
	}
	if (toolChoice.type === "computer") return undefined;
	if ("function" in toolChoice) {
		return toolChoice.function.name;
	}
	return toolChoice.name;
}

function selectToolsForToolChoice(tools: Tool[] | undefined, toolChoice: ToolChoice | undefined): Tool[] | undefined {
	const toolName = getNamedToolChoiceName(toolChoice);
	if (!toolName || !tools) {
		return tools;
	}
	for (const tool of tools) {
		if (tool.name === toolName) {
			return [tool];
		}
	}
	return [];
}

function toPlainContent(
	content: string | ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	content: string;
	images?: string[];
} {
	if (typeof content === "string") {
		return { content };
	}
	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const text = textBlocks.map(block => block.text).join("\n");
	return {
		content: joinTextWithImagePlaceholder(text, omittedImages),
		...(imageBlocks.length > 0 ? { images: imageBlocks.map(block => block.data) } : {}),
	};
}

function convertMessage(
	message: Message,
	supportsImages: boolean,
	developerRole: "system" | "user" = "user",
): OllamaMessage {
	if (message.role === "user") {
		const converted = toPlainContent(message.content, supportsImages);
		return { role: "user", ...converted };
	}
	if (message.role === "developer") {
		const converted = toPlainContent(message.content, supportsImages);
		return { role: developerRole, ...converted };
	}
	if (message.role === "toolResult") {
		const converted = toPlainContent(message.content, supportsImages);
		return {
			role: "tool",
			tool_name: message.toolName,
			...converted,
		};
	}
	const text: string[] = [];
	const thinking: string[] = [];
	const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
	for (const block of message.content) {
		if (block.type === "text") {
			text.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			thinking.push(block.thinking);
			continue;
		}
		if (block.type === "toolCall") {
			toolCalls.push({
				type: "function",
				function: {
					name: block.name,
					arguments: block.arguments,
				},
			});
		}
	}
	return {
		role: "assistant",
		content: text.join("\n"),
		...(thinking.length > 0 ? { thinking: thinking.join("\n") } : {}),
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	};
}

function convertMessages(model: Model<"ollama-chat">, context: Context): OllamaMessage[] {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const systemMessages: Message[] = systemPrompts.map(systemPrompt => ({
		role: "developer",
		content: systemPrompt,
		timestamp: Date.now(),
	}));
	const messages: Message[] = [...systemMessages, ...context.messages];
	const isCloud = model.provider === "ollama-cloud";
	const supportsImages = model.input.includes("image");
	const converted = transformMessages(messages, model).map((msg, index) => {
		// Real `systemPrompt` entries (always emitted first) stay on Ollama's
		// `system` role. After the static prefix, a developer turn keeps `system`
		// when it's an agent-owned control instruction (empty/unexpected-stop
		// retries, checkpoint rewind warning, todo reminders — all carry
		// `attribution: "agent"`), but a user-attributed developer turn (auto-learn
		// capture nudge, advisor cards, file-mention companions) drops to `user`.
		// That keeps the in-conversation byte prefix stable for prefix caches
		// (llama.cpp, #3456) without demoting mandatory agent reminders.
		const developerRole =
			msg.role === "developer" && (index < systemPrompts.length || msg.attribution !== "user") ? "system" : "user";
		const converted = convertMessage(msg, supportsImages, developerRole);
		// Ollama cloud rejects requests when assistant history messages contain the `thinking`
		// field — it's valid in model responses but not accepted as a history input. Strip it
		// to prevent HTTP 400 errors. Local Ollama instances are unaffected.
		if (isCloud && converted.role === "assistant" && converted.thinking) {
			const { thinking: _t, ...rest } = converted;
			return rest;
		}
		return converted;
	});
	// Ollama returns `done_reason: "load"` and generates nothing when a request
	// carries no `user`-role message (e.g. a plan-approval handoff into a fresh
	// session whose only non-system turn is an agent-attributed developer message
	// mapped to `system`). Demote the last non-prefix system turn to `user` so the
	// request can actually produce output; the static system-prompt prefix stays
	// on `system` for prefix caching. (#7465)
	if (!converted.some(m => m.role === "user")) {
		for (let i = converted.length - 1; i >= systemPrompts.length; i--) {
			if (converted[i].role === "system") {
				converted[i].role = "user";
				break;
			}
		}
	}
	return converted;
}

function convertTools(tools: Tool[] | undefined): OllamaFunctionTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map(tool => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: sanitizeSchemaForOllama(toolWireSchema(tool)),
		},
	}));
}

/**
 * Ollama Cloud rejects `num_predict` above this value with HTTP 400
 * (`max_tokens (...) exceeds model's maximum output tokens (65536)`).
 * The cap currently applies uniformly to cloud-served models; the cloud-side
 * limit was confirmed empirically against `deepseek-v4-pro`/`-flash` and is
 * the same cap surfaced for every other Ollama Cloud model we've probed.
 *
 * Acts as a wire-level safety net so stale `models.db` rows (or custom
 * `modelOverrides` re-enabling `num_predict`) cannot 400 the request — even
 * when `model.omitMaxOutputTokens` was never applied. See #3392.
 */
const OLLAMA_CLOUD_NUM_PREDICT_CAP = 65_536;

function resolveNumPredict(model: Model<"ollama-chat">, requested: number): number {
	if (model.provider === "ollama-cloud") {
		return Math.min(requested, OLLAMA_CLOUD_NUM_PREDICT_CAP);
	}
	return requested;
}

function createChatBody(model: Model<"ollama-chat">, context: Context, options: OllamaChatOptions | undefined) {
	const think = mapReasoning(model, options?.reasoning, options?.disableReasoning);
	const toolChoice = mapToolChoice(options?.toolChoice);
	const selectedTools = selectToolsForToolChoice(context.tools, options?.toolChoice);
	const tools = convertTools(selectedTools);
	const runtimeOptions: { num_predict?: number; temperature?: number; top_p?: number } = {};
	let hasRuntimeOptions = false;
	if (options?.maxTokens !== undefined && !model.omitMaxOutputTokens) {
		runtimeOptions.num_predict = resolveNumPredict(model, options.maxTokens);
		hasRuntimeOptions = true;
	}
	if (options?.temperature !== undefined) {
		runtimeOptions.temperature = options.temperature;
		hasRuntimeOptions = true;
	}
	if (options?.topP !== undefined) {
		runtimeOptions.top_p = options.topP;
		hasRuntimeOptions = true;
	}
	return {
		model: model.id,
		messages: convertMessages(model, context),
		...(tools ? { tools } : {}),
		...(think !== undefined ? { think } : {}),
		...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
		...(hasRuntimeOptions ? { options: runtimeOptions } : {}),
		stream: true,
	};
}

function shouldRetryOllamaResponse(response: Response, bodyText: string): boolean {
	return response.status < 500 || !AIError.LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(bodyText);
}

async function captureHttpErrorResponse(response: Response): Promise<CapturedHttpErrorResponse> {
	let bodyText: string | undefined;
	let bodyJson: unknown;
	try {
		bodyText = await response.text();
		if (bodyText.trim()) {
			try {
				bodyJson = JSON.parse(bodyText) as unknown;
			} catch {}
		}
	} catch {}
	return {
		status: response.status,
		headers: response.headers,
		bodyText,
		bodyJson,
	};
}

function createEmptyOutput(model: Model<"ollama-chat">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "ollama-chat" as Api,
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
		timestamp: Date.now(),
	};
}

function endThinkingBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
	}
}

function endTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "text") {
		stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
	}
}

function endToolCallBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type !== "toolCall") {
		return;
	}
	const toolCall = block as InternalToolCallBlock;
	if (toolCall[kStreamingPartialJson]) {
		toolCall.arguments = parseStreamingJson<Record<string, unknown>>(toolCall[kStreamingPartialJson]);
		clearStreamingPartialJson(toolCall);
	}
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
}

function mapDoneReason(doneReason: string | undefined, output: AssistantMessage): AssistantMessage["stopReason"] {
	if (doneReason === "length") {
		return "length";
	}
	if (doneReason === "tool_calls") {
		return "toolUse";
	}
	if (doneReason === "load") {
		// Ollama emits done_reason:"load" (model loaded, nothing generated) when a
		// request has no user-role turn. Surface it as an error rather than a clean
		// empty stop so it isn't laundered and retried behind a misleading hint. (#7465)
		return "error";
	}
	if (doneReason === undefined && output.content.some(block => block.type === "toolCall")) {
		return "toolUse";
	}
	return "stop";
}

const EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE =
	"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.";
const EMPTY_OLLAMA_LOAD_COMPLETION_MESSAGE =
	"Ollama loaded the model but generated nothing (done_reason: load): the request contained no user-role message.";

function hasVisibleAssistantContent(output: AssistantMessage): boolean {
	return output.content.some(block => {
		if (block.type === "text") return block.text.trim().length > 0;
		if (block.type === "thinking") return block.thinking.trim().length > 0;
		return block.type === "toolCall";
	});
}

const OLLAMA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

const streamOllamaOnce = (
	model: Model<"ollama-chat">,
	context: Context,
	options: OllamaChatOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const output = createEmptyOutput(model);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let capturedErrorResponse: CapturedHttpErrorResponse | undefined;
		let activeThinkingIndex: number | undefined;
		let activeTextIndex: number | undefined;
		const activeToolIndices = new Set<number>();
		const streamMarkupHealingPattern = getStreamMarkupHealingPattern(model);
		const streamMarkupHealing = streamMarkupHealingPattern
			? new StreamMarkupHealing({ pattern: streamMarkupHealingPattern })
			: undefined;
		let healedToolCallEmitted = false;
		// Once the provider streams native reasoning (`message.thinking`), drop any
		// thinking the text-channel healer also recovers so a model that emits both
		// does not double-count its reasoning.
		let suppressHealedThinking = false;
		const endActiveTextBlock = (): void => {
			if (activeTextIndex === undefined) return;
			endTextBlock(stream, output, activeTextIndex);
			activeTextIndex = undefined;
		};
		const endActiveThinkingBlock = (): void => {
			if (activeThinkingIndex === undefined) return;
			endThinkingBlock(stream, output, activeThinkingIndex);
			activeThinkingIndex = undefined;
		};
		const appendVisibleText = (text: string): void => {
			if (text.length === 0) return;
			endActiveThinkingBlock();
			if (activeTextIndex === undefined) {
				output.content.push({ type: "text", text: "" });
				activeTextIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: output });
			}
			const block = output.content[activeTextIndex];
			if (block?.type === "text") {
				block.text += text;
				stream.push({
					type: "text_delta",
					contentIndex: activeTextIndex,
					delta: text,
					partial: output,
				});
			}
			if (!firstTokenTime) firstTokenTime = performance.now();
		};
		const appendVisibleThinking = (thinking: string): void => {
			if (thinking.length === 0) return;
			endActiveTextBlock();
			if (activeThinkingIndex === undefined) {
				output.content.push({ type: "thinking", thinking: "" });
				activeThinkingIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
			}
			const block = output.content[activeThinkingIndex];
			if (block?.type === "thinking") {
				block.thinking += thinking;
				stream.push({
					type: "thinking_delta",
					contentIndex: activeThinkingIndex,
					delta: thinking,
					partial: output,
				});
			}
			if (!firstTokenTime) firstTokenTime = performance.now();
		};
		const emitHealedToolCall = (call: HealedToolCall): void => {
			endActiveThinkingBlock();
			endActiveTextBlock();
			const toolCall: InternalToolCallBlock = {
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: parseStreamingJson<Record<string, unknown>>(call.arguments),
				[kStreamingPartialJson]: call.arguments,
			};
			output.content.push(toolCall);
			const index = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: call.arguments,
				partial: output,
			});
			endToolCallBlock(stream, output, index);
			healedToolCallEmitted = true;
			if (!firstTokenTime) firstTokenTime = performance.now();
		};
		const emitHealingEvent = (event: StreamMarkupHealingEvent): void => {
			if (event.type === "text") {
				appendVisibleText(event.text);
			} else if (event.type === "thinking") {
				if (!suppressHealedThinking) appendVisibleThinking(event.thinking);
			} else {
				emitHealedToolCall(event.call);
			}
		};
		const drainHealedToolCalls = (): void => {
			if (!streamMarkupHealing) return;
			for (const call of streamMarkupHealing.drainCompleted()) emitHealedToolCall(call);
		};
		try {
			const apiKey = options.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(model.provider);
			}
			const baseUrl = normalizeBaseUrl(model.baseUrl);
			let body = createChatBody(model, context, options);
			const replacementPayload = await options.onPayload?.(body, model);
			if (replacementPayload !== undefined) {
				body = replacementPayload as typeof body;
			}
			rawRequestDump = {
				provider: model.provider,
				api: model.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl}/api/chat`,
				body,
			};
			// Direct callers that bypass `register-builtins` (which installs
			// the iterator-level watchdog) need a pre-response timer alongside
			// `timeout: false`; otherwise an Ollama server that accepts the
			// POST and never streams headers would hang forever (issue #2422).
			const idleTimeoutMs = options.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			const firstEventTimeoutMs =
				options.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			// Cleared the instant headers arrive (below) so the pre-response timer
			// never aborts the actively streaming body — an absolute
			// `AbortSignal.timeout` would (issue #2422).
			const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
			let response: Response;
			try {
				response = await fetchWithRetry(`${baseUrl}/api/chat`, {
					method: "POST",
					headers: {
						...model.headers,
						...options.headers,
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
					signal: watchdog.signal,
					defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
					shouldRetryResponse: shouldRetryOllamaResponse,
					fetch: options.fetch,
					timeout: false,
				});
			} finally {
				watchdog.clear();
			}
			if (!response.ok) {
				capturedErrorResponse = await captureHttpErrorResponse(response);
				throw new AIError.OllamaApiError(`HTTP ${response.status} from ${baseUrl}/api/chat`, response.status, {
					headers: response.headers,
				});
			}
			if (!response.body) {
				throw new AIError.OllamaApiError("Ollama returned an empty response body", response.status, {
					headers: response.headers,
				});
			}
			stream.push({ type: "start", partial: output });
			for await (const chunk of readJsonl<OllamaChatChunk>(response.body)) {
				if (chunk.message?.thinking) {
					suppressHealedThinking = true;
					endActiveTextBlock();
					if (activeThinkingIndex === undefined) {
						output.content.push({ type: "thinking", thinking: "" });
						activeThinkingIndex = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
					}
					const block = output.content[activeThinkingIndex];
					if (block?.type === "thinking") {
						block.thinking += chunk.message.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: activeThinkingIndex,
							delta: chunk.message.thinking,
							partial: output,
						});
					}
					if (!firstTokenTime) {
						firstTokenTime = performance.now();
					}
				}
				const chunkContent = chunk.message?.content;
				const structuredCalls = chunk.message?.tool_calls?.length ? chunk.message.tool_calls : undefined;
				if (chunkContent) {
					if (streamMarkupHealing) {
						const healingEvents = structuredCalls
							? streamMarkupHealing.feedEventsWithoutCalls(chunkContent)
							: streamMarkupHealing.feedEvents(chunkContent);
						for (const event of healingEvents) {
							emitHealingEvent(event);
						}
					} else {
						appendVisibleText(chunkContent);
					}
				}
				if (structuredCalls) {
					endActiveThinkingBlock();
					endActiveTextBlock();
					for (const call of structuredCalls) {
						const name = call.function?.name ?? "unknown_tool";
						const rawArgs = call.function?.arguments;
						const partialJson = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
						const toolCall: InternalToolCallBlock = {
							type: "toolCall",
							id: `ollama:${output.content.length}:${name}`,
							name,
							arguments: parseStreamingJson<Record<string, unknown>>(partialJson),
							[kStreamingPartialJson]: partialJson,
						};
						output.content.push(toolCall);
						const index = output.content.length - 1;
						activeToolIndices.add(index);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: partialJson,
							partial: output,
						});
						if (!firstTokenTime) {
							firstTokenTime = performance.now();
						}
					}
				}
				if (chunk.done) {
					if (streamMarkupHealing) {
						for (const event of streamMarkupHealing.flushEvents()) {
							emitHealingEvent(event);
						}
						drainHealedToolCalls();
					}
					endActiveThinkingBlock();
					endActiveTextBlock();
					for (const index of activeToolIndices) {
						endToolCallBlock(stream, output, index);
					}
					activeToolIndices.clear();
					output.stopReason = mapDoneReason(chunk.done_reason, output);
					if (healedToolCallEmitted && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
					output.usage.input = chunk.prompt_eval_count ?? 0;
					output.usage.output = chunk.eval_count ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output;
				}
			}
			if (streamMarkupHealing) {
				for (const event of streamMarkupHealing.flushEvents()) {
					emitHealingEvent(event);
				}
				drainHealedToolCalls();
				if (healedToolCallEmitted && output.stopReason === "stop") {
					output.stopReason = "toolUse";
				}
			}
			endActiveThinkingBlock();
			endActiveTextBlock();
			if (output.stopReason === "length" && !hasVisibleAssistantContent(output)) {
				output.stopReason = "error";
				output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
			}
			if (output.stopReason === "error" && !output.errorMessage) {
				output.errorMessage = EMPTY_OLLAMA_LOAD_COMPLETION_MESSAGE;
			}
			// Tool calls always mean "execute and continue" in the OpenAI/Ollama contract.
			// If the turn produced tool-call blocks but reported a natural `stop`, promote
			// to `toolUse` so the agent loop runs them (it gates execution on the stop
			// reason). `length`/`aborted`/`error` are intentionally left untouched.
			if (output.stopReason === "stop" && output.content.some(block => block.type === "toolCall")) {
				output.stopReason = "toolUse";
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) {
				output.ttft = firstTokenTime - startTime;
			}
			if (output.stopReason === "error") {
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
				return;
			}
			const doneReason =
				output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") {
					clearStreamingPartialJson(block);
				}
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				signal: options.signal,
				rawRequestDump,
				capturedErrorResponse,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) {
				output.ttft = firstTokenTime - startTime;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};

/** Retry EOS-only Ollama completions before the agent loop sees an empty stop. */
export const streamOllama: StreamFunction<"ollama-chat"> = (model, context, options) =>
	withReplaySafeStreamRetry(model, context, options, streamOllamaOnce, {
		retryEmptyCompletion: true,
	});
