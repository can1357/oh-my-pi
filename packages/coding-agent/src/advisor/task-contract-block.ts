import type { ActiveTaskContractSnapshot } from "../orchestration/task-contract";
import { formatTaskContractXmlBlock } from "../orchestration/task-contract";

export interface ComposeAdvisorSystemPromptInput {
	readonly basePrompt: string;
	readonly watchdogPrompt?: string;
	readonly activeTaskContract?: ActiveTaskContractSnapshot;
}

/**
 * Compose the advisor system prompt from base, watchdog, and optional task contract.
 */
export function composeAdvisorSystemPrompt(input: ComposeAdvisorSystemPromptInput): string[] {
	const parts = [input.basePrompt];
	if (input.watchdogPrompt?.trim()) {
		parts.push(input.watchdogPrompt.trim());
	}
	if (input.activeTaskContract) {
		parts.push(formatTaskContractXmlBlock(input.activeTaskContract));
	}
	return parts;
}

export function composeAdvisorSystemPromptText(input: ComposeAdvisorSystemPromptInput): string {
	return composeAdvisorSystemPrompt(input).join("\n\n");
}
