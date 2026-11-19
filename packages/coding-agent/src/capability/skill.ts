/**
 * Skills Capability
 *
 * Skills provide specialized knowledge or workflows that extend agent capabilities.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Parsed frontmatter from a skill file.
 */
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/**
	 * When `true`, the skill is loaded and accessible via `skill://<name>` (and
	 * `/skill:<name>` slash commands), but is omitted from the rendered system
	 * prompt's skill listing. Use for skills the user opts into explicitly
	 * rather than ones the model should auto-discover.
	 */
	hide?: boolean;
	/**
	 * Agent Skills standard equivalent of `hide`.
	 * When `true`, the skill is excluded from the system prompt listing.
	 * Normalized from kebab-case `disable-model-invocation` in YAML frontmatter.
	 * @see https://agentskills.io/specification
	 */
	disableModelInvocation?: boolean;
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
	/**
	 * Filesystem-resolved plugin root this skill was packaged in (Agent Plugins
	 * §4.1). When set, every `skill://` resource access must realpath-resolve
	 * within this directory; symlinks may target other files inside it.
	 */
	containRoot?: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const skillCapability = defineCapability<Skill>({
	id: "skills",
	displayName: "Skills",
	description: "Specialized knowledge and workflow files that extend agent capabilities",
	key: skill => skill.name,
	toExtensionId: skill => `skill:${skill.name}`,
	validate: skill => {
		if (!skill.name) return "Missing skill name";
		if (!skill.path) return "Missing skill path";
		return undefined;
	},
});
