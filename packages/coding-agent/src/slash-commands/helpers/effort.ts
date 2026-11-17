import type { AgentViewSession } from "../../session/agent-session-handle";
import { type ConfiguredThinkingLevel, parseCliThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/** Text shown when the active model has no thinking dial. */
export function noThinkingMessage(session: AgentViewSession): string {
	const model = session.model;
	return `${model ? `${model.provider}/${model.id}` : "The current model"} has no adjustable thinking level.`;
}

/**
 * Resolve an `/effort <level>` argument to a selector the active model
 * accepts, or the message explaining why it cannot be applied. Shared by the
 * text/ACP handler and the TUI handler.
 */
export function resolveThinkingArgument(
	session: AgentViewSession,
	args: string,
): { level: ConfiguredThinkingLevel } | { error: string } {
	if (!session.model?.reasoning) return { error: noThinkingMessage(session) };
	const choices = session.getAvailableEffortSelectors();
	const selector = args.trim().toLowerCase();
	const parsed = parseCliThinkingLevel(selector);
	if (parsed === undefined || !choices.includes(parsed)) {
		return { error: `Unknown thinking level: ${selector}. Available: ${choices.join(", ")}` };
	}
	return { level: parsed };
}
