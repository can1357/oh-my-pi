/**
 * Hooks Capability
 *
 * Pre/post tool execution hooks defined as shell scripts.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * A hook script.
 */
export interface Hook {
	/** Hook name (filename without extension) */
	name: string;
	/** Absolute path to hook file */
	path: string;
	/** Hook type (pre/post) and associated tool */
	type: "pre" | "post";
	/** Tool this hook applies to, or "*" for all */
	tool: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const hookCapability = defineCapability<Hook>({
	id: "hooks",
	displayName: "Hooks",
	description: "Pre/post tool execution hooks",
	key: (hook) => `${hook.type}:${hook.tool}:${hook.name}`,
	validate: (hook) => {
		if (!hook.name) return "Missing name";
		if (!hook.path) return "Missing path";
		if (hook.type !== "pre" && hook.type !== "post") return "Invalid type (must be 'pre' or 'post')";
		if (!hook.tool) return "Missing tool";
		return undefined;
	},
});
