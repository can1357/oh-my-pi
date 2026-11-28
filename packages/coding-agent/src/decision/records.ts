/**
 * In-memory record of a session's recent decisions, for `/decision status`. Records hold names,
 * counts, and reasons only: never request text or skill bodies.
 */
import type { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import {
	DECISION_FEATURES,
	type DecisionBackend,
	type DecisionFeature,
	type DecisionMode,
	resolveDecisionFeature,
} from "./resolve";
import { cfgDecisionSkillsVariant } from "./settings";
import { progressiveSkillsRequested, skillDependencyClosure } from "./skill-projection";

export interface DecisionRecord {
	feature: DecisionFeature;
	mode: DecisionMode;
	backend: DecisionBackend;
	reason: string;
	selected: string[];
	candidates: number;
	durationMs: number;
	timestamp: number;
}

const MAX_RECORDS = 20;

export class DecisionRecords {
	readonly #records: DecisionRecord[] = [];

	add(record: DecisionRecord): void {
		this.#records.push(record);
		if (this.#records.length > MAX_RECORDS) this.#records.shift();
	}

	list(): readonly DecisionRecord[] {
		return this.#records;
	}
}

export interface DecisionStatusInput {
	settings: Settings;
	nativeJudge: boolean;
	skills: readonly Skill[];
	records: readonly DecisionRecord[];
}

/** `/decision status` text: configuration, judge availability, and the most recent decisions. */
export function formatDecisionStatus({ settings, nativeJudge, skills, records }: DecisionStatusInput): string {
	const lines: string[] = [];
	const backend = resolveDecisionFeature(settings, "skills").backend;
	lines.push(
		`Backend: ${backend}${backend === "judge" ? (nativeJudge ? " (native judge available)" : " (no native judge: features fall back)") : ""}`,
	);
	for (const feature of DECISION_FEATURES) {
		const config = resolveDecisionFeature(settings, feature);
		lines.push(`${feature}: ${config.mode} (deadline ${config.deadlineMs} ms)`);
	}
	const variant = cfgDecisionSkillsVariant.get(settings);
	if (variant === "progressive") {
		const diagnostics = skillDependencyClosure(
			skills,
			skills.filter(skill => skill.alwaysApply === true).map(skill => skill.name),
		).diagnostics;
		const state = !progressiveSkillsRequested(settings)
			? "inactive: needs skills mode suggest or automatic"
			: diagnostics.length > 0
				? `roster fallback: ${diagnostics.join("; ")}`
				: "active";
		lines.push(`skills variant: progressive (${state})`);
	} else {
		lines.push("skills variant: roster");
	}
	if (records.length === 0) {
		lines.push("No decisions recorded in this session.");
		return lines.join("\n");
	}
	lines.push("Recent decisions (oldest first):");
	for (const record of records) {
		const selected = record.selected.length > 0 ? ` -> ${record.selected.join(", ")}` : "";
		lines.push(
			`- ${new Date(record.timestamp).toISOString()} ${record.feature} [${record.mode}/${record.backend}] ${record.reason}, ${record.candidates} candidate(s), ${record.durationMs} ms${selected}`,
		);
	}
	return lines.join("\n");
}
