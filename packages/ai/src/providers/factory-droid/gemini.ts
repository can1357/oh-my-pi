import type { RequestPolicy } from "@oh-my-pi/pi-catalog/compat/types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { readSseJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { AssistantMessage, Context, Message, Model, StreamOptions, Tool, ToolCall } from "../../types";
import { createAbortSourceTracker } from "../../utils/abort";
import { AssistantMessageEventStream } from "../../utils/event-stream";
import {
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../../utils/idle-iterator";
import { notifyProviderResponse } from "../../utils/provider-response";
import { dereferenceJsonSchema, normalizeSchemaForFactoryDroid, toolWireSchema } from "../../utils/schema";
import {
	extractGoogleErrorMessage,
	googleStreamChunkError,
	mapGoogleUsage,
	mapStopReasonString,
	nextToolCallId,
	pushBlockEndEvent,
	SKIP_THOUGHT_SIGNATURE,
	startTextOrThinkingBlock,
} from "../google-shared";
import type { GenerateContentResponse, Part } from "../google-types";
import { transformMessages } from "../transform-messages";

/** Factory's Gemini endpoint speaks native generateContent SSE at `/api/llm/g/v1/generate`. */

/** OMP effort → Gemini thinkingLevel (low/minimal→LOW, medium→MEDIUM when supported, else HIGH). */
function geminiThinkingLevel(effort: string | undefined, supportsMedium: boolean): "LOW" | "MEDIUM" | "HIGH" {
	switch (effort) {
		case "low":
		case "minimal":
			return "LOW";
		case "medium":
			return supportsMedium ? "MEDIUM" : "HIGH";
		default:
			return "HIGH";
	}
}

/**
 * The CLI sanitizes tool names to `[a-zA-Z0-9_-]`; names longer than 64 chars
 * are truncated and suffixed with `_` + an 8-char sha256. Applied to
 * declarations and replayed functionCall/functionResponse names.
 */
function sanitizeFactoryDroidToolName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (sanitized.length <= 64) return sanitized;
	return `${sanitized.slice(0, 64)}_${Bun.SHA256.hash(sanitized, "hex").slice(0, 8)}`;
}

/**
 * Wire name -> caller tool name for the declared tools, so returned calls
 * dispatch to the tool that was advertised. Two tools sharing one wire name
 * could not be told apart, so that request is rejected.
 */
function factoryDroidToolNamesByWire(tools: Tool[] | undefined): Map<string, string> {
	const names = new Map<string, string>();
	for (const tool of tools ?? []) {
		const wire = sanitizeFactoryDroidToolName(tool.name);
		const existing = names.get(wire);
		if (existing !== undefined && existing !== tool.name) {
			throw new Error(`Factory Gemini tool names "${existing}" and "${tool.name}" both encode as "${wire}"`);
		}
		names.set(wire, tool.name);
	}
	return names;
}

/** Finish reasons the CLI reports as a content-filter block (with stopDetails). */
const FACTORY_DROID_BLOCK_REASONS: Record<string, true> = {
	BLOCKLIST: true,
	SAFETY: true,
	RECITATION: true,
	PROHIBITED_CONTENT: true,
	SPII: true,
	IMAGE_SAFETY: true,
	IMAGE_PROHIBITED_CONTENT: true,
};

/**
 * Map a generateContent `finishReason` to OMP's StopReason using the CLI's
 * table: STOP→stop, MAX_TOKENS→length, content-filter family→error (with a
 * category), MALFORMED_FUNCTION_CALL→error, anything else→error. The CLI's
 * "unknown" bucket has no StopReason equivalent, so unknown terminators
 * surface as errors instead of masquerading as a clean stop.
 */
function mapFactoryDroidFinishReason(reason: string): {
	stopReason: "stop" | "length" | "error";
	errorMessage?: string;
} {
	// mapStopReasonString already implements the CLI's outcome table
	// (STOP→stop, MAX_TOKENS→length, everything else→error); the cast narrows
	// its wide StopReason return to the three values it ever produces.
	const stopReason = mapStopReasonString(reason) as "stop" | "length" | "error";
	if (stopReason !== "error") return { stopReason };
	if (FACTORY_DROID_BLOCK_REASONS[reason]) {
		return { stopReason: "error", errorMessage: `Generation was blocked by content filters (${reason})` };
	}
	if (reason === "MALFORMED_FUNCTION_CALL") {
		return { stopReason: "error", errorMessage: `Generation failed with finish reason: ${reason}` };
	}
	return { stopReason: "error", errorMessage: `Unknown finish reason: ${reason}` };
}

/** Transports whose outputs carry Gemini-verifiable signatures (Factory's own outputs are stamped google-generative-ai). */
const GOOGLE_APIS: Record<string, true> = {
	"google-generative-ai": true,
	"google-vertex": true,
	"google-gemini-cli": true,
};

