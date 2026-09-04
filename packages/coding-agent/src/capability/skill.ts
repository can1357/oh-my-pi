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
	/**
	 * When `true`, the skill declares a pinned "mode" (e.g. a persona like
	 * poteto-mode): while the mode is active, its `reminder` is injected into
	 * the system prompt every turn.
	 */
	mode?: boolean;
	/**
	 * Reminder text for mode skills; injected into the system prompt while the
	 * mode is pinned. Only meaningful when `mode` is `true`.
	 */
	reminder?: string;
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
	/** `true` when frontmatter declares `mode: true` (pinnable mode skill) */
	mode?: boolean;
	/** Reminder text for mode skills; injected while the mode is pinned */
	reminder?: string;
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

/**
 * Maximum length (in characters) of a mode skill's `reminder`. Reminders are
 * injected into the system prompt, so every skill-loading path enforces this
 * cap through {@link validateSkillReminder}.
 */
export const SKILL_REMINDER_MAX_LENGTH = 1024;

/**
 * Validate a skill's `reminder` frontmatter value. Returns `null` when the
 * value is acceptable (including absent), otherwise an error message.
 */
export function validateSkillReminder(reminder: unknown): string | null {
	if (reminder === undefined) return null;
	if (typeof reminder !== "string") return `"reminder" must be a string`;
	if (reminder.length > SKILL_REMINDER_MAX_LENGTH) {
		return `"reminder" exceeds ${SKILL_REMINDER_MAX_LENGTH} characters`;
	}
	return null;
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
