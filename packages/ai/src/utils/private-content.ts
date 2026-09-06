import type { EncryptedContent, ImageContent, Message, TextContent } from "../types";

export const PRIVATE_MODEL_RESULT = "[private model-only result]";

export function publicToolContent(
	content: (TextContent | ImageContent | EncryptedContent)[],
	modelOnly = false,
): (TextContent | ImageContent)[] {
	if (!modelOnly && content.every(block => block.type !== "encrypted")) return content;
	return [{ type: "text", text: PRIVATE_MODEL_RESULT }];
}

/**
 * Public projection of a tool result plus whether the payload was private.
 * Hook wrappers need both: a private result must be redacted on the event and
 * its replayable original must survive any patch the handler returns — echoing
 * the redacted content back would otherwise destroy the ciphertext Codex
 * replays.
 */
export function publicToolProjection(
	content: (TextContent | ImageContent | EncryptedContent)[],
	modelOnly = false,
): { content: (TextContent | ImageContent)[]; isPrivate: boolean } {
	const projected = publicToolContent(content, modelOnly);
	return { content: projected, isPrivate: projected !== content };
}

/**
 * Redact private payloads without changing the replayable stored message.
 * Only results are private: the backend returns them as ciphertext. Tool-call
 * arguments stay public — the schema-flagged fields are already encrypted on
 * the wire and everything else is ordinary model output.
 */
export function publicMessage<T extends Message>(message: T): T {
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

/**
 * Remove private model-only exchanges when a request leaves the Codex
 * protocol. Replacing only the result is not enough: the paired assistant call
 * keeps its namespaced name (`notes.read_file`), and providers that constrain
 * function names to alphanumerics, underscores, and hyphens reject the dot, so
 * every later request fails. Public content in the same assistant turn stays.
 * Returns the input array untouched when nothing was private.
 */
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
