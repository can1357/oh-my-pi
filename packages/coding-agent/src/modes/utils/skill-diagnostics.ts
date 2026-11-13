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
	const provenance = skill._source?.provenance;
	if (provenance) {
		const version = provenance.version ? ` ${displayValue(provenance.version)}` : "";
		lines.push(`    Origin: ${displayValue(provenance.repository)}${version}`);
	}
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
		const selectedRepository = selected?._source?.provenance?.repository;
		for (const skill of diagnostic.skills) {
			if (skill === selected) continue;
			appendSkill(lines, "Variant", skill);
			if (selectedRepository !== undefined && skill._source?.provenance?.repository === selectedRepository) {
				lines.push("    Same origin as the default; skills.dedupeSameOrigin would hide this variant.");
			}
		}
		for (const duplicate of diagnostic.duplicates) {
			const retained = `${displayValue(duplicate.retained.name)} (${displayValue(shortenPath(duplicate.retained.filePath))})`;
			if (duplicate.match === "origin") {
				appendSkill(lines, "Same-origin variant", duplicate.skill);
				lines.push(`    Hidden in favor of: ${retained}`);
			} else {
				appendSkill(lines, "Redundant copy", duplicate.skill);
				lines.push(`    Identical to: ${retained}`);
			}
		}
	}
	lines.push(
		"",
		"Invoke a variant with /skill:<name> or skill://<name>. Same names do not imply the same skill lineage; Origin is the source repository a plugin declares.",
	);
	return lines.join("\n");
}
