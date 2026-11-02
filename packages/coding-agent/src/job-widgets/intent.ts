import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { shortenEmbeddedPaths } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** How many trailing messages {@link resolveToolCallIntent} looks through. */
const INTENT_LOOKBACK = 16;

/**
 * The `i` intent the model wrote on a tool call, found on the call's block in
 * the session's recent assistant messages (the running call's message is the
 * newest assistant message while its tools execute), as one line of plain
 * text with home paths shortened: every surface shows it as a single row or title.
 */
export function resolveToolCallIntent(messages: readonly AgentMessage[], toolCallId: string): string | undefined {
	const stop = Math.max(0, messages.length - INTENT_LOOKBACK);
	for (let index = messages.length - 1; index >= stop; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.id !== toolCallId) continue;
			const intent = block.intent && shortenEmbeddedPaths(sanitizeText(block.intent).replace(/\s+/g, " ").trim());
			return intent ? intent : undefined;
		}
	}
	return undefined;
}
