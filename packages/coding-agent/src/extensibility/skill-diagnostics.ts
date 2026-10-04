import type { Skill, SkillDiagnostic, SkillSelectionReason } from "./skills";

export interface SkillDiagnosticEntry {
	name: string;
	filePath: string;
	source: string;
	pluginName?: string;
}

export interface SkillDiagnosticDuplicate {
	skill: SkillDiagnosticEntry;
	retained: SkillDiagnosticEntry;
}

export interface SkillResolutionDiagnostic {
	name: string;
	reason: SkillSelectionReason;
	skills: SkillDiagnosticEntry[];
	duplicates: SkillDiagnosticDuplicate[];
}

export interface SkillDiagnosticsSnapshot {
	cwd: string;
	showStartupDiagnostics: boolean;
	diagnostics: SkillResolutionDiagnostic[];
}

function serializeSkill(skill: Skill): SkillDiagnosticEntry {
	return {
		name: skill.name,
		filePath: skill.filePath,
		source: skill.source,
		...(skill._source?.pluginName !== undefined && { pluginName: skill._source.pluginName }),
	};
}

/** Build the public, allowlisted form of the resolver's current diagnostics. */
export function buildSkillDiagnosticsSnapshot(
	cwd: string,
	diagnostics: readonly SkillDiagnostic[],
	showStartupDiagnostics: boolean,
): SkillDiagnosticsSnapshot {
	return {
		cwd,
		showStartupDiagnostics,
		diagnostics: diagnostics.map(diagnostic => ({
			name: diagnostic.name,
			reason: diagnostic.reason,
			skills: diagnostic.skills.map(serializeSkill),
			duplicates: diagnostic.duplicates.map(duplicate => ({
				skill: serializeSkill(duplicate.skill),
				retained: serializeSkill(duplicate.retained),
			})),
		})),
	};
}