/**
 * Apply Factory's replay provenance before canonical normalization: only
 * signed, Google-origin thinking and Google-origin call signatures survive;
 * everything else is DROPPED (never demoted to visible text).
 *
 * Only Google-origin turns are stamped as the target, so `transformMessages`
 * keeps their surviving signatures verbatim instead of demoting/stripping them
 * as cross-model. Their ids are plain in either stamp, so pairing is
 * unaffected. Every other turn keeps its real provenance: tool-result pairing
 * reads it (Responses `call_id|item_id` results pair only with a
 * Responses-origin call), and with its reasoning already gone there is
 * nothing left for a cross-model pass to demote.
 */
function adoptFactoryReplay(message: Message, model: Model<"factory-droid-agent">): Message {
	if (message.role !== "assistant") return message;
	const googleOrigin = GOOGLE_APIS[message.api] === true;
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			const signature = block.thinkingSignature?.trim();
			if (googleOrigin && block.thinking.trim() && signature && signature !== SKIP_THOUGHT_SIGNATURE) {
				content.push(block);
			}
		} else if (block.type === "toolCall" && !googleOrigin && block.thoughtSignature) {
			content.push({ ...block, thoughtSignature: undefined });
		} else {
			content.push(block);
		}
	}
	return googleOrigin
		? { ...message, content, api: model.api, provider: model.provider, model: model.id }
		: { ...message, content };
}

/**
 * Message → contents converter for the proxy's gemini history contract:
 *
 * - History first passes the canonical outbound normalization (credential
 *   redaction, malformed-call sanitation, missing/aborted tool results) after
 *   {@link adoptFactoryReplay} settled which reasoning may replay.
 * - User and developer turns become user contents; images ride as `inlineData`.
 * - Signed thinking replays as plain text parts carrying its signature.
 * - Tool calls replay as `functionCall` parts carrying their
 *   `thoughtSignature`; consecutive tool results group into ONE user content,
 *   because the proxy 400s when a call turn's response part count mismatches.
 * - Tool names are sanitized to the CLI's `[a-zA-Z0-9_-]` shape on
 *   declarations and on replayed call/response names.
 * - After the latest user turn containing a non-response part, function calls
 *   missing a signature get the validator-skip sentinel.
 * - Model turns with no valid parts are dropped.
 */
function toGeminiContents(
	model: Model<"factory-droid-agent">,
	context: Context,
): {
	contents: Array<{ role: "user" | "model"; parts: Part[] }>;
	systemInstruction?: { parts: Part[] };
} {
	const contents: Array<{ role: "user" | "model"; parts: Part[] }> = [];
	const messages = transformMessages(
		context.messages.map(message => adoptFactoryReplay(message, model)),
		model,
	);
	for (const message of messages) {
		if (message.role === "user" || message.role === "developer") {
			const parts: Part[] = [];
			if (typeof message.content === "string") {
				if (message.content) parts.push({ text: message.content });
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) parts.push({ text: block.text });
					else if (block.type === "image")
						parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
				}
			}
			if (parts.length > 0) contents.push({ role: "user", parts });
			continue;
		}
		if (message.role === "assistant") {
			const parts: Part[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text) {
					parts.push({ text: block.text });
				} else if (block.type === "thinking" && block.thinkingSignature) {
					parts.push({ text: block.thinking, thoughtSignature: block.thinkingSignature });
				} else if (block.type === "toolCall") {
					parts.push({
						functionCall: { name: sanitizeFactoryDroidToolName(block.name), args: block.arguments },
						...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
					});
				}
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
			continue;
		}
		const textParts: string[] = [];
		const binaryParts: Part[] = [];
		for (const block of message.content) {
			if (block.type === "text" && block.text) textParts.push(block.text);
			else if (block.type === "image")
				binaryParts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
		}
		const part: Part = {
			functionResponse: {
				name: sanitizeFactoryDroidToolName(message.toolName),
				response: {
					result:
						textParts.length > 0
							? textParts.join("\n")
							: binaryParts.length > 0
								? `Binary content provided (${binaryParts.length} item(s)).`
								: "Tool execution succeeded.",
				},
				...(binaryParts.length > 0 ? { parts: binaryParts } : {}),
			},
		};
		const last = contents[contents.length - 1];
		if (last && last.role === "user" && last.parts.every(p => p.functionResponse)) {
			last.parts.push(part);
		} else {
			contents.push({ role: "user", parts: [part] });
		}
	}
	// Sentinel injection: scope to model turns at/after the latest user turn
	// with a non-response part (the validator only checks the current tail).
	let lastUserText = 0;
	for (let i = contents.length - 1; i >= 0; i--) {
		const entry = contents[i];
		if (entry.role === "user" && entry.parts.some(part => !part.functionResponse)) {
			lastUserText = i;
			break;
		}
	}
	for (let i = lastUserText; i < contents.length; i++) {
		const entry = contents[i];
		if (entry.role !== "model") continue;
		for (const part of entry.parts) {
			if (part.functionCall && !part.thoughtSignature?.trim()) part.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
		}
	}
	// The CLI joins system blocks with a single newline into one part.
	const system = (context.systemPrompt ?? []).join("\n");
	return {
		contents,
		...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
	};
}

