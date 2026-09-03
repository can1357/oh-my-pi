import { prompt } from "@oh-my-pi/pi-utils";
import type { Skill } from "../extensibility/skills";
import skillModeReminderTemplate from "../prompts/system/skill-mode-reminder.md" with { type: "text" };

/** Session custom entry type recording skill mode pin/unpin transitions. */
export const SKILL_MODE_PIN_CUSTOM_TYPE = "skill-mode-pin";

/** Persisted shape of a skill-mode-pin entry. */
export interface SkillModePinData {
	skill: string;
	pinned: boolean;
}

/**
 * Structurally narrow enough for `SessionManager.getEntries()` results so this
 * module stays import-light for non-session callers (the sdk prompt builder).
 */
export interface SkillModePinEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Strict parse of skill-mode-pin entry data; null when malformed. */
export function parseSkillModePinData(data: unknown): SkillModePinData | null {
	if (typeof data !== "object" || data === null) return null;
	const candidate = data as { skill?: unknown; pinned?: unknown };
	if (typeof candidate.skill !== "string" || candidate.skill.length === 0) return null;
	if (typeof candidate.pinned !== "boolean") return null;
	return { skill: candidate.skill, pinned: candidate.pinned };
}

/**
 * Replay skill-mode-pin entries into the currently pinned skill names in pin
 * order. The last write per skill wins (unpin clears it), so the result is
 * correct across resume, branch, and in-place session switches without any
 * in-memory handoff state.
 */
export function replaySkillModePins(entries: readonly SkillModePinEntry[]): string[] {
	const pinned = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SKILL_MODE_PIN_CUSTOM_TYPE) continue;
		const data = parseSkillModePinData(entry.data);
		if (!data) continue;
		if (data.pinned) pinned.add(data.skill);
		else pinned.delete(data.skill);
	}
	return [...pinned];
}

/**
 * Resolve pinned names against the loaded skills, keeping pin order and
 * dropping names that no longer map to a `mode: true` skill (e.g. the skill
 * was removed after pinning).
 */
export function resolvePinnedModeSkills(names: readonly string[], skills: readonly Skill[]): Skill[] {
	const modeSkills = new Map<string, Skill>();
	for (const skill of skills) {
		if (skill.mode === true) modeSkills.set(skill.name, skill);
	}
	const resolved: Skill[] = [];
	for (const name of names) {
		const skill = modeSkills.get(name);
		if (skill) resolved.push(skill);
	}
	return resolved;
}

/** Render the system-reminder block for one pinned mode skill. */
export function renderSkillModeReminder(skill: Pick<Skill, "name" | "reminder">): string {
	return prompt.render(skillModeReminderTemplate, { name: skill.name, reminder: skill.reminder ?? "" }).trim();
}
