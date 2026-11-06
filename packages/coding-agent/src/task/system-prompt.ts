import { prompt } from "@oh-my-pi/pi-utils";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import type { SystemPromptPreset } from "./types";

export interface SubagentSystemPromptData {
	[key: string]: unknown;
	agent: string;
	context: string;
	planReference: string;
	planReferencePath: string;
	worktree: string;
	outputSchema: unknown;
	outputSchemaOverridesAgent: boolean;
}

export function buildSubagentSystemPrompt(
	defaultPrompt: readonly string[],
	systemPreset: SystemPromptPreset | undefined,
	data: SubagentSystemPromptData,
	runtimeInstructions: readonly string[] = [],
): string[] {
	const subagentPrompt = prompt.render(subagentSystemPromptTemplate, data);
	if (systemPreset === "minimal-task") return [...runtimeInstructions, subagentPrompt];
	if (defaultPrompt.length === 0) return [subagentPrompt];
	return [...defaultPrompt, subagentPrompt];
}
