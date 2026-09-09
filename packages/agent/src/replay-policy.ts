import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

/** Removes API-level provider refusals from live provider replay while preserving other messages. */
export function filterProviderReplayMessages(messages: readonly Message[]): Message[] {
	return messages.filter(message => message.role !== "assistant" || !isProviderRefusalMessage(message));
}
