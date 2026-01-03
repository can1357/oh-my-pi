/**
 * Slash Commands Capability
 *
 * File-based slash commands defined as markdown files.
 */

import { defineCapability } from "./index";
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
	/** Source metadata */
	_source: SourceMeta;
}

export const slashCommandCapability = defineCapability<SlashCommand>({
	id: "slash-commands",
	displayName: "Slash Commands",
	description: "Custom slash commands defined as markdown files",
	key: (cmd) => cmd.name,
	validate: (cmd) => {
		if (!cmd.name) return "Missing name";
		if (!cmd.path) return "Missing path";
		if (cmd.content === undefined) return "Missing content";
		if (cmd.level !== "user" && cmd.level !== "project" && cmd.level !== "native") {
			return "Invalid level: must be 'user', 'project', or 'native'";
		}
		return undefined;
	},
});
