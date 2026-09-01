/**
 * Slash Commands Capability
 *
 * File-based slash commands defined as markdown files.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A file-based slash command.
 */
export interface SlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Absolute path to command file */
	path: string;
	/** Command content (markdown template) */
	content: string;
	/** Source level */
	level: "user" | "project" | "native";
	/** Already-parsed display description, when discovery stripped frontmatter from `content`. */
	description?: string;
	/** Already-parsed argument hint (`argumentHint` or `argument-hint`). */
	argumentHint?: string;
	/** Source metadata */
	_source: SourceMeta;
}

function optionalTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Display fields already parsed from command frontmatter. */
export function slashCommandFrontmatterDisplay(frontmatter: Record<string, unknown>): {
	description?: string;
	argumentHint?: string;
} {
	return {
		description: optionalTrimmedString(frontmatter.description),
		argumentHint: optionalTrimmedString(
			frontmatter.argumentHint ?? ("argument-hint" in frontmatter ? frontmatter["argument-hint"] : undefined),
		),
	};
}

export const slashCommandCapability = defineCapability<SlashCommand>({
	id: "slash-commands",
	displayName: "Slash Commands",
	description: "Custom slash commands defined as markdown files",
	key: cmd => cmd.name,
	toExtensionId: cmd => `slash-command:${cmd.name}`,
	validate: cmd => {
		if (!cmd.name) return "Missing name";
		if (!cmd.path) return "Missing path";
		if (cmd.content === undefined) return "Missing content";
		if (cmd.level !== "user" && cmd.level !== "project" && cmd.level !== "native") {
			return "Invalid level: must be 'user', 'project', or 'native'";
		}
		return undefined;
	},
});
