import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { PRIVATE_MODEL_CALL, publicMessage, publicToolCall } from "@oh-my-pi/pi-ai/utils/private-content";
import type { AgentSessionEvent } from "./agent-session-events";
import type { FileEntry } from "./session-entries";

export function publicAgentMessage(message: AgentMessage): AgentMessage {
	return message.role === "assistant" || message.role === "toolResult" ? publicMessage(message) : message;
}

/** Key for one side of a private exchange, so the original can be swapped back. */
export function privateExchangeKey(message: AgentMessage): string | undefined {
	if (message.role === "toolResult") return `result:${message.toolCallId}`;
	if (message.role !== "assistant") return undefined;
	for (const block of message.content) {
		if (block.type === "toolCall" && block.modelOnly === true) return `call:${block.id}`;
	}
	return undefined;
}

export function publicSessionEntry<T extends FileEntry>(entry: T): T {
	if (entry.type !== "message") return entry;
	const message = publicAgentMessage(entry.message);
	return message === entry.message ? entry : { ...entry, message };
}

export function publicAgentMessages(messages: AgentMessage[]): AgentMessage[] {
	let projected: AgentMessage[] | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = publicAgentMessage(messages[index]);
		if (message !== messages[index]) (projected ??= messages.slice())[index] = message;
	}
	return projected ?? messages;
}

export function publicSessionEntries<T extends FileEntry>(entries: T[]): T[] {
	let projected: T[] | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = publicSessionEntry(entries[index]);
		if (entry !== entries[index]) (projected ??= entries.slice())[index] = entry;
	}
	return projected ?? entries;
}

/** Public view of a compaction preparation for `session_before_compact` handlers. */
export function publicCompactionPreparation(preparation: CompactionPreparation): CompactionPreparation {
	const messagesToSummarize = publicAgentMessages(preparation.messagesToSummarize);
	const turnPrefixMessages = publicAgentMessages(preparation.turnPrefixMessages);
	const recentMessages = publicAgentMessages(preparation.recentMessages);
	if (
		messagesToSummarize === preparation.messagesToSummarize &&
		turnPrefixMessages === preparation.turnPrefixMessages &&
		recentMessages === preparation.recentMessages
	) {
		return preparation;
	}
	return { ...preparation, messagesToSummarize, turnPrefixMessages, recentMessages };
}

/** Streaming events carry private arguments as a delta and a finished call too. */
function publicAssistantEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if ("message" in event) return { ...event, message: publicMessage(event.message) };
	if (!("partial" in event)) return event;
	const partial = publicMessage(event.partial);
	if (event.type === "toolcall_end") {
		const toolCall = publicToolCall(event.toolCall);
		if (toolCall !== event.toolCall) return { ...event, toolCall, partial };
	}
	if (event.type === "toolcall_delta" && isPrivateStreamedCall(event.partial, event.contentIndex)) {
		return { ...event, delta: PRIVATE_MODEL_CALL, partial };
	}
	return partial === event.partial ? event : { ...event, partial };
}

function isPrivateStreamedCall(partial: AssistantMessage, contentIndex: number): boolean {
	const block = partial.content[contentIndex];
	return block?.type === "toolCall" && block.modelOnly === true;
}

export function publicSessionEvent(event: AgentSessionEvent): AgentSessionEvent {
	switch (event.type) {
		case "message_start":
		case "message_end":
			return { ...event, message: publicAgentMessage(event.message) };
		case "message_update":
			return {
				...event,
				message: publicAgentMessage(event.message),
				assistantMessageEvent: publicAssistantEvent(event.assistantMessageEvent),
			};
		case "turn_end":
			return {
				...event,
				message: publicAgentMessage(event.message),
				toolResults: event.toolResults.map(publicMessage),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(publicAgentMessage) };
		default:
			return event;
	}
}
