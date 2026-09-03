import type { CleanseDiagnostic, CleanseFileIssues, CleanseSeverity } from "./types";

const SEVERITY_WEIGHT: Record<CleanseSeverity, number> = {
	error: 5,
	warning: 3,
	info: 1,
};

/** Estimate repair burden from severity and available location/fix evidence. */
export function diagnosticWeight(diagnostic: CleanseDiagnostic): number {
	let weight = SEVERITY_WEIGHT[diagnostic.severity];
	if (diagnostic.line === undefined) weight += 2;
	if (!diagnostic.code) weight += 1;
	if (!diagnostic.suggestion) weight += 1;
	return weight;
}

/** Group diagnostics by file while keeping project-level failures together. */
export function groupDiagnosticsByFile(diagnostics: readonly CleanseDiagnostic[]): CleanseFileIssues[] {
	const groups = new Map<string, CleanseDiagnostic[]>();
	for (const diagnostic of diagnostics) {
		const key = diagnostic.file ?? "";
		const existing = groups.get(key);
		if (existing) existing.push(diagnostic);
		else groups.set(key, [diagnostic]);
	}
	return [...groups.entries()]
		.map(([file, entries]) => ({
			file: file || undefined,
			diagnostics: entries.sort(compareDiagnostics),
			weight: entries.reduce((sum, diagnostic) => sum + diagnosticWeight(diagnostic), 0),
		}))
		.sort((left, right) => right.weight - left.weight || (left.file ?? "").localeCompare(right.file ?? ""));
}

function compareDiagnostics(left: CleanseDiagnostic, right: CleanseDiagnostic): number {
	return (
		(left.line ?? 0) - (right.line ?? 0) ||
		(left.column ?? 0) - (right.column ?? 0) ||
		left.checker.localeCompare(right.checker) ||
		left.message.localeCompare(right.message)
	);
}
