/**
 * Prompts Capability
 *
 * Reusable prompt templates (Codex format) available via /prompts: menu.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A reusable prompt template.
 */
export interface Prompt {
	/** Prompt name (filename without extension) */
	name: string;
	/** Absolute path to prompt file */
	path: string;
	/** Prompt content (markdown) */
	content: string;
	/** Source metadata */
	_source: SourceMeta;
}

export const promptCapability = defineCapability<Prompt>({
	id: "prompts",
	displayName: "Prompts",
	description: "Reusable prompt templates available via /prompts: menu",
	key: prompt => prompt.name,
	toExtensionId: prompt => `prompt:${prompt.name}`,
	validate: prompt => {
		if (!prompt.name) return "Missing name";
		if (!prompt.path) return "Missing path";
		if (prompt.content === undefined) return "Missing content";
		return undefined;
	},
});
