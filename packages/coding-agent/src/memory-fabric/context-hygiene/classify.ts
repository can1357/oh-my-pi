/**
 * Adaptive Context Hygiene — fidelity classifier (ACF CH3).
 *
 * Assigns each context item exactly one fidelity class (F0–F4) with retained
 * provenance, using a deterministic, ordered rule set (first match wins).
 *
 * Safety posture (ADAPTIVE_CONTEXT_FIDELITY_PLAN.md §3, §4):
 *  - F0 is detected FIRST, before the F4 reject rule, so a security warning is
 *    never dropped just because it also looks out-of-scope.
 *  - When no rule matches, the item defaults to F1 (authoritative) — "when in
 *    doubt, classify higher fidelity (fail toward preservation)".
 *  - Any error while classifying an item fails safe to F0 (verbatim) rather
 *    than throwing — a classifier error must never downgrade or drop content.
 *  - `noCompression` items collapse allowed transforms to `none` regardless of
 *    class (plan rule #15, no-compression zones).
 *
 * Nothing here mutates item content or provenance semantics; it only reads.
 */

import {
	ALLOWED_TRANSFORMS,
	CLASSIFIER_NAME,
	CLASSIFIER_VERSION,
	type ClassificationRule,
	type ClassifiedContextItem,
	type ClassifyOptions,
	type ContextItem,
	type FidelityClass,
	type ItemProvenance,
	PRESERVED_CLASSES,
} from "./types";

/** The classifier-stamped provenance shape produced for every item. */
type ClassifiedProvenance = ClassifiedContextItem["provenance"];

// --- signal matchers -------------------------------------------------------

function hintText(item: ContextItem): string {
	// Trusted structured hints (type + tags) matched case-insensitively.
	return [item.type ?? "", ...(item.tags ?? [])].join(" ").toLowerCase();
}

function hasAny(haystack: string, needles: string[]): string[] {
	const hits: string[] = [];
	for (const n of needles) {
		if (haystack.includes(n)) hits.push(n);
	}
	return hits;
}

// F0 — immutable-exact safety signals (highest priority).
const F0_HINTS = [
	"security",
	"secret",
	"credential",
	"destructive",
	"confirmation",
	"rollback",
	"exit-code",
	"exitcode",
	"failure-status",
	"validation",
	"vulnerability",
];
const F0_CONTENT: Array<[string, RegExp]> = [
	["exit-code", /\bexit(?:[ _-]?code|[ _-]?status)\b/i],
	[
		"destructive-op",
		/\b(rm\s+-rf|force[- ]?push|git\s+push\s+--force|drop\s+table|truncate\s+table|mkfs|dd\s+if=)\b/i,
	],
	["irreversible", /\b(irreversible|cannot be undone|destructive operation)\b/i],
	["secret-notice", /\b(api[_ -]?key|access[_ -]?token|private key|password|credential|secret)\b/i],
	["security-warning", /\b(security warning|vulnerabilit(?:y|ies)|CVE-\d{4}-\d+)\b/i],
	["rollback", /\brollback\b/i],
	["validation-status", /\bvalidation (?:failed|passed|error|result)\b/i],
	["failure-status", /\bfailure status\b/i],
];

// F1 — authoritative-compactable signals.
const F1_HINTS = [
	"decision",
	"procedure",
	"working-state",
	"working_state",
	"policy",
	"invariant",
	"requirement",
	"authoritative",
];
const F1_CONTENT: Array<[string, RegExp]> = [
	["decision", /\b(decided|decision:|we will|chosen approach|agreed to)\b/i],
	["procedure", /\b(procedure|runbook|steps to|step \d+\b)\b/i],
	["invariant", /\b(invariant|must not|must always|non-negotiable)\b/i],
];

// F2 — evidence-backed projectable signals.
const F2_HINTS = ["evidence", "code", "log", "diff", "memvid", "graphify", "snippet", "trace"];
const F2_CONTENT: Array<[string, RegExp]> = [
	["git-diff", /^diff --git |^@@ .* @@/m],
	["code-fence", /```[\s\S]*```/],
	["stack-trace", /^\s+at .+:\d+:\d+/m],
];

// F3 — optional-compressible signals.
const F3_HINTS = ["episodic", "chatter", "history", "superseded", "note", "scratch", "low-signal"];
const F3_CONTENT: Array<[string, RegExp]> = [
	["superseded", /\b(superseded|obsolete|no longer relevant|deprecated note)\b/i],
];

// F4 — reject-before-context signals (evaluated AFTER F0).
const F4_HINTS = ["out-of-scope", "out_of_scope", "irrelevant", "reject", "unsafe-scope", "spam"];

/**
 * Default ordered rule set. Order encodes priority; F0 is intentionally first
 * and F4 comes after F0/F1 so protected content is never rejected.
 */
