import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { publicMessage } from "@oh-my-pi/pi-ai/utils/private-content";
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionEntry } from "./session-entries";

export function publicAgentMessage(message: AgentMessage): AgentMessage {
	return message.role === "assistant" || message.role === "toolResult" ? publicMessage(message) : message;
}

export function publicSessionEntry(entry: SessionEntry): SessionEntry {
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

export function publicSessionEntries(entries: SessionEntry[]): SessionEntry[] {
	let projected: SessionEntry[] | undefined;
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

function publicAssistantEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if ("message" in event) return { ...event, message: publicMessage(event.message) };
	if (!("partial" in event)) return event;
	const partial = publicMessage(event.partial);
	return partial === event.partial ? event : { ...event, partial };
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
