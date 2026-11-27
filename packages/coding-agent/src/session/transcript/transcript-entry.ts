import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { ImageContent, MessageAttribution, TextContent } from "@oh-my-pi/pi-ai";
import {
	type CustomMessage,
	type CustomMessageContent,
	isCustomMessageContent,
	isUserTurnInitiator,
	normalizeCustomMessagePayload,
} from "./messages";
import { titleTextFromSkillPrompt } from "./skill-title-input";

/** Persisted message fields consumed by transcript rendering. */
export interface SessionMessageEntryLike {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
}

/** Persisted custom-message fields consumed by transcript rendering. */
export interface CustomMessageEntryLike {
	type: "custom_message";
	id: string;
	parentId: string | null;
	timestamp: string;
	customType: string;
	content: CustomMessageContent;
	details?: unknown;
	display: boolean;
	attribution?: MessageAttribution;
	excludeFromContext?: boolean;
}

/** Entries that replay as visible or hidden transcript messages. */
export type TranscriptEntryLike = SessionMessageEntryLike | CustomMessageEntryLike;

/** Restore a persisted custom message, rejecting unsendable content. */
export function customMessageEntryMessage(entry: CustomMessageEntryLike): CustomMessage | undefined {
	if (!isCustomMessageContent(entry.content)) return undefined;
	const normalized = normalizeCustomMessagePayload(entry);
	const attribution = entry.attribution === undefined ? undefined : normalized.attribution;
	return createCustomMessage(
		normalized.customType,
		normalized.content,
		normalized.display,
		normalized.details,
		entry.timestamp,
		attribution,
		normalized.excludeFromContext,
	);
}

/** Restore the message represented by a transcript entry. */
export function transcriptEntryMessage(entry: TranscriptEntryLike): AgentMessage | undefined {
	return entry.type === "message" ? entry.message : customMessageEntryMessage(entry);
}

/** Identify user-authored requests among transcript and metadata entries. */
export function isUserRequestEntry(entry: TranscriptEntryLike | { type: string }): boolean {
	if (entry.type === "message" && "message" in entry) {
		if (entry.message.role === "user") return true;
		return entry.message.role === "custom" && isUserTurnInitiator(entry.message);
	}
	if (entry.type === "custom_message" && "content" in entry) {
		const message = customMessageEntryMessage(entry);
		return message !== undefined && isUserTurnInitiator(message);
	}
	return false;
}

/** How many trailing entries a transcript selector replays at open; older history loads on demand. */
const RECENT_ENTRIES = 600;

/** Whether `entry` opens a selector turn: any message but a tool result, which folds into the call before it. */
function opensTurn(entry: TranscriptEntryLike): boolean {
	// A custom message is checked without restoring it: restored, it is a `custom` message whenever it is one.
	return entry.type === "message" ? entry.message.role !== "toolResult" : isCustomMessageContent(entry.content);
}

/**
 * The tail of a long branch for replay: at most {@link RECENT_ENTRIES} entries, from the first
 * that opens a turn, so calls and their results stay together. Only when the whole window is
 * tool results does it reach back to the call they belong to; the whole branch when it is short.
 */
export function recentTranscriptEntries<T extends TranscriptEntryLike>(entries: readonly T[]): readonly T[] {
	if (entries.length <= RECENT_ENTRIES) return entries;
	const cut = entries.length - RECENT_ENTRIES;
	for (let index = cut; index < entries.length; index++) {
		if (opensTurn(entries[index]!)) return entries.slice(index);
	}
	for (let index = cut - 1; index > 0; index--) {
		if (opensTurn(entries[index]!)) return entries.slice(index);
	}
	return entries;
}

/** A turn the user can rewind past and re-edit: a prompt with text, or a user-initiated custom message. */
export function isUserTurnEntry(entry: TranscriptEntryLike): boolean {
	if (entry.type === "message" && entry.message.role === "user") {
		const content = entry.message.content;
		return typeof content === "string"
			? content.trim().length > 0
			: content.some(block => block.type === "text" && block.text.trim().length > 0);
	}
	return isUserRequestEntry(entry);
}

/** A user turn's one-line label: its prompt text (or a custom message's draft), whitespace collapsed. */
export function userTurnLabel(entry: TranscriptEntryLike): string | undefined {
	const draft =
		entry.type === "message" && entry.message.role === "user"
			? textContent(entry.message.content, " ")
			: userTurnDraft(entry);
	return draft?.replace(/\s+/g, " ").trim();
}

/** Editable user request text, preserving skill invocation syntax. */
export function userTurnDraft(entry: TranscriptEntryLike): string | undefined {
	const message = transcriptEntryMessage(entry);
	if (!message) return undefined;
	if (message.role === "user") return textContent(message.content);
	if (message.role !== "custom" || !isUserTurnInitiator(message)) return undefined;
	return titleTextFromSkillPrompt(message) ?? textContent(message.content);
}

/** Extract text blocks verbatim, optionally separating block boundaries. */
export function textContent(content: string | ReadonlyArray<{ type: string; text?: string }>, separator = ""): string {
	if (typeof content === "string") return content;
	let text = "";
	let boundary = "";
	for (const block of content) {
		if (block.type !== "text") continue;
		text += boundary + (block.text ?? "");
		boundary = separator;
	}
	return text;
}

/** Well-formed image blocks in order: a `[Image #N]` marker in the text names the Nth. */
export function imageContent(content: string | ReadonlyArray<TextContent | ImageContent>): ImageContent[] {
	if (typeof content === "string") return [];
	return content.filter(
		(block): block is ImageContent =>
			block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
	);
}
