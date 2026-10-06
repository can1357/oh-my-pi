import type { SkillDiagnosticItem } from "./skill-diagnostic-controller";
import type { Skill, SkillDiagnostic, SkillDuplicateMatch, SkillSelectionReason } from "./skills";

export interface SkillDiagnosticEntry {
	name: string;
	filePath: string;
	source: string;
	pluginName?: string;
	repository?: string;
	version?: string;
}

export interface SkillDiagnosticDuplicate {
	skill: SkillDiagnosticEntry;
	retained: SkillDiagnosticEntry;
	match: SkillDuplicateMatch;
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
	/** Every loaded skill's per-name analysis state; absent from snapshots older servers produced. */
	items?: SkillDiagnosticItem[];
}

export function serializeSkillDiagnosticEntry(skill: Skill): SkillDiagnosticEntry {
	const provenance = skill._source?.provenance;
	return {
		name: skill.name,
		filePath: skill.filePath,
		source: skill.source,
		...(skill._source?.pluginName !== undefined && { pluginName: skill._source.pluginName }),
		...(provenance !== undefined && { repository: provenance.repository }),
		...(provenance?.version !== undefined && { version: provenance.version }),
	};
}

/** Build the public, allowlisted form of the resolver's current diagnostics. */
export function buildSkillDiagnosticsSnapshot(
	cwd: string,
	diagnostics: readonly SkillDiagnostic[],
	showStartupDiagnostics: boolean,
	items?: readonly SkillDiagnosticItem[],
): SkillDiagnosticsSnapshot {
	return {
		cwd,
		showStartupDiagnostics,
		diagnostics: diagnostics.map(diagnostic => ({
			name: diagnostic.name,
			reason: diagnostic.reason,
			skills: diagnostic.skills.map(serializeSkillDiagnosticEntry),
			duplicates: diagnostic.duplicates.map(duplicate => ({
				skill: serializeSkillDiagnosticEntry(duplicate.skill),
				retained: serializeSkillDiagnosticEntry(duplicate.retained),
				match: duplicate.match,
			})),
		})),
		...(items !== undefined && { items: [...items] }),
	};
}
