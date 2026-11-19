/**
 * System Prompt Capability
 *
 * Custom system prompt files (SYSTEM.md) and raw Handlebars template overrides
 * (SYSTEM_TEMPLATE.md) that modify the agent's base system prompt.
 * Distinct from context-files which are user instructions shown in conversation.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A system prompt customization file.
 */
export interface SystemPrompt {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/**
	 * Literal text rendered through the bundled custom template, or raw
	 * Handlebars source rendered with the default prompt's live context.
	 * Defaults to `"text"` when unset.
	 */
	kind?: "text" | "template";
	/** Which level this came from */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const systemPromptCapability = defineCapability<SystemPrompt>({
	id: "system-prompt",
	displayName: "System Prompt",
	description: "Custom system prompt files (SYSTEM.md, SYSTEM_TEMPLATE.md) that modify agent behavior",
	key: sp => `${sp.level}:${sp.kind ?? "text"}`,
	validate: sp => {
		if (!sp.path) return "Missing path";
		if (sp.content === undefined) return "Missing content";
		return undefined;
	},
});
