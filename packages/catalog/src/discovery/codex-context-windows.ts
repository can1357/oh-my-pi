import { type } from "@oh-my-pi/omptype";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { CodexContextWindows } from "../types";

const tokenBudgetSchema = type({
	enabled: "boolean",
	use_history_notes_extension: "boolean",
	reminder_threshold_tokens: "number.integer > 0",
	reminder_message_template: "string",
	guidance_message: "string",
	auto_compact_fallback_prompt: "string",
	auto_compact_fallback_buffer_tokens: "number.integer > 0",
});

/** Parse the upstream-owned protocol without normalizing its trained prompt bytes. */
export function parseCodexContextWindows(modelMessages: unknown, modelId: string): CodexContextWindows | undefined {
	if (!isRecord(modelMessages) || modelMessages.token_budget === undefined) return undefined;
	const budget = tokenBudgetSchema(modelMessages.token_budget);
	if (
		budget instanceof type.errors ||
		!budget.reminder_message_template.trim() ||
		!budget.reminder_message_template.includes("{n_remaining}") ||
		!budget.guidance_message.trim() ||
		!budget.auto_compact_fallback_prompt.trim()
	) {
		logger.warn("Ignoring invalid Codex context-window catalog configuration", { modelId });
		return undefined;
	}
	return {
		enabled: budget.enabled,
		useHistoryNotes: budget.use_history_notes_extension,
		reminderThresholdTokens: budget.reminder_threshold_tokens,
		reminderMessageTemplate: budget.reminder_message_template,
		guidanceMessage: budget.guidance_message,
		autoCompactFallbackPrompt: budget.auto_compact_fallback_prompt,
		autoCompactFallbackBufferTokens: budget.auto_compact_fallback_buffer_tokens,
	};
}
