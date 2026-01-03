/**
 * System Prompt Capability
 *
 * Custom system prompt files (SYSTEM.md) that modify the agent's base system prompt.
 * Distinct from context-files which are user instructions shown in conversation.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * A system prompt customization file.
 */
export interface SystemPrompt {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/** Which level this came from */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const systemPromptCapability = defineCapability<SystemPrompt>({
	id: "system-prompt",
	displayName: "System Prompt",
	description: "Custom system prompt files (SYSTEM.md) that modify agent behavior",
	key: (sp) => sp.level,
	validate: (sp) => {
		if (!sp.path) return "Missing path";
		if (sp.content === undefined) return "Missing content";
		return undefined;
	},
});
