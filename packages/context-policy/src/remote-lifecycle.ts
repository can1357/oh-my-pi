import { DEFAULT_CONTEXT_POLICY } from "./default-policy";
import type { ContextCategory, ContextCategoryRetention } from "./types";

/**
 * Canonical S3 key prefix for a category's remote artifacts. Every uploader
 * and every lifecycle rule must derive prefixes from this function; the
 * category name itself is the prefix, so no separate mapping table can drift.
 */
export function remotePrefixForCategory(category: ContextCategory): string {
	return `${category}/`;
}

export interface StaticExpiry {
	category: ContextCategory;
	prefix: string;
	ttlDays: number;
}

/**
 * Categories whose retention is a fixed day count and therefore enforceable
 * by a static bucket lifecycle rule. Categories with governed or
 * case-closed retention (`workflow_state`, `final_deliverable`) are excluded:
 * their deletion is driven by the application deletion path, never by a
 * static lifecycle rule.
 */
export function staticallyExpiringCategories(): StaticExpiry[] {
	const entries = Object.entries(DEFAULT_CONTEXT_POLICY.categories) as [ContextCategory, ContextCategoryRetention][];
	const out: StaticExpiry[] = [];
	for (const [category, rule] of entries) {
		if (rule.ttlDays === undefined) continue;
		out.push({ category, prefix: remotePrefixForCategory(category), ttlDays: rule.ttlDays });
	}
	return out;
}
