/**
 * Rules Capability
 *
 * Project-specific rules from Cursor (.mdc), Windsurf (.md), and Cline formats.
 * Translated to a canonical shape regardless of source format.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * Parsed frontmatter from MDC rule files (Cursor format).
 */
export interface RuleFrontmatter {
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/** Regex pattern that triggers time-traveling rule injection */
	ttsr_trigger?: string;
	[key: string]: unknown;
}

/**
 * A rule providing project-specific guidance and constraints.
 */
export interface Rule {
	/** Rule name (derived from filename) */
	name: string;
	/** Absolute path to rule file */
	path: string;
	/** Rule content (after frontmatter stripped) */
	content: string;
	/** Globs this rule applies to (if any) */
	globs?: string[];
	/** Whether to always include this rule */
	alwaysApply?: boolean;
	/** Description (for agent-requested rules) */
	description?: string;
	/** Regex pattern that triggers time-traveling rule injection */
	ttsrTrigger?: string;
	/** Source metadata */
	_source: SourceMeta;
}

export const ruleCapability = defineCapability<Rule>({
	id: "rules",
	displayName: "Rules",
	description: "Project-specific rules and constraints (Cursor MDC, Windsurf, Cline formats)",
	key: (rule) => rule.name,
	validate: (rule) => {
		if (!rule.name) return "Missing rule name";
		if (!rule.path) return "Missing rule path";
		if (!rule.content || typeof rule.content !== "string") return "Rule must have content";
		return undefined;
	},
});