function toGeminiTools(tools: Tool[] | undefined): Array<{ functionDeclarations: unknown[] }> | undefined {
	if (!tools || tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map(tool => ({
				name: sanitizeFactoryDroidToolName(tool.name),
				description: tool.description,
				parameters: normalizeSchemaForFactoryDroid(dereferenceJsonSchema(toolWireSchema(tool))),
			})),
		},
	];
}

export interface FactoryDroidGeminiOptions extends StreamOptions {
	/** Base URL including the `/api/llm/g/v1` namespace. */
	baseUrl: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
	/** Additional droid identity headers (merged over the client's own). */
	headers: Record<string, string>;
	/** Thinking dialect selected by the route policy. */
	thinkingDialect?: RequestPolicy["googleThinking"];
}

export function streamFactoryDroidGemini(
	model: Model<"factory-droid-agent">,
	context: Context,
	options: FactoryDroidGeminiOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai",
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

		// The proxy buffers generated output and can stall before the first
		// event (long reasoning) and between events (post-tool-call silence).
		// Local timeouts abort through the tracker so the caller's own cancel
		// still wins when both fire.
		const tracker = createAbortSourceTracker(options.signal);
		const stalled = new AIError.StreamTimeoutError("Factory Gemini stream stalled");
		let firstEventTimer: NodeJS.Timeout | undefined;

		try {
			const { contents, systemInstruction } = toGeminiContents(model, context);
			let body: Record<string, unknown> = {
				model: model.requestModelId ?? model.id,
				contents,
				...(systemInstruction ? { systemInstruction } : {}),
				generationConfig: {
					temperature: options.temperature ?? 1,
					topP: options.topP ?? 0.95,
					topK: options.topK ?? 64,
					...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
					thinkingConfig:
						options.disableReasoning === true
							? { includeThoughts: false }
							: {
									includeThoughts: true,
									thinkingLevel: geminiThinkingLevel(
										options.reasoning,
										options.thinkingDialect === "level-medium",
									),
								},
				},
			};
			const toolNamesByWire = factoryDroidToolNamesByWire(context.tools);
			const tools = toGeminiTools(context.tools);
			if (tools) body.tools = tools;
			const replacement = await options.onPayload?.(body, model, options.signal);
			if (replacement !== undefined) body = replacement as Record<string, unknown>;

			// Caller wins, then env, then the idle-floored default — same
			// precedence as the anthropic transport. The first-event deadline is
			// end to end: it covers the fetch, a non-2xx body read, and the wait
			// for the first SSE chunk, which inherits only the remaining budget.
			const idleTimeoutMs = getStreamIdleTimeoutMs(options.streamIdleTimeoutMs);
			const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const firstEventDeadline = firstEventTimeoutMs === undefined ? undefined : Date.now() + firstEventTimeoutMs;
			if (firstEventTimeoutMs !== undefined) {
				firstEventTimer = setTimeout(() => tracker.abortLocally(stalled), firstEventTimeoutMs);
				firstEventTimer.unref?.();
			}

			const response = await (options.fetch ?? fetch)(`${options.baseUrl}/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "*/*",
					...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
					...options.headers,
				},
				body: JSON.stringify(body),
				signal: tracker.requestSignal,
			});
			if (!response.ok) {
				const bodyText = await response.text().catch(() => "");
				throw new AIError.GoogleApiError(
					`Factory Gemini generate failed (${response.status}): ${extractGoogleErrorMessage(bodyText, response.status)}`,
					response.status,
					{ headers: response.headers },
				);
			}
			await notifyProviderResponse(options, response, model, response.headers.get("x-request-id"));
			if (!response.body) throw new Error("Factory Gemini generate returned an empty body");

			stream.push({ type: "start", partial: output });

			let activeIndex = -1;
			let finishReason: string | undefined;
			let blockReason: string | undefined;
			const toolCallIndices: number[] = [];
			const closeBlock = () => {
				if (activeIndex < 0) return;
				const block = output.content[activeIndex];
				if (block.type === "thinking" || block.type === "text") {
					pushBlockEndEvent(block, activeIndex, output, stream);
				}
				activeIndex = -1;
			};

			clearTimeout(firstEventTimer);
			const chunks = iterateWithIdleTimeout(
				readSseJson<GenerateContentResponse>(response.body, tracker.requestSignal, event =>
					options.onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, model),
				),
				{
					idleTimeoutMs,
					firstItemTimeoutMs:
						firstEventDeadline === undefined ? undefined : Math.max(1, firstEventDeadline - Date.now()),
					errorMessage: stalled.message,
					onIdle: () => tracker.abortLocally(stalled),
					onFirstItemTimeout: () => tracker.abortLocally(stalled),
					abortSignal: options.signal,
				},
			);
			for await (const chunk of chunks) {
				// A server-declared error keeps its status and the same classification
				// as the Google provider; only a stream that just stops is a premature close.
				if (chunk.error) throw googleStreamChunkError(chunk.error, model.provider);
				if (firstTokenTime === undefined && chunk.candidates?.[0]?.content?.parts?.some(part => part.text)) {
					firstTokenTime = performance.now();
				}
				if (chunk.usageMetadata) {
					output.usage = mapGoogleUsage(chunk.usageMetadata);
					calculateCost(model, output.usage, output.timestamp);
				}
				// The last chunk's reason stands (streams repeat benign
				// intermediate reasons before the terminal one).
				finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
				blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
				const parts = chunk.candidates?.[0]?.content?.parts ?? [];
				for (const part of parts) {
					if (part.functionCall) {
						closeBlock();
						const contentIndex = output.content.length;
						const wireName = part.functionCall.name || "";
						const toolCall: ToolCall = {
							type: "toolCall",
							id: nextToolCallId(wireName || "tool"),
							name: toolNamesByWire.get(wireName) ?? wireName,
							arguments: part.functionCall.args ?? {},
							...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						};
						output.content.push(toolCall);
						toolCallIndices.push(contentIndex);
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: JSON.stringify(toolCall.arguments),
							partial: output,
						});
						continue;
					}
					if (typeof part.text !== "string") continue;
					if (part.thought === true) {
						if (activeIndex >= 0 && output.content[activeIndex].type !== "thinking") closeBlock();
						if (activeIndex < 0) {
							activeIndex = output.content.length;
							startTextOrThinkingBlock(true, output, stream);
						}
						const block = output.content[activeIndex] as { thinking: string; thinkingSignature?: string };
						// The CLI keeps the FIRST non-empty signature per block.
						if (!block.thinkingSignature && part.thoughtSignature) {
							block.thinkingSignature = part.thoughtSignature;
						}
						block.thinking += part.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: activeIndex,
							delta: part.text,
							partial: output,
						});
					} else if (part.text.length > 0) {
						if (activeIndex >= 0 && output.content[activeIndex].type !== "text") closeBlock();
						if (activeIndex < 0) {
							activeIndex = output.content.length;
							startTextOrThinkingBlock(false, output, stream);
						}
						const block = output.content[activeIndex] as { text: string };
						block.text += part.text;
						stream.push({ type: "text_delta", contentIndex: activeIndex, delta: part.text, partial: output });
					}
				}
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;

			closeBlock();
			// A stream that reaches EOF without a finishReason (and without a
			// promptFeedback block) was truncated, even when it already carried
			// functionCall parts; fail it as retryable instead of finishing the turn.
			if (finishReason === undefined && !blockReason) {
				// Worded like the other incomplete-stream errors so turn recovery
				// continues a stream that already rendered text.
				throw new AIError.ProviderResponseError(
					"Factory Droid Gemini stream closed before a finish_reason was received",
					{
						provider: model.provider,
						kind: "incomplete-stream",
					},
				);
			}
			for (const contentIndex of toolCallIndices) {
				const toolCall = output.content[contentIndex] as ToolCall;
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
			// Native terminal mapping: any tool call wins over every finish
			// reason; otherwise a promptFeedback blockReason takes precedence,
			// then the last chunk's finishReason decides stop/length/error.
			if (toolCallIndices.length > 0) {
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else if (blockReason) {
				output.stopReason = "error";
				output.errorMessage = `Generation was blocked by content filters (${blockReason})`;
				output.stopDetails = { type: "content_filter", category: blockReason };
				stream.push({ type: "error", reason: "error", error: output });
			} else if (finishReason !== undefined) {
				const mapped = mapFactoryDroidFinishReason(finishReason);
				output.stopReason = mapped.stopReason;
				if (mapped.errorMessage) {
					output.errorMessage = mapped.errorMessage;
					if (mapped.stopReason === "error" && FACTORY_DROID_BLOCK_REASONS[finishReason]) {
						output.stopDetails = { type: "content_filter", category: finishReason };
					}
				}
				if (mapped.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: output });
				} else {
					stream.push({ type: "done", reason: mapped.stopReason, message: output });
				}
			}
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker: tracker,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			clearTimeout(firstEventTimer);
		}
	})();

	return stream;
}