export function defaultRules(): ClassificationRule[] {
	return [
		{
			id: "f0-safety",
			class: "F0",
			reason: "immutable-exact safety content (security / exit code / destructive / validation)",
			match: item => {
				const hints = hasAny(hintText(item), F0_HINTS);
				const content = F0_CONTENT.filter(([, re]) => re.test(item.content)).map(([name]) => name);
				const hits = [...hints.map(h => `hint:${h}`), ...content];
				return hits.length > 0 ? hits : null;
			},
		},
		{
			id: "f4-reject",
			class: "F4",
			reason: "out-of-scope / unsafe / explicitly rejected content",
			match: item => {
				const hits: string[] = [];
				if (item.reject === true) hits.push("flag:reject");
				hits.push(...hasAny(hintText(item), F4_HINTS).map(h => `hint:${h}`));
				return hits.length > 0 ? hits : null;
			},
		},
		{
			id: "f1-authoritative",
			class: "F1",
			reason: "authoritative compactable (decision / procedure / working state / invariant)",
			match: item => {
				const hints = hasAny(hintText(item), F1_HINTS);
				const content = F1_CONTENT.filter(([, re]) => re.test(item.content)).map(([name]) => name);
				const hits = [...hints.map(h => `hint:${h}`), ...content];
				return hits.length > 0 ? hits : null;
			},
		},
		{
			id: "f2-evidence",
			class: "F2",
			reason: "evidence-backed projectable (code / diff / log / evidence)",
			match: item => {
				const hints = hasAny(hintText(item), F2_HINTS);
				const content = F2_CONTENT.filter(([, re]) => re.test(item.content)).map(([name]) => name);
				const hits = [...hints.map(h => `hint:${h}`), ...content];
				return hits.length > 0 ? hits : null;
			},
		},
		{
			id: "f3-optional",
			class: "F3",
			reason: "optional compressible (episodic / superseded / low-signal)",
			match: item => {
				const hints = hasAny(hintText(item), F3_HINTS);
				const content = F3_CONTENT.filter(([, re]) => re.test(item.content)).map(([name]) => name);
				const hits = [...hints.map(h => `hint:${h}`), ...content];
				return hits.length > 0 ? hits : null;
			},
		},
	];
}

const DEFAULT_RULES = defaultRules();

function buildProvenance(item: ContextItem, ruleId: string, classifiedAt: string): ClassifiedProvenance {
	const base: ItemProvenance = {
		originId: item.id,
		source: item.source,
		...item.provenance,
	};
	return {
		...base,
		originId: item.id,
		classifier: CLASSIFIER_NAME,
		classifierVersion: CLASSIFIER_VERSION,
		classifiedAt,
		ruleId,
	};
}

function finalize(
	item: ContextItem,
	fidelity: FidelityClass,
	ruleId: string,
	reason: string,
	matchedSignals: string[],
	classifiedAt: string,
): ClassifiedContextItem {
	const noCompression = item.noCompression === true;
	// No-compression zones (rule #15) collapse allowed transforms to `none`
	// while keeping the semantic class for downstream ordering/coverage.
	const allowedTransforms = noCompression ? ["none" as const] : [...ALLOWED_TRANSFORMS[fidelity]];
	return {
		id: item.id,
		content: item.content,
		source: item.source,
		fidelity,
		allowedTransforms,
		reason: noCompression ? `${reason} (no-compression zone: transforms pinned to none)` : reason,
		ruleId,
		matchedSignals,
		provenance: buildProvenance(item, ruleId, classifiedAt),
		preserved: PRESERVED_CLASSES.has(fidelity),
		noCompression,
	};
}

/**
 * Classify a single context item. Deterministic and fail-safe: any internal
 * error yields an F0 (verbatim) classification rather than throwing.
 */
export function classifyItem(item: ContextItem, options: ClassifyOptions = {}): ClassifiedContextItem {
	const now = options.now ?? (() => new Date());
	const classifiedAt = now().toISOString();
	try {
		const rules = options.rules ?? DEFAULT_RULES;
		for (const rule of rules) {
			const hits = rule.match(item);
			if (hits && hits.length > 0) {
				return finalize(item, rule.class, rule.id, rule.reason, hits, classifiedAt);
			}
		}
		const fallback = options.defaultClass ?? "F1";
		return finalize(
			item,
			fallback,
			"default",
			"no rule matched; defaulted to higher fidelity (fail toward preservation)",
			[],
			classifiedAt,
		);
	} catch {
		// Fail safe: never downgrade or drop on error. F0 = keep verbatim.
		return finalize(item, "F0", "fail-safe", "classifier error; failed safe to F0 (verbatim)", [], classifiedAt);
	}
}

/** Classify a batch of items, preserving input order. */
export function classifyItems(items: ContextItem[], options: ClassifyOptions = {}): ClassifiedContextItem[] {
	return items.map(item => classifyItem(item, options));
}

/** True when the class must be preserved (never omitted/dropped). */
export function isPreserved(fidelity: FidelityClass): boolean {
	return PRESERVED_CLASSES.has(fidelity);
}
