/**
 * Which skills the system prompt advertises. The `roster` variant lists every non-hidden skill; the
 * `progressive` variant lists only `alwaysApply: true` skills and their `requiresSkills` closure and
 * leaves the rest to per-turn judge suggestions and `skill://?q=` search. Hidden skills (`hide`,
 * `disable-model-invocation`, `skills.manualSkills`) are never listed or autoloaded. Presentation only:
 * the loaded registry, `/skill:<name>` and `skill://<name>` are unchanged.
 */
import type { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import { resolveDecisionFeature } from "./resolve";
import { cfgDecisionSkillsVariant } from "./settings";

export interface SkillClosure {
	skills: Skill[];
	/** Why the closure is unusable; non-empty means `skills` is empty. */
	diagnostics: string[];
}

/**
 * `names` plus every skill they transitively require. The whole loaded graph is validated, not just
 * the requested part, so a broken declaration anywhere never authorizes a partial closure. Hidden
 * skills are pruned, along with anything reachable only through them: a skill the model must not
 * invoke on its own is never pulled in by a dependency edge.
 */
export function skillDependencyClosure(skills: readonly Skill[], names: readonly string[]): SkillClosure {
	const byName = new Map(skills.map(skill => [skill.name, skill]));
	const diagnostics: string[] = [];
	const visited = new Set<string>();
	const visiting: string[] = [];
	const validate = (name: string): void => {
		if (visiting.includes(name)) {
			diagnostics.push(`skill dependency cycle: ${[...visiting, name].join(" -> ")}`);
			return;
		}
		if (visited.has(name)) return;
		const skill = byName.get(name);
		if (!skill) {
			diagnostics.push(`required skill is not loaded: ${name}`);
			return;
		}
		visiting.push(name);
		for (const dependency of skill.requiresSkills ?? []) validate(dependency);
		visiting.pop();
		visited.add(name);
	};
	for (const skill of skills) validate(skill.name);
	for (const name of names) validate(name);
	if (diagnostics.length > 0) return { skills: [], diagnostics };
	const selected = new Set<string>();
	const include = (name: string): void => {
		if (selected.has(name)) return;
		const skill = byName.get(name);
		if (!skill || skill.hide === true) return;
		selected.add(name);
		for (const dependency of skill.requiresSkills ?? []) include(dependency);
	};
	for (const name of names) include(name);
	return { skills: [...selected].flatMap(name => byName.get(name) ?? []), diagnostics };
}

export interface ProgressiveSkillProjection {
	/** Skills the prompt lists, whose bodies are also preloaded on each user turn. */
	mandatory: Skill[];
}

/** Whether the settings ask for the progressive variant; it applies only while suggestions run. */
export function progressiveSkillsRequested(settings: Settings): boolean {
	const { mode } = resolveDecisionFeature(settings, "skills");
	return cfgDecisionSkillsVariant.get(settings) === "progressive" && (mode === "suggest" || mode === "automatic");
}

/**
 * The progressive projection of `skills`, or `undefined` when the roster stays: the variant is not
 * requested, or the `requiresSkills` graph is invalid (missing names, cycles), which falls back to
 * listing every skill rather than hiding procedures behind a broken declaration.
 */
export function progressiveSkillProjection(
	settings: Settings,
	skills: readonly Skill[],
): ProgressiveSkillProjection | undefined {
	if (!progressiveSkillsRequested(settings)) return undefined;
	const closure = skillDependencyClosure(
		skills,
		skills.filter(skill => skill.alwaysApply === true).map(skill => skill.name),
	);
	return closure.diagnostics.length > 0 ? undefined : { mandatory: closure.skills };
}
