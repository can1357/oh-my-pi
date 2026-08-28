/**
 * Adaptive Context Hygiene — fidelity classification types (ACF CH3).
 *
 * Every context item entering the hygiene gate is assigned exactly one
 * fidelity class F0–F4 (see ADAPTIVE_CONTEXT_FIDELITY_PLAN.md §3). The class
 * is a *cap* on how aggressively the item may later be transformed; it never
 * forces a transform. Classification is safety-critical: a misclassification
 * that downgrades F0/F1 content is the highest-severity defect, so the
 * classifier fails *toward preservation* (higher fidelity) when uncertain.
 *
 * This module is additive, injectable, and disabled by default — nothing wires
 * it into the hot path. It only assigns a class + retained provenance.
 */

/**
 * Fidelity class, ordered from most protected (F0) to least (F4).
 *  - F0 Immutable exact       — verbatim; never transformed, reordered, omitted.
 *  - F1 Authoritative compactable — lossless compaction only; never omitted.
 *  - F2 Evidence-backed projectable — project to signatures/excerpts + pointer.
 *  - F3 Optional compressible  — may be summarized/omitted when budget allows.
 *  - F4 Reject-before-context  — dropped before it ever reaches the model.
 */
export type FidelityClass = "F0" | "F1" | "F2" | "F3" | "F4";

/** The transforms a class permits. F0 permits only `none` (verbatim). */
export type TransformKind =
	| "none"
	| "lossless-compaction"
	| "project"
	| "reference"
	| "excerpt"
	| "expand-on-demand"
	| "summarize"
	| "omit"
	| "drop";

/** Provenance carried with an item; retained and extended by the classifier. */
export interface ItemProvenance {
	/** The item's own id (retained verbatim). */
	originId: string;
	/** Where the item came from (e.g. a Memory Fabric lane, tool, retrieval). */
	source?: string;
	/** Optional upstream provenance chain, preserved as-is. */
	chain?: string[];
	[key: string]: unknown;
}

/** A retrieved context item presented to the classifier. */
export interface ContextItem {
	id: string;
	/** The item's textual content (already redacted upstream where applicable). */
	content: string;
	/** Where the item originated (Memory Fabric lane, tool name, etc.). */
	source?: string;
	/**
	 * Optional semantic hint about what this item is. Hints are trusted over
	 * content heuristics when present (e.g. "security", "decision", "evidence").
	 */
	type?: string;
	/** Free-form tags; matched case-insensitively against rule keywords. */
	tags?: string[];
	/**
	 * No-compression zone (plan rule #15): when true the item is passed through
	 * untouched regardless of class — allowed transforms collapse to `none`.
	 */
	noCompression?: boolean;
	/** Explicit reject signal — forces F4 (unless it is also F0 safety content). */
	reject?: boolean;
	/** Existing provenance to retain. */
	provenance?: Partial<ItemProvenance>;
	[key: string]: unknown;
}

/** The result of classifying one item. */
export interface ClassifiedContextItem {
	id: string;
	content: string;
	source?: string;
	fidelity: FidelityClass;
	/** Transforms permitted for this class (capped further by no-compression). */
	allowedTransforms: TransformKind[];
	/** Human-readable justification for the assigned class. */
	reason: string;
	/** Id of the rule that fired (or a sentinel like `default`/`fail-safe`). */
	ruleId: string;
	/** Signals that matched, for auditability. */
	matchedSignals: string[];
	/** Retained + extended provenance. */
	provenance: ItemProvenance & {
		classifier: string;
		classifierVersion: string;
		classifiedAt: string;
		ruleId: string;
	};
	/** True when this class must never be omitted/dropped (F0, F1). */
	preserved: boolean;
	/** True when no-compression forced allowedTransforms to `none`. */
	noCompression: boolean;
}

/** A single deterministic classification rule (ordered; first match wins). */
export interface ClassificationRule {
	id: string;
	class: FidelityClass;
	reason: string;
	/** Returns matched signal names when the rule fires, else null. */
	match: (item: ContextItem) => string[] | null;
}

export interface ClassifyOptions {
	/** Override the default ordered rule set. */
	rules?: ClassificationRule[];
	/** Class assigned when no rule matches. Defaults to F1 (fail-safe). */
	defaultClass?: FidelityClass;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

export const CLASSIFIER_NAME = "acf-fidelity-classifier";
export const CLASSIFIER_VERSION = "ch3-1";

/** Ordering helper: lower index = higher fidelity / more protected. */
export const FIDELITY_ORDER: readonly FidelityClass[] = ["F0", "F1", "F2", "F3", "F4"];

/** Classes whose content must never be omitted or dropped. */
export const PRESERVED_CLASSES: ReadonlySet<FidelityClass> = new Set<FidelityClass>(["F0", "F1"]);

/** The transforms each class permits, in priority order. */
export const ALLOWED_TRANSFORMS: Record<FidelityClass, TransformKind[]> = {
	F0: ["none"],
	F1: ["lossless-compaction"],
	F2: ["project", "reference", "excerpt", "expand-on-demand"],
	F3: ["summarize", "omit"],
	F4: ["drop"],
};
