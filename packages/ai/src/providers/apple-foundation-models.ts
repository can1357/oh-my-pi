/**
 * Apple Foundation Models: Apple's on-device system language model (macOS 27+,
 * Apple silicon), driven in-process through the pi-natives Swift bridge
 * (`crates/pi-natives/src/applefm/bridge.swift`).
 *
 * Every request lowers the full conversation into a Foundation Models
 * `Transcript` — instructions with tool definitions, prompts, responses, tool
 * calls, and tool outputs — and the bridge streams exactly one model turn back.
 * Tool calls are returned, not executed, so the agent loop runs them and
 * resumes by sending their outputs in the next request.
 */
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { appleFmAvailability, appleFmCancel, appleFmGenerate } from "@oh-my-pi/pi-natives";
import { parseStreamingJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ToolChoice,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { clearStreamingPartialJson, kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { decodeFoundationModelsArguments, toFoundationModelsSchema, toolWireSchema } from "../utils/schema";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, partitionVisionContent } from "./vision-guard";

/** Options for the `apple-foundation-models` API. */
export interface AppleFoundationModelsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	/** Reasoning effort; only forwarded to models whose capabilities include reasoning. */
	reasoning?: Effort;
}

/** Usability of the on-device model, as reported by the bridge. */
export interface AppleFoundationModelsAvailability {
	available: boolean;
	/** Why the model is unusable: `device_not_eligible`, `apple_intelligence_not_enabled`, `model_not_ready`, `unsupported_os`, `not_built`, `unsupported_platform`. */
	reason?: string;
	/** Context window in tokens. */
	contextSize?: number;
	/** Model variant display name, e.g. `AFM 3 Core Advanced`. */
	variant?: string;
	vision?: boolean;
	toolCalling?: boolean;
	/** Whether the model reasons in a separate channel (`ContextOptions.reasoningLevel`). */
	reasoningCapable?: boolean;
}

type Part = { type: "text"; text: string } | { type: "image"; data: string; label: string };

/** Transcript entry in the bridge's request schema; mirrors `Transcript.Entry`. */
type Entry =
	| { kind: "prompt" | "response"; parts: Part[] }
	| { kind: "toolCalls"; calls: { id: string; name: string; arguments: string }[] }
	| { kind: "toolOutput"; id: string; name: string; parts: Part[] };

interface GenerateRequest {
	instructions?: string;
	entries: Entry[];
	tools?: { name: string; description: string; parameters: string }[];
	temperature?: number;
	maxTokens?: number;
	toolChoice?: "auto" | "none" | "required";
	greedy?: boolean;
	topK?: number;
	topP?: number;
	reasoningLevel?: "light" | "moderate" | "deep";
}

/** Effort → `ContextOptions.ReasoningLevel`. */
const REASONING_LEVELS: Record<Effort, GenerateRequest["reasoningLevel"]> = {
	minimal: "light",
	low: "light",
	medium: "moderate",
	high: "deep",
	xhigh: "deep",
	max: "deep",
};

/** One bridge event; a turn ends with `done` or `error`. */
type BridgeEvent =
	| { type: "text" | "reasoning"; text: string }
	| { type: "toolCall"; callId: string; name: string; arguments?: string }
	| { type: "usage"; input: number; cachedInput: number; output: number; reasoning: number }
	| { type: "done" }
	| { type: "error"; code: string; message: string };

/** Bridge error codes for safety-filter outcomes, which are terminal. */
const CONTENT_BLOCKED_CODES: Record<string, true> = { guardrail_violation: true, refusal: true };

type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }> & {
	[kStreamingPartialJson]?: string;
};

/** Probes whether the on-device model can generate on this machine. */
export async function getAppleFoundationModelsAvailability(): Promise<AppleFoundationModelsAvailability> {
	const { type: _, ...availability } = JSON.parse(await appleFmAvailability()) as AppleFoundationModelsAvailability & {
		type: string;
	};
	return availability;
}

/**
 * Lowers message content to parts. Images get conversation-wide sequential
 * labels (`image-1`, …) so the model can tell them apart and refer to them;
 * earlier messages never change, so labels stay stable across turns and keep
 * the prefix cache valid.
 */
