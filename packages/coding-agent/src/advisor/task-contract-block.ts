import type { ActiveTaskContractSnapshot } from "../orchestration/task-contract";
import { formatTaskContractXmlBlock } from "../orchestration/task-contract";

export interface ComposeAdvisorSystemPromptInput {
	readonly basePrompt: string;
	readonly watchdogPrompt?: string;
	/** Legacy assignment snapshot used by the separate completion-gate path. */
	readonly activeTaskContract?: ActiveTaskContractSnapshot;
	/** Ephemeral compiled root-contract block, including its stable digest. */
	readonly compiledTaskContractBlock?: string;
}

/**
 * Compose the advisor system prompt from base, watchdog, and optional task contract.
 */
export function composeAdvisorSystemPrompt(input: ComposeAdvisorSystemPromptInput): string[] {
	const parts = [input.basePrompt];
	if (input.watchdogPrompt?.trim()) {
		parts.push(input.watchdogPrompt.trim());
	}
	if (input.compiledTaskContractBlock?.trim()) {
		parts.push(input.compiledTaskContractBlock);
	} else if (input.activeTaskContract) {
		parts.push(formatTaskContractXmlBlock(input.activeTaskContract));
	}
	return parts;
}

export function composeAdvisorSystemPromptText(input: ComposeAdvisorSystemPromptInput): string {
	return composeAdvisorSystemPrompt(input).join("\n\n");
}
