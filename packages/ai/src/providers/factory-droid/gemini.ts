import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { readSseJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { AssistantMessage, Context, Model, StreamOptions, Tool } from "../../types";
import { AssistantMessageEventStream } from "../../utils/event-stream";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs } from "../../utils/idle-iterator";
import { notifyProviderResponse } from "../../utils/provider-response";
import { dereferenceJsonSchema, normalizeSchemaForFactoryDroid, toolWireSchema } from "../../utils/schema";
import {
	mapStopReasonString,
	nextToolCallId,
	pushBlockEndEvent,
	retainThoughtSignature,
	SKIP_THOUGHT_SIGNATURE,
	startTextOrThinkingBlock,
} from "../google-shared";

/** Factory's Gemini endpoint speaks native generateContent SSE at `/api/llm/g/v1/generate`. */

interface GeminiPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { name: string; args?: Record<string, unknown> };
	functionResponse?: { name: string; response: Record<string, unknown>; parts?: GeminiPart[] };
}

interface GeminiCandidate {
	content?: { role?: string; parts?: GeminiPart[] };
	finishReason?: string;
}

interface GeminiChunk {
	candidates?: GeminiCandidate[];
	promptFeedback?: { blockReason?: string };
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		totalTokenCount?: number;
		cachedContentTokenCount?: number;
	};
}

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
function mapFactoryDroidFinishReason(reason: string | undefined): {
	stopReason: "stop" | "length" | "error";
	errorMessage?: string;
} {
	// mapStopReasonString already implements the CLI's outcome table
	// (STOP→stop, MAX_TOKENS→length, everything else→error); the cast narrows
	// its wide StopReason return to the three values it ever produces.
	const stopReason = mapStopReasonString(reason ?? "") as "stop" | "length" | "error";
	if (stopReason !== "error") return { stopReason };
	if (reason && FACTORY_DROID_BLOCK_REASONS[reason]) {
		return { stopReason: "error", errorMessage: `Generation was blocked by content filters (${reason})` };
	}
	if (reason === "MALFORMED_FUNCTION_CALL") {
		return { stopReason: "error", errorMessage: `Generation failed with finish reason: ${reason}` };
	}
	return { stopReason: "error", errorMessage: `Unknown finish reason: ${reason ?? "none"}` };
}

/**
 * Message → contents converter for the proxy's gemini history contract:
 *
 * - User and developer turns become user contents; images ride as `inlineData`.
 * - Text and thinking both replay as plain text parts (never `thought: true`).
 *   Thinking block text always resends; a `thoughtSignature` is attached only
 *   when the block carries one — the gemini wire is the only producer of
 *   these blocks, so a signature present in history was google-captured.
 * - Tool calls replay as `functionCall` parts carrying their
 *   `thoughtSignature`; consecutive tool results group into ONE user content,
 *   because the proxy 400s when a call turn's response part count mismatches.
 * - Tool names are sanitized to the CLI's `[a-zA-Z0-9_-]` shape on
 *   declarations and on replayed call/response names.
 * - After the latest user turn containing a non-response part, function calls
 *   missing a signature get the validator-skip sentinel.
 * - Model turns with no valid parts are dropped.
 */