function toParts(
	content: string | ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
	images: { count: number },
): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const text = joinTextWithImagePlaceholder(textBlocks.map(block => block.text).join("\n"), omittedImages);
	const parts: Part[] = text ? [{ type: "text", text }] : [];
	for (const image of imageBlocks) parts.push({ type: "image", data: image.data, label: `image-${++images.count}` });
	return parts;
}

function toEntries(messages: Message[], supportsImages: boolean): Entry[] {
	const entries: Entry[] = [];
	const images = { count: 0 };
	for (const message of messages) {
		switch (message.role) {
			case "user":
			case "developer":
				entries.push({ kind: "prompt", parts: toParts(message.content, supportsImages, images) });
				break;
			case "toolResult": {
				const parts = toParts(message.content, supportsImages, images);
				if (message.isError) parts.unshift({ type: "text", text: "Tool call failed:" });
				entries.push({ kind: "toolOutput", id: message.toolCallId, name: message.toolName, parts });
				break;
			}
			case "assistant": {
				const text = message.content.flatMap(block => (block.type === "text" && block.text ? [block.text] : []));
				if (text.length > 0) entries.push({ kind: "response", parts: [{ type: "text", text: text.join("\n") }] });
				const calls = message.content.flatMap(block =>
					block.type === "toolCall"
						? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.arguments ?? {}) }]
						: [],
				);
				if (calls.length > 0) entries.push({ kind: "toolCalls", calls });
				break;
			}
		}
	}
	return entries;
}

function namedToolChoice(choice: ToolChoice | undefined): string | undefined {
	if (!choice || typeof choice === "string" || choice.type === "computer") return undefined;
	return "function" in choice ? choice.function.name : choice.name;
}

function mapToolChoice(choice: ToolChoice | undefined): GenerateRequest["toolChoice"] {
	if (choice === undefined || choice === "auto") return undefined;
	if (choice === "none") return "none";
	if (typeof choice === "object" && choice.type === "computer") return undefined;
	return "required";
}

/**
 * Lowers the context into a bridge request. Returns the argument paths each
 * tool's schema JSON-encodes, for decoding tool calls.
 */
function buildRequest(
	model: Model<"apple-foundation-models">,
	context: Context,
	options: AppleFoundationModelsOptions,
): { request: GenerateRequest; encodedPaths: Map<string, string[][]> } {
	const encodedPaths = new Map<string, string[][]>();
	const forced = namedToolChoice(options.toolChoice);
	const tools = (context.tools ?? [])
		.filter(tool => forced === undefined || tool.name === forced)
		.map(tool => {
			const lowered = toFoundationModelsSchema(toolWireSchema(tool), tool.name);
			encodedPaths.set(tool.name, lowered.encodedPaths);
			return { name: tool.name, description: tool.description, parameters: JSON.stringify(lowered.schema) };
		});
	const instructions = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	const request: GenerateRequest = {
		entries: toEntries(transformMessages(context.messages, model), model.input.includes("image")),
		temperature: options.temperature,
		maxTokens: options.maxTokens,
		toolChoice: tools.length > 0 ? mapToolChoice(options.toolChoice) : undefined,
		topK: options.topK,
		topP: options.topP,
		// Temperature 0 without explicit bounds asks for deterministic output.
		greedy: options.temperature === 0 && options.topK === undefined && options.topP === undefined ? true : undefined,
		reasoningLevel: model.reasoning && options.reasoning ? REASONING_LEVELS[options.reasoning] : undefined,
	};
	if (instructions) request.instructions = instructions;
	if (tools.length > 0) request.tools = tools;
	return { request, encodedPaths };
}

/** Runs one bridge generation, yielding its events until the terminal one. */
async function* generate(request: GenerateRequest, signal: AbortSignal | undefined): AsyncGenerator<BridgeEvent> {
	const queue: BridgeEvent[] = [];
	let wake: (() => void) | undefined;
	const handle = appleFmGenerate(JSON.stringify(request), (error, event) => {
		queue.push(
			error ? { type: "error", code: "runtime", message: error.message } : (JSON.parse(event) as BridgeEvent),
		);
		wake?.();
	});
	let finished = false;
	const cancel = () => {
		if (!finished) appleFmCancel(handle);
	};
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		while (true) {
			const event = queue.shift();
			if (!event) {
				const { promise, resolve } = Promise.withResolvers<void>();
				wake = resolve;
				await promise;
				continue;
			}
			if (event.type === "done" || event.type === "error") finished = true;
			yield event;
			if (finished) return;
		}
	} finally {
		signal?.removeEventListener("abort", cancel);
		cancel();
	}
}

