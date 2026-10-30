import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import type { AgentSession } from "../../session/agent-session";
import { type ConfiguredThinkingLevel, parseCliThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/** Text shown when the active model has no thinking dial. */
export function noThinkingMessage(session: AgentSession): string {
	const model = session.model;
	return __ompTranslate(
		"{0} has no adjustable thinking level.",
		`${model ? `${model.provider}/${model.id}` : __ompTranslate("The current model")}`,
	);
}

/**
 * Resolve an `/effort <level>` argument to a selector the active model
 * accepts, or the message explaining why it cannot be applied. Shared by the
 * text/ACP handler and the TUI handler.
 */
export function resolveThinkingArgument(
	session: AgentSession,
	args: string,
): { level: ConfiguredThinkingLevel } | { error: string } {
	if (!session.model?.reasoning) return { error: noThinkingMessage(session) };
	const choices = session.getAvailableEffortSelectors();
	const selector = args.trim().toLowerCase();
	const parsed = parseCliThinkingLevel(selector);
	if (parsed === undefined || !choices.includes(parsed)) {
		return {
			error: __ompTranslate("Unknown thinking level: {0}. Available: {1}", `${selector}`, `${choices.join(", ")}`),
		};
	}
	return { level: parsed };
}
