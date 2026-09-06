import type { AssistantMessage, EncryptedContent, ImageContent, Message, TextContent, ToolCall } from "../types";

export const PRIVATE_MODEL_RESULT = "[private model-only result]";
export const PRIVATE_MODEL_CALL = "[private model-only call]";

export function publicToolContent(
	content: (TextContent | ImageContent | EncryptedContent)[],
	modelOnly = false,
): (TextContent | ImageContent)[] {
	if (!modelOnly && content.every(block => block.type !== "encrypted")) return content;
	return [{ type: "text", text: PRIVATE_MODEL_RESULT }];
}

/** Public projection of a tool result plus whether the payload was private. */
export function publicToolProjection(
	content: (TextContent | ImageContent | EncryptedContent)[],
	modelOnly = false,
): { content: (TextContent | ImageContent)[]; isPrivate: boolean } {
	const projected = publicToolContent(content, modelOnly);
	return { content: projected, isPrivate: projected !== content };
}

/** Public projection of a model-only call, whose arguments are ciphertext. */
export function publicToolCall(call: ToolCall): ToolCall {
	if (call.modelOnly !== true) return call;
	return {
		type: "toolCall",
		id: call.id,
		name: call.name,
		modelOnly: true,
		arguments: { redacted: PRIVATE_MODEL_CALL },
	};
}

function publicAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (!message.content.some(block => block.type === "toolCall" && block.modelOnly === true)) return message;
	return {
		...message,
		content: message.content.map(block => (block.type === "toolCall" ? publicToolCall(block) : block)),
		providerPayload: undefined,
	};
}

/** Public projection of a message; the stored message keeps its replay payloads. */
export function publicMessage<T extends Message>(message: T): T {
	if (message.role === "assistant") return publicAssistantMessage(message) as Message as T;
	if (
		message.role !== "toolResult" ||
		(!message.modelOnly && !message.content.some(block => block.type === "encrypted"))
	)
		return message;
	return {
		...message,
		content: publicToolContent(message.content, message.modelOnly),
		details: undefined,
		providerMetadata: undefined,
	};
}

/** Drop private model-only exchanges when a request leaves the Codex protocol. */
export function dropModelOnlyToolExchanges(messages: Message[]): Message[] {
	let privateCallIds: Set<string> | undefined;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.modelOnly === true) (privateCallIds ??= new Set()).add(block.id);
			}
			continue;
		}
		if (
			message.role === "toolResult" &&
			(message.modelOnly === true || message.content.some(block => block.type === "encrypted"))
		) {
			(privateCallIds ??= new Set()).add(message.toolCallId);
		}
	}
	if (!privateCallIds) return messages;
	const kept: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (!privateCallIds.has(message.toolCallId)) kept.push(message);
			continue;
		}
		if (message.role !== "assistant") {
			kept.push(message);
			continue;
		}
		const content = message.content.filter(block => !(block.type === "toolCall" && privateCallIds.has(block.id)));
		if (content.length === message.content.length) kept.push(message);
		else if (content.length > 0) kept.push({ ...message, content });
	}
	return kept;
}
