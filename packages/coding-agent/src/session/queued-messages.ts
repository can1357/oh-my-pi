import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { MAGIC_KEYWORDS } from "../modes/magic-keywords";
import type { RestoredQueuedMessage } from "./agent-session-types";
import { type CustomMessage, readQueueChipText } from "./messages";

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return undefined;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images: ImageContent[] = [];
	for (const part of message.content) {
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			images.push(part);
		}
	}
	return images.length > 0 ? images : undefined;
}

/** Whether a queued message should render in the queue UI. */
export function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

/** Whether a queued message is an advisor card. */
export function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

/** Whether a message is a terminal assistant answer containing text and no tools. */
export function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	let hasText = false;
	for (const part of message.content) {
		if (part.type === "toolCall") return false;
		if (part.type === "text") {
			if (part.text.trim().length > 0) hasText = true;
			continue;
		}
		if (
			part.type === "thinking" ||
			part.type === "redactedThinking" ||
			part.type === "fallback" ||
			part.type === "anthropicServerTool"
		)
			continue;
		return false;
	}
	return hasText;
}

/** Whether a queued message is a user prompt: any user-role turn, or a visible user-attributed custom prompt. */
export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/**
 * Whether a queued user prompt was authored by the user rather than handed off by an
 * agent. Chips and promotion touch only these; removal and editor restore further
 * require {@link isRestorableQueuedMessage}.
 */
export function isUserAuthoredQueuedMessage(message: AgentMessage): boolean {
	return isUserQueuedMessage(message) && !("attribution" in message && message.attribution === "agent");
}

/**
 * Whether a queued user prompt may be handed back as editable text (editor restore,
 * Alt+Up, RPC removal). Input an extension forwarded with a `tag` (`sendUserInput`) may
 * not: the editor and RPC clients carry only text, so the bridge that matches the
 * message by its tag would lose it. Such input stays queued (or, on an interrupt, is
 * recorded with its tag) and still shows as a queue chip.
 */
export function isRestorableQueuedMessage(message: AgentMessage): boolean {
	return (
		isUserAuthoredQueuedMessage(message) &&
		!((message.role === "user" || message.role === "custom") && message.tag !== undefined)
	);
}

/** Hidden magic-keyword notice types (`<id>-notice`) queued alongside a user prompt. */
const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set(MAGIC_KEYWORDS.map(keyword => `${keyword.id}-notice`));

/** Hidden companion carrying vision descriptions for a text-only model. */
export const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/** Hidden companion carrying the source path of a video contact sheet. */
export const VIDEO_ATTACHMENT_TYPE = "video-attachment";

/** Hidden companion carrying the source path of a pasted or dropped image. */
export const IMAGE_ATTACHMENT_TYPE = "image-attachment";

/**
 * Hidden notice announcing model agents the user tagged with a `^` mention.
 * Agent-attributed so providers keep its system authority, yet queued only
 * ahead of the prompt that tagged the model, so it is a companion by type.
 */
export const SESSION_AGENT_NOTICE_TYPE = "session-agent-notice";

/** Whether a hidden queued message is a companion of an adjacent user prompt. */
export function isHiddenUserCompanion(message: AgentMessage): boolean {
	if (message.role !== "custom" || message.display !== false) return false;
	if (message.customType === SESSION_AGENT_NOTICE_TYPE) return true;
	return (
		message.attribution === "user" &&
		(MAGIC_KEYWORD_NOTICE_TYPES.has(message.customType) ||
			message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE ||
			message.customType === VIDEO_ATTACHMENT_TYPE ||
			message.customType === IMAGE_ATTACHMENT_TYPE)
	);
}

/** Human-readable text shown for a queued-message chip. */
export function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

/** Converts a queued user message to editor-restorable content. */
export function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}
