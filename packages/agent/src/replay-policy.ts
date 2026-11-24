import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";

/**
 * Model-facing text of a tool call the provider stream ended before it could run.
 * The provider's error (`details.upstreamError`) stays in the session for the UI.
 */
export const PROVIDER_ERROR_NOT_EXECUTED_TEXT =
	"Tool call was not executed because the provider stream ended with an error before the tool could run.";

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

/**
 * Detects the placeholder result agent-loop persists for a tool call whose
 * assistant turn ended on a provider error (`source: "assistant_stop_error"`).
 */
function isProviderErrorPlaceholder(message: ToolResultMessage): boolean {
	const details = message.details as { __synthetic?: unknown; source?: unknown } | undefined;
	return details?.__synthetic === true && details.source === "assistant_stop_error";
}

/**
 * The provider replay form of one converted message, or `undefined` when it is
 * not replayed. API-level refusals are dropped. A provider-error placeholder
 * keeps its "not executed" fact but loses the provider's error text: replaying a
 * refusal explanation ("…reverse engineering or duplicating model outputs…")
 * feeds the classifier its own verdict and makes every later turn of the
 * session likelier to be refused.
 */
export function toProviderReplayMessage(message: Message): Message | undefined {
	if (message.role === "assistant") return isProviderRefusalMessage(message) ? undefined : message;
	if (message.role !== "toolResult" || !isProviderErrorPlaceholder(message)) return message;
	return { ...message, content: [{ type: "text", text: PROVIDER_ERROR_NOT_EXECUTED_TEXT }] };
}

/** Applies {@link toProviderReplayMessage} to live provider replay. */
export function filterProviderReplayMessages(messages: readonly Message[]): Message[] {
	const replayed: Message[] = [];
	for (const message of messages) {
		const replay = toProviderReplayMessage(message);
		if (replay) replayed.push(replay);
	}
	return replayed;
}
