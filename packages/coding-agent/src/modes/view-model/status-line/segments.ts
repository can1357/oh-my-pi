import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { StatusLineSession } from "./host";

/**
 * The thinking-effort word (`high`, `off`; `auto` until auto thinking resolves
 * a level), or undefined when the model has no thinking. Drives the native
 * model segment and the composer's effort chip.
 */
export function thinkingLevelWord(
	session: Pick<StatusLineSession, "state" | "isAutoThinking" | "autoResolvedThinkingLevel">,
): string | undefined {
	const state = session.state;
	if (!state.model?.thinking) return undefined;
	if (session.isAutoThinking) return session.autoResolvedThinkingLevel() ?? "auto";
	return state.thinkingLevel ?? ThinkingLevel.Off;
}
