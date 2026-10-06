import type { SkillDiagnostic, SkillSelectionReason } from "../../extensibility/skills";

export const SELECTION_REASONS: Record<SkillSelectionReason, string> = {
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