/** Streams one turn from the on-device Apple Foundation Model. */
export const streamAppleFoundationModels: StreamFunction<"apple-foundation-models"> = (
	model,
	context,
	options = {},
) => {
	const stream = new AssistantMessageEventStream();
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
	void (async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		const toolIndices = new Map<string, number>();
		const endText = () => {
			const block = textIndex === undefined ? undefined : output.content[textIndex];
			if (block?.type === "text") {
				stream.push({ type: "text_end", contentIndex: textIndex!, content: block.text, partial: output });
			}
			textIndex = undefined;
		};
		const endThinking = () => {
			const block = thinkingIndex === undefined ? undefined : output.content[thinkingIndex];
			if (block?.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: thinkingIndex!,
					content: block.thinking,
					partial: output,
				});
			}
			thinkingIndex = undefined;
		};
		try {
			const { request, encodedPaths } = buildRequest(model, context, options);
			await options.onPayload?.(request, model);
			stream.push({ type: "start", partial: output });
			for await (const event of generate(request, options.signal)) {
				switch (event.type) {
					case "text": {
						endThinking();
						if (textIndex === undefined) {
							textIndex = output.content.push({ type: "text", text: "" }) - 1;
							stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
						}
						const block = output.content[textIndex];
						if (block.type === "text") block.text += event.text;
						stream.push({ type: "text_delta", contentIndex: textIndex, delta: event.text, partial: output });
						firstTokenTime ??= performance.now();
						break;
					}
					case "reasoning": {
						endText();
						if (thinkingIndex === undefined) {
							thinkingIndex = output.content.push({ type: "thinking", thinking: "" }) - 1;
							stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
						}
						const block = output.content[thinkingIndex];
						if (block.type === "thinking") block.thinking += event.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: thinkingIndex,
							delta: event.text,
							partial: output,
						});
						firstTokenTime ??= performance.now();
						break;
					}
					case "toolCall": {
						endText();
						endThinking();
						let index = toolIndices.get(event.callId);
						if (index === undefined) {
							const block: ToolCallBlock = {
								type: "toolCall",
								id: event.callId,
								name: event.name,
								arguments: {},
								[kStreamingPartialJson]: "",
							};
							index = output.content.push(block) - 1;
							toolIndices.set(event.callId, index);
							stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						}
						const delta = event.arguments ?? "";
						const block = output.content[index] as ToolCallBlock;
						block[kStreamingPartialJson] = (block[kStreamingPartialJson] ?? "") + delta;
						block.arguments = parseStreamingJson<Record<string, unknown>>(block[kStreamingPartialJson]);
						stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: output });
						firstTokenTime ??= performance.now();
						break;
					}
					case "usage":
						output.usage.cacheRead = event.cachedInput;
						output.usage.input = event.input - event.cachedInput;
						output.usage.output = event.output;
						output.usage.totalTokens = event.input + event.output;
						break;
					case "error":
						throw new AIError.ProviderResponseError(`${event.message} (${event.code})`, {
							provider: model.provider,
							kind: CONTENT_BLOCKED_CODES[event.code] ? "content-blocked" : "runtime",
						});
					case "done":
						break;
				}
			}
			endText();
			endThinking();
			for (const index of toolIndices.values()) {
				const block = output.content[index] as ToolCallBlock;
				block.arguments = decodeFoundationModelsArguments(
					parseStreamingJson<Record<string, unknown>>(block[kStreamingPartialJson] ?? ""),
					encodedPaths.get(block.name) ?? [],
				);
				clearStreamingPartialJson(block);
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			}
			output.stopReason =
				toolIndices.size > 0
					? "toolUse"
					: options.maxTokens !== undefined && output.usage.output >= options.maxTokens
						? "length"
						: "stop";
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				signal: options.signal,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};
