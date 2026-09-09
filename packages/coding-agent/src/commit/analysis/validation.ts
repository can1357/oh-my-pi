import type { ConventionalAnalysis } from "../../commit/types";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateSummary(summary: string, maxChars: number): ValidationResult {
	const errors: string[] = [];
	if (!summary.trim()) {
		errors.push("Summary is empty");
	}
	if (summary.length > maxChars) {
		errors.push(`Summary exceeds ${maxChars} characters`);
	}
	if (summary.trimEnd().endsWith(".")) {
		errors.push("Summary must not end with a period");
	}
	if (summary.includes("\n")) {
		errors.push("Summary must be a single line");
	}
	return { valid: errors.length === 0, errors };
}

export function validateScope(scope: string | null): ValidationResult {
	if (!scope) return { valid: true, errors: [] };
	const errors: string[] = [];
	const segments = scope.split("/");
	if (segments.length > 2) {
		errors.push("Scope may contain at most two segments");
	}
	for (const segment of segments) {
		if (!segment) {
			errors.push("Scope segments cannot be empty");
			continue;
		}
		if (segment !== segment.toLowerCase()) {
			errors.push("Scope must be lowercase");
		}
		if (!/^[a-z0-9][a-z0-9-_]*$/.test(segment)) {
			errors.push(`Scope segment has invalid characters: ${segment}`);
		}
	}
	return { valid: errors.length === 0, errors };
}

export function validateAnalysis(analysis: ConventionalAnalysis): ValidationResult {
	const errors: string[] = [];
	const scopeResult = validateScope(analysis.scope);
	if (!scopeResult.valid) {
		errors.push(...scopeResult.errors);
	}
	for (const detail of analysis.details) {
		if (!detail.text.trim()) {
			errors.push("Detail text is empty");
			continue;
		}
		if (!detail.text.trim().endsWith(".")) {
			errors.push(`Detail must end with a period: ${detail.text}`);
		}
		if (detail.text.length > 120) {
			errors.push(`Detail exceeds 120 characters: ${detail.text}`);
		}
	}
	return { valid: errors.length === 0, errors };
}