function toGeminiContents(context: Context): {
	contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
	systemInstruction?: { parts: GeminiPart[] };
} {
	const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
	for (const message of context.messages) {
		if (message.role === "user" || message.role === "developer") {
			const parts: GeminiPart[] = [];
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
			const parts: GeminiPart[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text) {
					parts.push({ text: block.text });
				} else if (block.type === "thinking" && block.thinking.trim()) {
					// Thinking replays as a plain text part, never `thought: true`.
					// A signature is attached only when the block carries one captured
					// on this wire (google-origin by construction); the validator-skip
					// sentinel is a wire-internal marker, never a google signature.
					parts.push({
						text: block.thinking,
						...(block.thinkingSignature?.trim() && block.thinkingSignature !== SKIP_THOUGHT_SIGNATURE
							? { thoughtSignature: block.thinkingSignature }
							: {}),
					});
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
		if (message.role === "toolResult") {
			const textParts: string[] = [];
			const binaryParts: GeminiPart[] = [];
			if (typeof message.content === "string") {
				if (message.content) textParts.push(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) textParts.push(block.text);
					else if (block.type === "image")
						binaryParts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
				}
			}
			const part: GeminiPart = {
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

/** Non-2xx response from Factory's Gemini-compatible generate endpoint. */
class FactoryDroidGeminiApiError extends AIError.ProviderHttpError {
	override readonly name = "FactoryDroidGeminiApiError";
}

/**
 * Pull a human-readable message and machine code out of the
 * generateContent-style error envelope (`{ error: { message, code, status } }`),
 * tolerating plain-text bodies. Mirrors the shared google transport's
 * error-body extraction (`extractGoogleErrorMessage` in google-shared.ts).
 */
function extractGeminiError(bodyText: string): { message: string; code: string | undefined } {
	if (!bodyText) return { message: "Unknown error", code: undefined };
	try {
		const parsed = JSON.parse(bodyText) as { error?: { message?: unknown; code?: unknown; status?: unknown } };
		const error = parsed.error;
		if (error && typeof error.message === "string" && error.message.length > 0) {
			const code =
				typeof error.code === "string" ? error.code : typeof error.status === "string" ? error.status : undefined;
			return { message: error.message, code };
		}
	} catch {
		// fall through to raw text
	}
	return { message: bodyText.slice(0, 500), code: undefined };
}

export interface FactoryDroidGeminiOptions extends StreamOptions {
	/** Base URL including the `/api/llm/g/v1` namespace. */
	baseUrl: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
	/** Additional droid identity headers (merged over the client's own). */
	headers: Record<string, string>;
	/** Gemini models with MEDIUM thinking support (3.1 Pro). */
	geminiMedium?: boolean;
	/** Sampling overrides; forwarded only when the caller provides them. */
	topP?: number;
	topK?: number;
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
			timestamp: Date.now(),
		};

		// Watchdog controller/timer live outside the try so the catch can
		// clear the timer and re-derive which signal fired on every exit path.
		const internalAbort = new AbortController();
		let stalledTimer: NodeJS.Timeout | undefined;

		try {
			const thinkingOn = options.disableReasoning !== true;
			const { contents, systemInstruction } = toGeminiContents(context);
			let body: Record<string, unknown> = {
				model: model.requestModelId ?? model.id,
				contents,
				...(systemInstruction ? { systemInstruction } : {}),
				generationConfig: {
					// Forward only caller-provided sampling overrides; no maxOutputTokens.
					...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
					...(options.topP !== undefined ? { topP: options.topP } : {}),
					...(options.topK !== undefined ? { topK: options.topK } : {}),
					...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
					thinkingConfig: thinkingOn
						? {
								includeThoughts: true,
								thinkingLevel: geminiThinkingLevel(options.reasoning, options.geminiMedium === true),
							}
						: { includeThoughts: false },
				},
			};
			const tools = toGeminiTools(context.tools);
			if (tools) body.tools = tools;
			const replacement = await options.onPayload?.(body, model, options.signal);
			if (replacement !== undefined) body = replacement as Record<string, unknown>;

			// Idle watchdog: the proxy buffers generated output and can stall
			// between events (long reasoning, post-tool-call silence). Without a
			// reader-side deadline a stalled body hangs forever, so arm an
			// internal controller that aborts the fetch when no SSE line arrives
			// within the resolved idle timeout. The caller's signal is chained so
			// cancellation still wins.
			const callSignal =
				options.signal !== undefined
					? AbortSignal.any([options.signal, internalAbort.signal])
					: internalAbort.signal;
			// First-event budget is separate from steady-state idle: the proxy
			// buffers long reasoning before the first SSE line, so the
			// pre-response phase must not be undercut by the inter-event idle
			// floor. Caller wins, then env, then the idle-floored default —
			// same precedence as the anthropic transport.
			const idleTimeoutMs = getStreamIdleTimeoutMs(options.streamIdleTimeoutMs);
			const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			let sawFirstEvent = false;
			const armIdle = () => {
				clearTimeout(stalledTimer);
				const timeoutMs = sawFirstEvent ? idleTimeoutMs : firstEventTimeoutMs;
				if (timeoutMs === undefined) return;
				stalledTimer = setTimeout(
					() => internalAbort.abort(new AIError.StreamTimeoutError("Factory Gemini stream stalled")),
					timeoutMs,
				);
				// The watchdog must never keep the process alive: the active
				// fetch/reader owns liveness, and a throw path that skips the
				// post-loop clear would otherwise pin the event loop for the
				// full idle budget.
				stalledTimer.unref?.();
			};
			armIdle();

			const response = await (options.fetch ?? fetch)(`${options.baseUrl}/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "*/*",
					...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
					...options.headers,
				},
				body: JSON.stringify(body),
				signal: callSignal,
			});
			if (!response.ok) {
				const bodyText = await response.text().catch(() => "");
				const { message, code } = extractGeminiError(bodyText);
				throw new FactoryDroidGeminiApiError(
					`Factory Gemini generate failed (${response.status}): ${message}`,
					response.status,
					{ headers: response.headers, code },
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

			// readSseJson handles framing and abortable reads.
			for await (const chunk of readSseJson<GeminiChunk>(response.body, callSignal, event =>
				options.onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, model),
			)) {
				clearTimeout(stalledTimer);
				sawFirstEvent = true;
				if (firstTokenTime === undefined && chunk.candidates?.[0]?.content?.parts?.some(part => part.text)) {
					firstTokenTime = performance.now();
				}
				if (chunk.usageMetadata) {
					// Mirror the shared google transport's mapping
					// (google-shared.ts): promptTokenCount INCLUDES cached
					// tokens, so input subtracts cachedContentTokenCount
					// (input + cacheRead = total prompt tokens, no
					// double-count). thoughtsTokenCount rides `output`
					// and is also reported as reasoningTokens (always a
					// subset of output per the Usage contract);
					// totalTokens comes from the wire, not an inventory sum.
					const cachedTokens = chunk.usageMetadata.cachedContentTokenCount || 0;
					const thinkingTokens = chunk.usageMetadata.thoughtsTokenCount || 0;
					output.usage = {
						input: (chunk.usageMetadata.promptTokenCount || 0) - cachedTokens,
						output: (chunk.usageMetadata.candidatesTokenCount || 0) + thinkingTokens,
						cacheRead: cachedTokens,
						cacheWrite: output.usage.cacheWrite,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
						cost: output.usage.cost,
					};
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
						const argsJson = JSON.stringify(part.functionCall.args ?? {});
						output.content.push({
							type: "toolCall",
							id: nextToolCallId(part.functionCall.name),
							name: part.functionCall.name,
							arguments: part.functionCall.args ?? {},
							...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						} as AssistantMessage["content"][number]);
						toolCallIndices.push(contentIndex);
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({ type: "toolcall_delta", contentIndex, delta: argsJson, partial: output });
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
						block.thinkingSignature = retainThoughtSignature(
							block.thinkingSignature,
							part.thoughtSignature,
							true,
						);
						block.thinking += part.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: activeIndex,
							delta: part.text,
							partial: output,
						});
					} else if (part.text.length > 0 || (part.thoughtSignature && !part.functionCall)) {
						if (activeIndex >= 0 && output.content[activeIndex].type !== "text") closeBlock();
						if (activeIndex < 0) {
							activeIndex = output.content.length;
							startTextOrThinkingBlock(false, output, stream);
						}
						const block = output.content[activeIndex] as { text: string; textSignature?: string };
						block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature, true);
						if (part.text.length > 0) {
							block.text += part.text;
							stream.push({ type: "text_delta", contentIndex: activeIndex, delta: part.text, partial: output });
						}
					}
				}
				// Arm the steady-state budget for the wait on the next
				// chunk (the pre-fetch arm covered the first event).
				armIdle();
			}
			clearTimeout(stalledTimer);
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;

			closeBlock();
			for (const contentIndex of toolCallIndices) {
				const toolCall = output.content[contentIndex] as Extract<
					AssistantMessage["content"][number],
					{ type: "toolCall" }
				>;
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
			} else {
				const mapped = mapFactoryDroidFinishReason(finishReason);
				output.stopReason = mapped.stopReason;
				if (mapped.errorMessage) {
					output.errorMessage = mapped.errorMessage;
					if (mapped.stopReason === "error" && finishReason && FACTORY_DROID_BLOCK_REASONS[finishReason]) {
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
			// Single exit-point clear for the idle watchdog: every throw path
			// (non-OK response, empty body, mid-stream read failure, post-loop
			// mappings) lands here, so the timer can never outlive the stream.
			clearTimeout(stalledTimer);
			// Re-derive WHICH signal fired rather than inspecting the thrown
			// error: both a caller cancel and the internal watchdog surface as
			// an AbortError from fetch, and only the signal states distinguish
			// them. Caller intent wins when both fired. Mirrors the shared
			// transports' contract (openai-completions.ts): caller abort maps
			// to AbortError, the watchdog maps to StreamTimeoutError.
			let surfaced: unknown = error;
			if (options.signal?.aborted) {
				surfaced = new AIError.AbortError();
			} else if (internalAbort.signal.aborted) {
				surfaced = internalAbort.signal.reason ?? new AIError.StreamTimeoutError("Factory Gemini stream stalled");
			}
			const result = await AIError.finalize(surfaced, {
				api: model.api,
				provider: model.provider,
				signal: options.signal,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
