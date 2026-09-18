import type { AgentSession } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/**
 * Effort selectors `/effort` accepts for the session's active model. `off` and
 * `auto` are always selectable; the concrete tiers are the ones this model
 * actually exposes, so neither the handler nor autocomplete offers a level the
 * clamp would silently rewrite. Empty when the model has no reasoning dial at
 * all.
 *
 * Shared by the handler's `choices` check and the TUI argument completions so
 * the dropdown can never suggest a value the handler then rejects.
 */
export function availableEffortSelectors(session: AgentSession): ConfiguredThinkingLevel[] {
	return session.getAvailableEffortSelectors();
}
