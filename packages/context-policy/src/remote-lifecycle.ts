import { DEFAULT_CONTEXT_POLICY } from "./default-policy";
import { CONTEXT_CATEGORIES, type ContextCategory, type ContextCategoryRetention } from "./types";

/**
 * Canonical S3 key prefix for a category's remote artifacts. Every uploader
 * and every lifecycle rule must derive prefixes from this function; the
 * category name itself is the prefix, so no separate mapping table can drift.
 */
export function remotePrefixForCategory(category: ContextCategory): string {
	return `${category}/`;
}

export interface RemoteLifecycleCategory {
	category: ContextCategory;
	prefix: string;
	retention: ContextCategoryRetention;
}

/**
 * Complete category-to-prefix-to-retention mapping for remote artifacts.
 * Iterating CONTEXT_CATEGORIES (rather than the JSON object's keys) makes a
 * missing policy entry fail immediately when a category is added.
 */
export function remoteLifecycleCategories(): RemoteLifecycleCategory[] {
	return CONTEXT_CATEGORIES.map(category => {
		const retention = DEFAULT_CONTEXT_POLICY.categories[category];
		if (!retention) throw new Error(`Missing retention policy for context category: ${category}`);
		return { category, prefix: remotePrefixForCategory(category), retention };
	});
}

export interface StaticExpiry {
	category: ContextCategory;
	prefix: string;
	ttlDays: number;
	noncurrentDays: number;
}

/**
 * Categories whose retention is a fixed day count and therefore enforceable
 * by a static bucket lifecycle rule. Categories with governed or
 * case-closed retention (`workflow_state`, `final_deliverable`) are excluded:
 * their deletion is driven by the application deletion path, never by a
 * static lifecycle rule.
 */
export function staticallyExpiringCategories(): StaticExpiry[] {
	const out: StaticExpiry[] = [];
	for (const { category, prefix, retention } of remoteLifecycleCategories()) {
		if (retention.ttlDays === undefined) continue;
		out.push({
			category,
			prefix,
			ttlDays: retention.ttlDays,
			noncurrentDays: retention.ttlDays,
		});
	}
	return out;
}
