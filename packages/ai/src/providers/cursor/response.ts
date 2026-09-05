import { isDeepStrictEqual } from "node:util";
import type {
	InferenceResponseInfo,
	InferenceStreamResponse,
	InferenceToolCall,
	InferenceToolCallStreamPart,
	RunInferenceServerMessage,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { InferenceMessageRole, InferenceStreamErrorType } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { decodeJsonStruct } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { logger, parseStreamingJson } from "@oh-my-pi/pi-utils";
import type { AssistantMessage, StopReason, TextContent, ThinkingContent, ToolCall } from "../../types";
import { AssistantMessageEventStream } from "../../utils/event-stream";
import { reconcileFinalContent } from "./reconciliation";

interface OpenBlock<T> {
	readonly index: number;
	readonly block: T;
}

interface OpenTool extends OpenBlock<ToolCall> {
	readonly name: string;
	json: string;
}

export interface InferenceMapperResult {
	readonly stopReason: StopReason;
	readonly errorMessage?: string;
	readonly errorStatus?: number;
}

function objectArguments(json: string, complete: boolean): Record<string, unknown> | undefined {
	if (json === "") return complete ? {} : undefined;
	let parsed: unknown;
	try {
		parsed = complete ? JSON.parse(json) : parseStreamingJson(json);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return Object.fromEntries(Object.entries(parsed));
}

function finalToolArguments(tool: InferenceToolCall): Record<string, unknown> {
	if (tool.args.length > 0) return decodeJsonStruct(tool.args);
	if (tool.rawToolCallArgs === undefined || tool.rawToolCallArgs === "") return {};
	const parsed = objectArguments(tool.rawToolCallArgs, true);
	if (parsed === undefined) throw new Error(`Cursor final tool call '${tool.toolCallId}' has invalid arguments`);
	return parsed;
}

function streamErrorMessage(
	response: Extract<InferenceStreamResponse["response"], { case: "error" }>["value"],
): string {
	const message = response.message === "" ? response.code || "Cursor inference failed" : response.message;
	if (response.isInputTokenLimitError || response.errorType === InferenceStreamErrorType.INPUT_TOKEN_LIMIT) {
		return `context_length_exceeded: ${message}`;
	}
	return message;
}

function streamErrorStatus(type: InferenceStreamErrorType): number | undefined {
	switch (type) {
		case InferenceStreamErrorType.AUTHENTICATION:
			return 401;
		case InferenceStreamErrorType.PERMISSION:
			return 403;
		case InferenceStreamErrorType.RATE_LIMIT:
			return 429;
		case InferenceStreamErrorType.OVERLOADED:
			return 503;
		default:
			return undefined;
	}
}

// RunInference can emit this response-framing marker as an ordinary text delta at invocation end.
// It is not added to the caller's model stop sequences.
const CURSOR_END_OF_SEQUENCE = "<|eos|>";

function stripCursorTerminalSequence(text: string): string {
	let end = text.length;
	while (
		end >= CURSOR_END_OF_SEQUENCE.length &&
		text.startsWith(CURSOR_END_OF_SEQUENCE, end - CURSOR_END_OF_SEQUENCE.length)
	) {
		end -= CURSOR_END_OF_SEQUENCE.length;
	}
	return text.slice(0, end);
}

function splitCursorTerminalCandidate(text: string): readonly [visible: string, pending: string] {
	let candidateStart = text.length;
	for (let length = Math.min(CURSOR_END_OF_SEQUENCE.length - 1, text.length); length > 0; length--) {
		if (text.endsWith(CURSOR_END_OF_SEQUENCE.slice(0, length))) {
			candidateStart -= length;
			break;
		}
	}
	while (
		candidateStart >= CURSOR_END_OF_SEQUENCE.length &&
		text.startsWith(CURSOR_END_OF_SEQUENCE, candidateStart - CURSOR_END_OF_SEQUENCE.length)
	) {
		candidateStart -= CURSOR_END_OF_SEQUENCE.length;
	}
	return [text.slice(0, candidateStart), text.slice(candidateStart)];
}

/** Maps one correlated managed invocation onto OMP's provider event contract. */
export class CursorInferenceMapper {
	readonly #stream: AssistantMessageEventStream;
	readonly #output: AssistantMessage;
	readonly #advertisedTools: ReadonlySet<string>;
	readonly #invocationId: string;
	readonly #onFirstToken: () => void;
	#text: OpenBlock<TextContent> | undefined;
	#pendingText = "";
	#thinking: OpenBlock<ThinkingContent> | undefined;
	readonly #tools = new Map<string, OpenTool>();
	readonly #completedTools = new Set<string>();
	#sawExtendedUsage = false;
	#streamError: { readonly message: string; readonly outputLimit: boolean; readonly status?: number } | undefined;
	#finalContent: AssistantMessage["content"] | undefined;

	constructor(
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
		advertisedTools: ReadonlySet<string>,
		invocationId: string,
		onFirstToken: () => void,
	) {
		this.#stream = stream;
		this.#output = output;
		this.#advertisedTools = advertisedTools;
		this.#invocationId = invocationId;
		this.#onFirstToken = onFirstToken;
	}

	handle(message: RunInferenceServerMessage): void {
		if (message.message.case !== "invocationResponse") {
			throw new Error(`Cursor mapper received outer arm '${message.message.case ?? "<unset>"}'`);
		}
		const response = message.message.value.response;
		if (response === undefined) throw new Error("Cursor invocation response has no payload");
		this.#handleResponse(response);
	}

	#handleResponse(response: InferenceStreamResponse): void {
		if (Bun.env.DEBUG_CURSOR === "2") {
			logger.debug("Cursor RunInference response", { response: response.response });
		}
		switch (response.response.case) {
			case "thinkingPart":
				this.#flushPendingText(false);
				if (response.response.value.text !== "") {
					this.#onFirstToken();
					this.#appendThinking(response.response.value.text, response.response.value.signature);
				}
				if (response.response.value.isFinal) this.#endThinking();
				return;
			case "textPart": {
				const part = response.response.value;
				// Cursor's managed adapter treats final text parts as finish markers.
				// Hold marker-shaped suffixes until the terminal boundary so ordinary
				// model text survives when a later stream chunk follows it.
				if (part.isFinal) {
					this.#flushPendingText(true);
					this.#endText();
					return;
				}
				const [text, pending] = splitCursorTerminalCandidate(this.#pendingText + part.text);
				this.#pendingText = pending;
				if (text !== "") {
					this.#onFirstToken();
					this.#appendText(text);
				}
				return;
			}
			case "toolCallPart":
				this.#flushPendingText(false);
				this.#onFirstToken();
				this.#handleTool(response.response.value);
				return;
			case "extendedUsage":
				this.#sawExtendedUsage = true;
				this.#output.usage.input = response.response.value.inputTokens;
				this.#output.usage.output = response.response.value.outputTokens;
				this.#output.usage.cacheRead = response.response.value.cacheReadTokens;
				this.#output.usage.cacheWrite = response.response.value.cacheWriteTokens;
				this.#updateTotal();
				return;
			case "usage":
				if (!this.#sawExtendedUsage) {
					this.#output.usage.input = response.response.value.promptTokens;
					this.#output.usage.output = response.response.value.completionTokens;
					this.#output.usage.cacheRead = 0;
					this.#output.usage.cacheWrite = 0;
					this.#updateTotal();
				}
				return;
			case "responseInfo":
				this.#flushPendingText(true);
				if (response.response.value.errorMessage) {
					this.#streamError = {
						...(this.#streamError ?? { outputLimit: false }),
						message: response.response.value.errorMessage,
					};
				}
				if (response.response.value.id !== "") this.#output.responseId = response.response.value.id;
				if (response.response.value.model !== "") this.#output.upstreamModel = response.response.value.model;
				if (response.response.value.createdAt > 0n) {
					const createdAt = Number(response.response.value.createdAt);
					if (Number.isSafeInteger(createdAt)) this.#output.timestamp = createdAt;
				}
				this.#captureFinalResponse(response.response.value);
				return;
			case "error":
				this.#streamError = {
					message: streamErrorMessage(response.response.value),
					outputLimit:
						response.response.value.isOutputTokenLimitError ||
						response.response.value.errorType === InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT,
					status: streamErrorStatus(response.response.value.errorType),
				};
				return;
			case "invocationId":
				if (response.response.value.invocationId !== this.#invocationId) {
					throw new Error("Cursor nested invocation identity disagrees with its outer envelope");
				}
				return;
			case "providerMetadata":
			case "imageDescriptions":
				return;
			case undefined:
				throw new Error("Cursor inference response has no arm");
		}
	}

	#captureFinalResponse(info: InferenceResponseInfo): void {
		const content: AssistantMessage["content"] = [];
		for (const message of info.messages) {
			if (message.role === InferenceMessageRole.TOOL) continue;
			for (const part of message.reasoningParts) {
				if (part.isRedacted && part.redactedData !== undefined && part.redactedData !== "") {
					content.push({ type: "redactedThinking", data: part.redactedData });
				} else {
					content.push({
						type: "thinking",
						thinking: part.text,
						...(part.signature === undefined ? {} : { thinkingSignature: part.signature }),
					});
				}
			}
			if (message.content !== undefined) {
				const text = stripCursorTerminalSequence(message.content);
				if (text.trim() !== "") content.push({ type: "text", text });
			}
			for (const tool of message.toolCalls) {
				if (tool.toolCallId === "" || tool.toolName === "") {
					throw new Error("Cursor final response contains an unnamed tool call");
				}
				if (!this.#advertisedTools.has(tool.toolName)) {
					throw new Error(`Cursor final response called unadvertised tool '${tool.toolName}'`);
				}
				content.push({
					type: "toolCall",
					id: tool.toolCallId,
					name: tool.toolName,
					arguments: finalToolArguments(tool),
				});
			}
		}
		this.#finalContent = content;
	}

	#appendThinking(delta: string, signature: string | undefined): void {
		this.#endText();
		if (this.#thinking === undefined) {
			const block: ThinkingContent = {
				type: "thinking",
				thinking: "",
				...(signature === undefined ? {} : { thinkingSignature: signature }),
			};
			this.#output.content.push(block);
			this.#thinking = { index: this.#output.content.length - 1, block };
			this.#stream.push({ type: "thinking_start", contentIndex: this.#thinking.index, partial: this.#output });
		} else if (
			signature !== undefined &&
			this.#thinking.block.thinkingSignature !== undefined &&
			this.#thinking.block.thinkingSignature !== signature
		) {
			throw new Error("Cursor thinking signature changed within one block");
		} else if (signature !== undefined) {
			this.#thinking.block.thinkingSignature = signature;
		}
		this.#thinking.block.thinking += delta;
		this.#stream.push({ type: "thinking_delta", contentIndex: this.#thinking.index, delta, partial: this.#output });
	}

	#appendText(delta: string): void {
		this.#endThinking();
		if (this.#text === undefined) {
			const block: TextContent = { type: "text", text: "" };
			this.#output.content.push(block);
			this.#text = { index: this.#output.content.length - 1, block };
			this.#stream.push({ type: "text_start", contentIndex: this.#text.index, partial: this.#output });
		}
		this.#text.block.text += delta;
		this.#stream.push({ type: "text_delta", contentIndex: this.#text.index, delta, partial: this.#output });
	}

	#flushPendingText(terminal: boolean): void {
		if (this.#pendingText === "") return;
		const pending = this.#pendingText;
		this.#pendingText = "";
		const text = terminal ? stripCursorTerminalSequence(pending) : pending;
		if (text === "") return;
		this.#onFirstToken();
		this.#appendText(text);
	}

	#handleTool(part: InferenceToolCallStreamPart): void {
		if (part.toolCallId === "") throw new Error("Cursor tool call has no id");
		if (this.#completedTools.has(part.toolCallId)) {
			throw new Error(`Cursor tool call '${part.toolCallId}' continued after completion`);
		}
		let open = this.#tools.get(part.toolCallId);
		if (open === undefined) {
			if (part.toolName === "") throw new Error("Cursor tool call starts without a name");
			if (!this.#advertisedTools.has(part.toolName)) {
				throw new Error(`Cursor called unadvertised tool '${part.toolName}'`);
			}
			this.#endText();
			this.#endThinking();
			const block: ToolCall = { type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: {} };
			this.#output.content.push(block);
			open = { index: this.#output.content.length - 1, block, name: part.toolName, json: "" };
			this.#tools.set(part.toolCallId, open);
			this.#stream.push({ type: "toolcall_start", contentIndex: open.index, partial: this.#output });
		}
		if (part.toolName !== "" && part.toolName !== open.name) {
			throw new Error(`Cursor tool call '${part.toolCallId}' changed name`);
		}
		if (!part.isComplete) {
			if (part.args === "") return;
			open.json += part.args;
			const partial = objectArguments(open.json, false);
			if (partial !== undefined) open.block.arguments = partial;
			this.#stream.push({
				type: "toolcall_delta",
				contentIndex: open.index,
				delta: part.args,
				partial: this.#output,
			});
			return;
		}
		const complete = objectArguments(part.args, true);
		if (complete === undefined) {
			throw new Error(`Cursor tool call '${part.toolCallId}' completed with invalid JSON arguments`);
		}
		const streamed = objectArguments(open.json, true);
		if (open.json !== "" && (streamed === undefined || !isDeepStrictEqual(streamed, complete))) {
			throw new Error(`Cursor tool call '${part.toolCallId}' argument stream disagrees with completion`);
		}
		open.block.arguments = complete;
		this.#stream.push({
			type: "toolcall_end",
			contentIndex: open.index,
			toolCall: open.block,
			partial: this.#output,
		});
		this.#tools.delete(part.toolCallId);
		this.#completedTools.add(part.toolCallId);
	}

	#updateTotal(): void {
		this.#output.usage.totalTokens =
			this.#output.usage.input +
			this.#output.usage.output +
			this.#output.usage.cacheRead +
			this.#output.usage.cacheWrite;
	}

	#endText(): void {
		if (this.#text === undefined) return;
		this.#stream.push({
			type: "text_end",
			contentIndex: this.#text.index,
			content: this.#text.block.text,
			partial: this.#output,
		});
		this.#text = undefined;
	}

	#endThinking(): void {
		if (this.#thinking === undefined) return;
		this.#stream.push({
			type: "thinking_end",
			contentIndex: this.#thinking.index,
			content: this.#thinking.block.thinking,
			partial: this.#output,
		});
		this.#thinking = undefined;
	}

	finish(): InferenceMapperResult {
		this.#flushPendingText(true);
		this.#endText();
		this.#endThinking();
		if (this.#tools.size > 0) throw new Error("Cursor invocation ended with incomplete tool calls");
		const reconciled = reconcileFinalContent(this.#output.content, this.#finalContent);
		this.#output.content.splice(0, this.#output.content.length, ...reconciled);
		const finalizedTools = this.#output.content.filter(({ type }) => type === "toolCall");
		if (this.#completedTools.size > 0 && finalizedTools.length === 0) {
			throw new Error("Cursor toolUse completed without a finalized tool call");
		}
		if (this.#streamError !== undefined) {
			if (this.#streamError.outputLimit && this.#output.content.length > 0) return { stopReason: "length" };
			return {
				stopReason: "error",
				errorMessage: this.#streamError.message,
				...(this.#streamError.status === undefined ? {} : { errorStatus: this.#streamError.status }),
			};
		}
		return { stopReason: finalizedTools.length > 0 ? "toolUse" : "stop" };
	}
}
