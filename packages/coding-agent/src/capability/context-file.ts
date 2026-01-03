/**
 * Context Files Capability
 *
 * System instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.) that provide
 * persistent guidance to the agent.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * A context file that provides persistent instructions to the agent.
 */
export interface ContextFile {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/** Which level this came from */
	level: "user" | "project";
	/** Distance from cwd (0 = in cwd, 1 = parent, etc.) for project files */
	depth?: number;
	/** Source metadata */
	_source: SourceMeta;
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",
	// Deduplicate by level: one user-level file, one project-level file
	// Higher-priority providers shadow lower-priority ones at the same scope
	key: (file) => file.level,
	validate: (file) => {
		if (!file.path) return "Missing path";
		if (file.content === undefined) return "Missing content";
		if (file.level !== "user" && file.level !== "project") return "Invalid level: must be 'user' or 'project'";
		return undefined;
	},
});
