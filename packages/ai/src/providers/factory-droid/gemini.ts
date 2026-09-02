import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { readSseJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { AssistantMessage, Context, Model, StreamOptions, Tool } from "../../types";
import { AssistantMessageEventStream } from "../../utils/event-stream";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs } from "../../utils/idle-iterator";
import { normalizeSchemaForFactoryDroid } from "../../utils/schema";
import { mapStopReasonString, retainThoughtSignature, SKIP_THOUGHT_SIGNATURE } from "../google-shared";

/**
 * Factory's Gemini path (`POST /api/llm/g/v1/generate`) speaks native
 * generateContent SSE — not the standard `:streamGenerateContent` route OMP's
 * google transport composes — so the Droid Core/Standard Gemini models get
 * this dedicated client. Request/response shapes verified against live traffic.
 */

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
 * - User text becomes one text part per block; images ride as `inlineData`.
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
		if (message.role === "user") {
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
				// The CLI copies an allowlist of schema keywords and drops the rest
				// (no propertyOrdering, patterns/limits preserved).
				parameters: normalizeSchemaForFactoryDroid(tool.parameters),
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
			const body: Record<string, unknown> = {
				model: model.requestModelId ?? model.id,
				contents,
				...(systemInstruction ? { systemInstruction } : {}),
				generationConfig: {
					// Sampling is caller-driven like the native google transport:
					// only provided values ride the wire (the proxy accepts a
					// leaner config — probe-verified) and no maxOutputTokens.
					...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
					...(options.topP !== undefined ? { topP: options.topP } : {}),
					...(options.topK !== undefined ? { topK: options.topK } : {}),
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
			if (!response.body) throw new Error("Factory Gemini generate returned an empty body");

			stream.push({ type: "start", partial: output });

			let textIndex = -1;
			let thinkingIndex = -1;
			let activeBlock: "thinking" | "text" | undefined;
			let finishReason: string | undefined;
			let blockReason: string | undefined;
			const toolCalls = new Map<number, { name: string; args: string }>();

			// Block close helpers: flush the open block's end event. Used both
			// on part-type flips (interleaved Gemini 3 spans) and at the end of
			// the stream.
			const closeThinking = () => {
				if (thinkingIndex < 0) return;
				const block = output.content[thinkingIndex] as { thinking: string };
				stream.push({
					type: "thinking_end",
					contentIndex: thinkingIndex,
					content: block.thinking,
					partial: output,
				});
				thinkingIndex = -1;
			};
			const closeText = () => {
				if (textIndex < 0) return;
				const block = output.content[textIndex] as { text: string };
				stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
				textIndex = -1;
			};

			// Canonical SSE framing (spec-compliant multi-line data: joining,
			// [DONE] termination, tolerant trailing-JSON recovery) with
			// abortableSource semantics that re-derive the abort reason after
			// each read instead of trusting a raw read rejection.
			for await (const chunk of readSseJson<GeminiChunk>(response.body, callSignal)) {
				clearTimeout(stalledTimer);
				sawFirstEvent = true;
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
				}
				// The last chunk's reason stands (streams repeat benign
				// intermediate reasons before the terminal one).
				finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
				blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
				const parts = chunk.candidates?.[0]?.content?.parts ?? [];
				for (const part of parts) {
					if (part.functionCall) {
						// Tool-call boundaries flush any open block (the
						// shared google consumer does the same), so a
						// later part starts fresh instead of appending to
						// the pre-call span.
						closeThinking();
						closeText();
						activeBlock = undefined;
						const contentIndex = output.content.length;
						const argsJson = JSON.stringify(part.functionCall.args ?? {});
						output.content.push({
							type: "toolCall",
							id: `call_${contentIndex}`,
							name: part.functionCall.name,
							arguments: part.functionCall.args ?? {},
							...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						} as AssistantMessage["content"][number]);
						toolCalls.set(contentIndex, { name: part.functionCall.name, args: argsJson });
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({ type: "toolcall_delta", contentIndex, delta: argsJson, partial: output });
						continue;
					}
					if (typeof part.text !== "string") continue;
					if (part.thought === true) {
						// Gemini 3 interleaves thinking and text; a
						// type flip starts a new block (the shared
						// consumer flushes on every isThinking
						// transition) so spans never merge and
						// signatures never bleed across blocks.
						if (activeBlock === "text") closeText();
						if (thinkingIndex < 0) {
							thinkingIndex = output.content.length;
							output.content.push({ type: "thinking", thinking: "" } as AssistantMessage["content"][number]);
							stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
							activeBlock = "thinking";
						}
						const block = output.content[thinkingIndex] as { thinking: string; thinkingSignature?: string };
						// The CLI keeps the FIRST non-empty signature per block.
						block.thinkingSignature = retainThoughtSignature(
							block.thinkingSignature,
							part.thoughtSignature,
							true,
						);
						block.thinking += part.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: thinkingIndex,
							delta: part.text,
							partial: output,
						});
					} else if (part.text.length > 0 || (part.thoughtSignature && !part.functionCall)) {
						if (activeBlock === "thinking") closeThinking();
						if (textIndex < 0) {
							textIndex = output.content.length;
							output.content.push({ type: "text", text: "" } as AssistantMessage["content"][number]);
							stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
							activeBlock = "text";
						}
						const block = output.content[textIndex] as { text: string; textSignature?: string };
						block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature, true);
						if (part.text.length > 0) {
							block.text += part.text;
							stream.push({ type: "text_delta", contentIndex: textIndex, delta: part.text, partial: output });
						}
					}
				}
				// Arm the steady-state budget for the wait on the next
				// chunk (the pre-fetch arm covered the first event).
				armIdle();
			}
			clearTimeout(stalledTimer);

			closeThinking();
			closeText();
			for (const [contentIndex] of toolCalls) {
				const toolCall = output.content[contentIndex] as Extract<
					AssistantMessage["content"][number],
					{ type: "toolCall" }
				>;
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
			// Native terminal mapping: any tool call wins over every finish
			// reason; otherwise a promptFeedback blockReason takes precedence,
			// then the last chunk's finishReason decides stop/length/error.
			if (toolCalls.size > 0) {
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
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
