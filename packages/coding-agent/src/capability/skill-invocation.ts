import type { SkillFrontmatter } from "./skill";

/** The two independent invocation axes resolved from skill frontmatter. */
export interface SkillInvocationAxes {
	/** Model axis: `true` omits the skill from the rendered `<skills>` listing. */
	hide: boolean;
	/** User axis: `false` makes `/skill:<name>` refuse to resolve to this skill. */
	userInvocable: boolean;
}

/**
 * Resolve both invocation axes. `hide` and its Claude Code / Pi alias
 * `disable-model-invocation` gate the model axis (default: advertised);
 * `user-invocable` gates the user axis (default: invocable). The axes are
 * independent: a skill may opt out of either, both, or neither.
 */
export function skillInvocationAxes(frontmatter: SkillFrontmatter | undefined): SkillInvocationAxes {
	return {
		hide: frontmatter?.hide === true || frontmatter?.disableModelInvocation === true,
		userInvocable: frontmatter?.userInvocable !== false,
	};
}

/** `true` when the skill belongs in the model-facing `<skills>` listing. */
export function isModelInvocable(skill: { hide?: boolean }): boolean {
	return skill.hide !== true;
}

/** `true` when the skill may be invoked as `/skill:<name>`. */
export function isUserInvocable(skill: { userInvocable?: boolean }): boolean {
	return skill.userInvocable !== false;
}
