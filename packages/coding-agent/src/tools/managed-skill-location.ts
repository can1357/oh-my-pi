import {
	MANAGED_SKILLS_PROVIDER_ID,
	type ManagedSkillLocation,
	type ManagedSkillScope,
} from "../autolearn/managed-skills";
import { reset as resetDiscoveryCache } from "../capability";
import { cfgDisabledExtensions, cfgSkills } from "../extensibility/settings";
import { loadSkills } from "../extensibility/skills";
import type { ToolSession } from ".";

type SkillSession = Pick<ToolSession, "cwd" | "settings" | "skills" | "skillRediscoveryHost">;

/** Bind unscoped edits to this session; the mutation queue invokes the lookup when its turn starts. */
export function managedSkillToolLocation(session: SkillSession, scope?: ManagedSkillScope): ManagedSkillLocation {
	if (scope === "global") return { scope };
	const cwd = session.cwd;
	if (scope === "project") return { scope, cwd };
	return {
		cwd,
		async getVisibleFile(name) {
			const host = session.skillRediscoveryHost?.();
			// A fixed skill list (such as a subagent's) must not gain skills from disk.
			let skills = host ? (host.refreshSkills ? undefined : host.skills) : session.skills;
			if (!skills) {
				// An earlier queued mutation may have changed which copy wins. Use the same
				// settings and extension roots as discovery, without rebuilding the prompt.
				resetDiscoveryCache();
				({ skills } = await loadSkills({
					...cfgSkills.get(session.settings),
					cwd,
					disabledExtensions: cfgDisabledExtensions.get(session.settings),
					extensionRoots: host?.extensionRoots,
				}));
			}
			const visible = skills.find(skill => skill.name === name);
			if (!visible) throw new Error(`A visible managed skill "${name}" does not exist in this session.`);
			if (visible._source?.provider !== MANAGED_SKILLS_PROVIDER_ID) {
				throw new Error(
					`The visible skill "${name}" is not a managed skill. Specify a scope to edit a hidden copy.`,
				);
			}
			return visible.filePath;
		},
	};
}
