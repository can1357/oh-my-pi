import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { AssistantMessage, Context, Model, StreamOptions, Tool } from "../../types";
import { AssistantMessageEventStream } from "../../utils/event-stream";
import { normalizeSchemaForGoogle } from "../../utils/schema";
import { createProviderErrorMessage } from "../error-message";
import { retainThoughtSignature, SKIP_THOUGHT_SIGNATURE } from "../google-shared";

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
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
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
 * Message → contents converter for the proxy's gemini history contract:
 *
 * - User text becomes one text part per block; images ride as `inlineData`.
 * - Text replays unsigned. Thinking replays ONLY when it carries a google
 *   signature, as a plain text part with `thoughtSignature` attached (never
 *   `thought: true`) — unsigned or cross-provider thinking is dropped on this
 *   route.
 * - Tool calls replay as `functionCall` parts carrying their
 *   `thoughtSignature`; consecutive tool results group into ONE user content,
 *   because the proxy 400s when a call turn's response part count mismatches.
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
				} else if (block.type === "thinking" && block.thinking.trim() && block.thinkingSignature?.trim()) {
					parts.push({ text: block.thinking, thoughtSignature: block.thinkingSignature });
				} else if (block.type === "toolCall") {
					parts.push({
						functionCall: { name: block.name, args: block.arguments },
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
					name: message.toolName,
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
	const system = (context.systemPrompt ?? []).filter(Boolean).join("\n\n");
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
				name: tool.name,
				description: tool.description,
				// The proxy validates against Gemini's proto schema subset — strip
				// draft-2020-12 keywords (type unions, exclusiveMinimum, ...) the same
				// way OMP's native google transport does.
				parameters: normalizeSchemaForGoogle(tool.parameters),
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
	/** Gemini models with MEDIUM thinking support (3.1 Pro). */
	geminiMedium?: boolean;
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

		try {
			const thinkingOn = options.disableReasoning !== true;
			const { contents, systemInstruction } = toGeminiContents(context);
			const body: Record<string, unknown> = {
				model: model.requestModelId ?? model.id,
				contents,
				...(systemInstruction ? { systemInstruction } : {}),
				generationConfig: {
					// The proxy's accepted shape: exactly these four keys — no maxOutputTokens.
					temperature: options.temperature ?? 1,
					topP: 0.95,
					topK: 64,
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

			const response = await (options.fetch ?? fetch)(`${options.baseUrl}/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "*/*",
					...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
					...options.headers,
				},
				body: JSON.stringify(body),
				signal: options.signal,
			});
			if (!response.ok) {
				const detail = (await response.text()).slice(0, 500);
				throw new Error(`Factory Gemini generate failed (${response.status}): ${detail}`);
			}
			if (!response.body) throw new Error("Factory Gemini generate returned an empty body");

			stream.push({ type: "start", partial: output });

			let textIndex = -1;
			let thinkingIndex = -1;
			const toolCalls = new Map<number, { name: string; args: string }>();

			const decoder = new TextDecoder();
			let buffer = "";
			const reader = response.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline: number;
				while (true) {
					newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (!payload || payload === "[DONE]") continue;
					let chunk: GeminiChunk;
					try {
						chunk = JSON.parse(payload);
					} catch {
						continue;
					}
					if (chunk.usageMetadata) {
						output.usage.input = chunk.usageMetadata.promptTokenCount ?? output.usage.input;
						output.usage.output =
							(chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0) ||
							output.usage.output;
						output.usage.cacheRead = chunk.usageMetadata.cachedContentTokenCount ?? output.usage.cacheRead;
						output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead;
					}
					const parts = chunk.candidates?.[0]?.content?.parts ?? [];
					for (const part of parts) {
						if (part.functionCall) {
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
							if (thinkingIndex < 0) {
								thinkingIndex = output.content.length;
								output.content.push({ type: "thinking", thinking: "" } as AssistantMessage["content"][number]);
								stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
							}
							const block = output.content[thinkingIndex] as { thinking: string; thinkingSignature?: string };
							block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
							block.thinking += part.text;
							stream.push({
								type: "thinking_delta",
								contentIndex: thinkingIndex,
								delta: part.text,
								partial: output,
							});
						} else if (part.text.length > 0 || (part.thoughtSignature && !part.functionCall)) {
							if (textIndex < 0) {
								textIndex = output.content.length;
								output.content.push({ type: "text", text: "" } as AssistantMessage["content"][number]);
								stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
							}
							const block = output.content[textIndex] as { text: string; textSignature?: string };
							block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature);
							if (part.text.length > 0) {
								block.text += part.text;
								stream.push({ type: "text_delta", contentIndex: textIndex, delta: part.text, partial: output });
							}
						}
					}
				}
			}

			if (thinkingIndex >= 0) {
				const block = output.content[thinkingIndex] as { thinking: string };
				stream.push({
					type: "thinking_end",
					contentIndex: thinkingIndex,
					content: block.thinking,
					partial: output,
				});
			}
			if (textIndex >= 0) {
				const block = output.content[textIndex] as { text: string };
				stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
			}
			for (const [contentIndex] of toolCalls) {
				const toolCall = output.content[contentIndex] as Extract<
					AssistantMessage["content"][number],
					{ type: "toolCall" }
				>;
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
			if (toolCalls.size > 0) output.stopReason = "toolUse";
			stream.push({ type: "done", reason: toolCalls.size > 0 ? "toolUse" : "stop", message: output });
			stream.end();
		} catch (error) {
			stream.push({ type: "error", reason: "error", error: createProviderErrorMessage(model, error) });
			stream.end();
		}
	})();

	return stream;
}
