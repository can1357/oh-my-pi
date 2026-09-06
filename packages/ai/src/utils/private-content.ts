import type { EncryptedContent, ImageContent, Message, TextContent } from "../types";

export const PRIVATE_MODEL_RESULT = "[private model-only result]";

/** Public surfaces must never receive opaque inference-only content. */
export function publicToolContent(
	content: (TextContent | ImageContent | EncryptedContent)[],
	modelOnly = false,
): (TextContent | ImageContent)[] {
	if (!modelOnly && content.every(block => block.type !== "encrypted")) return content;
	return [{ type: "text", text: PRIVATE_MODEL_RESULT }];
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
 * Remove private payloads when switching away from the Codex protocol.
 * Returns the input array untouched when nothing was private.
 */
export function stripEncryptedToolResults(messages: Message[]): Message[] {
	let result: Message[] | undefined;
	for (let index = 0; index < messages.length; index++) {
		const projected = publicMessage(messages[index]);
		if (projected !== messages[index]) (result ??= messages.slice())[index] = projected;
	}
	return result ?? messages;
}
