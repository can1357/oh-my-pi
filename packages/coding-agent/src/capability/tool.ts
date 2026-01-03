/**
 * Custom Tools Capability
 *
 * User-defined tools that extend agent capabilities.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * A custom tool definition.
 */
export interface CustomTool {
	/** Tool name (unique key) */
	name: string;
	/** Absolute path to tool definition file */
	path: string;
	/** Tool description */
	description?: string;
	/** Tool implementation (script path or inline) */
	implementation?: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const toolCapability = defineCapability<CustomTool>({
	id: "tools",
	displayName: "Custom Tools",
	description: "User-defined tools that extend agent capabilities",
	key: (tool) => tool.name,
	validate: (tool) => {
		if (!tool.name) return "Missing name";
		if (!tool.path) return "Missing path";
		return undefined;
	},
});
