import type { AssistantMessage } from "../types";

/**
 * The message as a user-facing surface should present it: every narration
 * thinking block (see `ThinkingContent.narration`) becomes a text block, so it
 * renders as part of the answer instead of folding into reasoning. Returns the
 * input unchanged when it holds no narration. Display-only: replay must keep
 * the original thinking blocks and their signatures.
 */
export function presentNarrationAsAnswer(message: AssistantMessage): AssistantMessage {
	if (!message.content.some(block => block.type === "thinking" && block.narration)) return message;
	return {
		...message,
		content: message.content.map(block =>
			block.type === "thinking" && block.narration ? { type: "text", text: block.thinking } : block,
		),
	};
}
