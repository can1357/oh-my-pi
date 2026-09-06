import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
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
