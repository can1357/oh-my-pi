/**
 * Skills Capability
 *
 * Skills provide specialized knowledge or workflows that extend agent capabilities.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * Parsed frontmatter from a skill file.
 */
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	[key: string]: unknown;
}

/**
 * A skill that provides specialized knowledge or workflows.
 */
export interface Skill {
	/** Skill name (unique key, derived from filename or frontmatter) */
	name: string;
	/** Absolute path to skill file */
	path: string;
	/** Skill content (markdown) */
	content: string;
	/** Parsed frontmatter */
	frontmatter?: SkillFrontmatter;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const skillCapability = defineCapability<Skill>({
	id: "skills",
	displayName: "Skills",
	description: "Specialized knowledge and workflow files that extend agent capabilities",
	key: (skill) => skill.name,
	validate: (skill) => {
		if (!skill.name) return "Missing skill name";
		if (!skill.path) return "Missing skill path";
		return undefined;
	},
});
