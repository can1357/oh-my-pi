/**
 * Grant-derived codec hints for the evidence worker (no store access).
 */

import type { RlmView } from "./view";

/** Heuristic hints from granted excerpts — nudge atoms/contradictions without fixture ids. */
export function buildEvidenceGrantHints(view: RlmView): string[] {
	const hints: string[] = [];
	const texts = view.grants.map(g => ({ text: g.text, citation: g.citation }));

	const hasPoolLimit = texts.some(t => /pool_limit/i.test(t.text));
	const hasActiveConnections = texts.some(t => /active_connections/i.test(t.text));
	if (hasPoolLimit && hasActiveConnections) {
		hints.push(
			"Grants mention pool_limit and active_connections — emit separate atoms (key/value/citations) for each, then a causal claim supported by those atom ids.",
		);
	}

	const maxConnValues = new Set<string>();
	const poolLimitValues = new Set<string>();
	for (const { text } of texts) {
		const max = /max_connections\s*=\s*(\d+)/i.exec(text)?.[1];
		if (max) maxConnValues.add(max);
		const pool = /pool_limit\s*=\s*(\d+)/i.exec(text)?.[1];
		if (pool) poolLimitValues.add(pool);
	}
	if (maxConnValues.size > 0 && poolLimitValues.size > 0) {
		const disagree = [...maxConnValues].some(m => ![...poolLimitValues].includes(m));
		if (disagree) {
			hints.push(
				"Grants contain conflicting connection limits — populate contradictions[] with independently cited left/right values (config vs runtime), not prose-only conflict.",
			);
		}
	}

	if (texts.length >= 2 && hints.length === 0) {
		const keys = texts.flatMap(t => [...t.text.matchAll(/([a-z_]+)\s*=\s*([^\s,;]+)/gi)].map(m => `${m[1]}=${m[2]}`));
		if (new Set(keys).size >= 2) {
			hints.push("Multiple keyed facts appear across grants — preserve each decision-critical key as its own atom with citations.");
		}
	}

	if (hints.length === 0) return hints;
	return [
		"Citation handles MUST match grant headers exactly; byte ranges are absolute record offsets shown in each header.",
		...hints,
	];
}
