import { sanitizeDisplaySingleLine as displayValue } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Skill, SkillDiagnostic, SkillSelectionReason } from "../../extensibility/skills";

const SELECTION_REASONS: Record<SkillSelectionReason, string> = {
	"source-order": "Provider priority, then discovery order",
	"custom-directory": "Custom directory overrides provider skills",
	"authored-over-installed": "Authored skill overrides registry-installed skills",
};

export function summarizeSkillDiagnostics(diagnostics: readonly SkillDiagnostic[]): {
	message: string;
	conflicts: number;
} {
	let conflicts = 0;
	let redundant = 0;
	for (const diagnostic of diagnostics) {
		if (diagnostic.skills.length > 1) conflicts++;
		redundant += diagnostic.duplicates.length;
	}
	return {
		message: `Skill discovery: ${conflicts} conflicting name${conflicts === 1 ? "" : "s"}; ${redundant} redundant cop${redundant === 1 ? "y" : "ies"} deduplicated.`,
		conflicts,
	};
}

function appendSkill(lines: string[], label: string, skill: Skill): void {
	lines.push(`  ${label}: ${displayValue(skill.name)}`, `    File: ${displayValue(shortenPath(skill.filePath))}`);
	const plugin = skill._source?.pluginName;
	lines.push(`    Source: ${displayValue(skill.source)}${plugin ? `; package ${displayValue(plugin)}` : ""}`);
}

/** Read-only resolution report. Never included in model instructions or session history. */
export function formatSkillDiagnostics(diagnostics: readonly SkillDiagnostic[]): string {
	if (diagnostics.length === 0) return "No conflicting skill variants or redundant installations.";
	const lines = [summarizeSkillDiagnostics(diagnostics).message];
	for (const diagnostic of diagnostics) {
		lines.push("", displayValue(diagnostic.name));
		const selected = diagnostic.skills.find(skill => skill.name === diagnostic.name);
		if (selected) {
			appendSkill(lines, "Default", selected);
			lines.push(`    Selection: ${SELECTION_REASONS[diagnostic.reason]}`);
		} else {
			lines.push("  No bare default is included; invoke a namespaced variant explicitly.");
		}
		for (const skill of diagnostic.skills) {
			if (skill !== selected) appendSkill(lines, "Variant", skill);
		}
		for (const duplicate of diagnostic.duplicates) {
			appendSkill(lines, "Redundant copy", duplicate.skill);
			lines.push(
				`    Identical to: ${displayValue(duplicate.retained.name)} (${displayValue(shortenPath(duplicate.retained.filePath))})`,
			);
		}
	}
	lines.push(
		"",
		"Invoke a variant with /skill:<name> or skill://<name>. Same names do not imply the same skill lineage.",
	);
	return lines.join("\n");
}
