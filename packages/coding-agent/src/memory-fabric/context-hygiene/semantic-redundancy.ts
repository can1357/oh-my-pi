/**
 * Adaptive Context Hygiene — semantic redundancy collapse (ACF CH9).
 *
 * Collapses *near-duplicate* context items — passages that say the same thing
 * in different words — that survive the byte-exact CH2 deduper
 * (ADAPTIVE_CONTEXT_FIDELITY_PLAN.md §7 CH9: "Near-duplicate collapse; NIM
 * stays optional/shadow"; §10 concept adaptation). Where CH2 removes only
 * character-for-character copies, CH9 removes semantically redundant copies —
 * but only ever the *least* protected ones, and by default it does not remove
 * anything at all: it runs in shadow ("observe") mode and merely reports the
 * collapse it WOULD perform.
 *
 * Why this is safe for authoritative truth (plan §3, rules #1, #3, #13, #15):
 *   - F0/F1 content is inviolable. Protected items (F0, F1, no-compression
 *     zones, anything the caller marks `preserved`) are NEVER removed as a
 *     near-duplicate. When in doubt the collapser fails *toward preservation*.
 *   - Semantic collapse runs AFTER exact dedup and AFTER classification, so it
 *     only ever sees fidelity-tagged items and can honour the F0–F4 caps.
 *   - The surviving canonical is one of the original items, verbatim — CH9
 *     never synthesises new text (it is not a summarizer). No byte of a kept
 *     item is altered; redundant *copies* are dropped, not their information.
 *   - Provenance of every collapsed copy is merged onto the canonical (rule #1).
 *   - "NIM stays optional/shadow": similarity is computed by an injectable
 *     {@link SimilarityScorer} PORT. The default is a dependency-free lexical
 *     token-cosine scorer, so nothing external (no NIM, no embedding service)
 *     is ever required. A real embedding provider can be adapted in via
 *     {@link scorerFromEmbeddingPort}, but it is never wired by default.
 *   - Fail-open: on ANY error the original list is returned untouched (rule #4).
 *
 * Additive, injectable, disabled by default. NOT wired into the hygiene gate
 * (`pipeline.ts`) — CH9 stays optional/shadow until a later observe → suggest →
 * active rollout phase. Non-mutating on the caller's input.
 */

import { countTokens, heuristicTokenCounter, type TokenCounter } from "../token-accounting/token-accounting";
import type { ContextItem, FidelityClass, ItemProvenance } from "./types";
import { PRESERVED_CLASSES } from "./types";

export const COLLAPSER_NAME = "acf-semantic-redundancy-collapser";
export const COLLAPSER_VERSION = "ch9-1";

/** Default near-duplicate cutoff. Deliberately HIGH so only true paraphrases collapse. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.9;

/** Default cap on pairwise similarity comparisons (bounds the O(n·k) cost). */
export const DEFAULT_MAX_COMPARISONS = 20000;

/** shadow = measure only (never remove); active = emit the collapsed packet. */
export type SemanticRedundancyMode = "observe" | "active";

/**
 * A pluggable similarity scorer — the "optional NIM" seam. Given two texts it
 * returns a similarity in [0, 1] (1 = identical meaning). Implementations MUST
 * be pure and SHOULD be symmetric; they MAY throw — callers go through the
 * collapser, which fails open. The default is lexical and dependency-free.
 */
export interface SimilarityScorer {
	readonly name: string;
	readonly version: string;
	similarity(a: string, b: string): number;
}

/**
 * An optional embedding provider (e.g. a NIM / hosted embedder). Never used by
 * default; adapt it into a {@link SimilarityScorer} via {@link scorerFromEmbeddingPort}.
 */
export interface EmbeddingPort {
	readonly name: string;
	readonly version: string;
	embed(text: string): number[];
}

// ---------------------------------------------------------------------------
// Default lexical (token-cosine) scorer — dependency-free, deterministic.
// ---------------------------------------------------------------------------

const LEXICAL_SCORER_NAME = "acf-lexical-cosine";
const LEXICAL_SCORER_VERSION = "ch9-1";

/** Lowercase, split on non-alphanumerics, keep hyphenated tokens. */
function tokenize(text: string): string[] {
	if (!text) return [];
	return text
		.toLowerCase()
		.split(/[^a-z0-9-]+/)
		.filter(t => t.length > 0);
}

/** Term-frequency map for a token list. */
function termFrequencies(tokens: string[]): Map<string, number> {
	const tf = new Map<string, number>();
	for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
	return tf;
}

/** Cosine similarity of two term-frequency vectors, in [0, 1]. */
function cosineOfTf(a: Map<string, number>, b: Map<string, number>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let dot = 0;
	for (const [term, av] of a) {
		const bv = b.get(term);
		if (bv !== undefined) dot += av * bv;
	}
	if (dot === 0) return 0;
	let na = 0;
	for (const v of a.values()) na += v * v;
	let nb = 0;
	for (const v of b.values()) nb += v * v;
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : Math.max(0, Math.min(1, dot / denom));
}

/**
 * The default similarity scorer: token-cosine over term frequencies. Pure,
 * deterministic, symmetric, and dependency-free — so CH9 needs no external
 * service. Identical strings score 1; disjoint vocabularies score 0.
 */
export const lexicalSimilarityScorer: SimilarityScorer = {
	name: LEXICAL_SCORER_NAME,
	version: LEXICAL_SCORER_VERSION,
	similarity(a: string, b: string): number {
		if (a === b) return 1;
		return cosineOfTf(termFrequencies(tokenize(a)), termFrequencies(tokenize(b)));
	},
};

/** Cosine similarity of two numeric embedding vectors, clamped to [0, 1]. */
export function cosineOfVectors(a: number[], b: number[]): number {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	if (denom === 0) return 0;
	return Math.max(0, Math.min(1, dot / denom));
}

/**
 * Adapt an optional embedding provider (NIM / hosted embedder) into a
 * {@link SimilarityScorer} using cosine of the embeddings. Embeddings are
 * memoised per call-site via a small cache. This is the ONLY place a NIM would
 * plug in, and it is opt-in.
 */
export function scorerFromEmbeddingPort(port: EmbeddingPort): SimilarityScorer {
	const cache = new Map<string, number[]>();
	const embedCached = (text: string): number[] => {
		let v = cache.get(text);
		if (v === undefined) {
			v = port.embed(text);
			cache.set(text, v);
		}
		return v;
	};
	return {
		name: `acf-embedding-cosine:${port.name}`,
		version: port.version,
		similarity(a: string, b: string): number {
			if (a === b) return 1;
			return cosineOfVectors(embedCached(a), embedCached(b));
		},
	};
}

// ---------------------------------------------------------------------------
// Collapse types
// ---------------------------------------------------------------------------

/** A near-duplicate copy that was collapsed into a canonical item. */
export interface CollapsedDuplicate {
	/** Origin id of the removed near-duplicate (retained provenance). */
	originId: string;
	/** Source of the removed near-duplicate, when known. */
	source?: string;
	/** Position of the removed copy in the input list. */
	index: number;
	/** Similarity to the canonical that absorbed it, in [0, 1]. */
	similarity: number;
}

/** Record of one collapsed near-duplicate, returned for auditability. */
export interface CollapsedRecord extends CollapsedDuplicate {
	/** Id of the canonical item this copy was merged into. */
	canonicalId: string;
	/** Fidelity of the removed copy (only non-protected classes are ever here). */
	fidelity?: FidelityClass;
}

/** A kept item, extended with a record of any near-duplicates it absorbed. */
export interface CollapsedContextItem extends ContextItem {
	provenance: Partial<ItemProvenance> & {
		semanticDuplicatesMerged?: CollapsedDuplicate[];
		collapser?: string;
		collapserVersion?: string;
		collapsedAt?: string;
	};
}

/** Deterministic before/after telemetry for the collapse step (rule #4). */
export interface SemanticRedundancyTelemetry {
	collapser: string;
	collapserVersion: string;
	scorer: string;
	scorerVersion: string;
	mode: SemanticRedundancyMode;
	threshold: number;
	inputCount: number;
	/** Kept items in the proposal (canonicals + protected + uniques). */
	keptCount: number;
	/** Near-duplicates collapsed in the proposal. */
	collapsedCount: number;
	/** Pairwise comparisons performed (bounded by maxComparisons). */
	comparisons: number;
	/** True when the comparison cap was hit and later items were left intact. */
	comparisonCapHit: boolean;
	tokensBefore: number;
	/** Tokens of the PROPOSAL (what active mode would emit). */
	tokensAfter: number;
	approxTokensSaved: number;
	collapsedAt: string;
	/** True when the step caught an error and returned the input unchanged. */
	failedOpen: boolean;
}

export interface SemanticRedundancyResult {
	/**
	 * What the caller should USE:
	 *   - observe (default): the ORIGINAL items, unchanged (shadow mode).
	 *   - active: the collapsed packet (same as `proposal`).
	 */
	items: CollapsedContextItem[];
	/** What active mode WOULD emit regardless of mode (canonicals, in order). */
	proposal: CollapsedContextItem[];
	/** Near-duplicates collapsed, in input order. */
	collapsed: CollapsedRecord[];
	telemetry: SemanticRedundancyTelemetry;
}

export interface SemanticRedundancyOptions {
	/** Default "observe" — measure only, never remove (rule #11, shadow). */
	mode?: SemanticRedundancyMode;
	/** Injectable similarity scorer (the optional-NIM seam). Default: lexical. */
	scorer?: SimilarityScorer;
	/** Similarity ≥ this ⇒ near-duplicate. Default {@link DEFAULT_SIMILARITY_THRESHOLD}. */
	threshold?: number;
	/**
	 * Returns true for items that must never be removed as a near-duplicate.
	 * Default: F0/F1 (preserved classes), no-compression zones, and anything
	 * flagged `preserved`. Protected items may still act as a canonical.
	 */
	isProtected?: (item: ContextItem) => boolean;
	/** How to read an item's fidelity class (default: `item.fidelity`). */
	fidelityOf?: (item: ContextItem) => FidelityClass | undefined;
	/**
	 * When true (default), empty/whitespace-only items are always kept and never
	 * treated as near-duplicates — empty content carries meaning only through
	 * provenance.
	 */
	skipEmpty?: boolean;
	/** Hard cap on pairwise comparisons. Default {@link DEFAULT_MAX_COMPARISONS}. */
	maxComparisons?: number;
	/** Token counter for telemetry (default heuristic; rule #16 seam). */
	counter?: TokenCounter;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

/** Read a fidelity class from an item, if it carries one (ClassifiedContextItem does). */
function defaultFidelityOf(item: ContextItem): FidelityClass | undefined {
	const f = (item as { fidelity?: unknown }).fidelity;
	return typeof f === "string" && (f === "F0" || f === "F1" || f === "F2" || f === "F3" || f === "F4")
		? (f as FidelityClass)
		: undefined;
}

/**
 * Default protection predicate: never collapse F0/F1, no-compression zones, or
 * anything the caller flags `preserved`. Fails toward preservation.
 */
function defaultIsProtected(item: ContextItem, fidelityOf: (i: ContextItem) => FidelityClass | undefined): boolean {
	if (item.noCompression === true) return true;
	if ((item as { preserved?: unknown }).preserved === true) return true;
	const f = fidelityOf(item);
	return f !== undefined && PRESERVED_CLASSES.has(f);
}

function isEmptyContent(content: string): boolean {
	return content.trim().length === 0;
}

function sumTokens(items: { content: string }[], counter: TokenCounter): number {
	let total = 0;
	for (const it of items) total += countTokens(it.content, counter).tokens;
	return total;
}

/** Shallow-clone an item into a CollapsedContextItem without mutating input. */
function toCollapsed(item: ContextItem): CollapsedContextItem {
	const provenance: CollapsedContextItem["provenance"] = { ...(item.provenance ?? {}) };
	if (provenance.originId === undefined) provenance.originId = item.id;
	if (provenance.source === undefined && item.source !== undefined) provenance.source = item.source;
	return { ...item, provenance };
}

/** Record a collapsed near-duplicate on the canonical (non-mutating on the original). */
function appendCollapse(canonical: CollapsedContextItem, merged: CollapsedDuplicate, at: string): void {
	const list = canonical.provenance.semanticDuplicatesMerged ?? [];
	list.push(merged);
	canonical.provenance.semanticDuplicatesMerged = list;
	canonical.provenance.collapser = COLLAPSER_NAME;
	canonical.provenance.collapserVersion = COLLAPSER_VERSION;
	canonical.provenance.collapsedAt = at;
}

/**
 * Collapse semantically near-duplicate items, stable and first-wins.
 *
 * Guarantees:
 *   - Only NON-protected items are ever removed; F0/F1, no-compression zones,
 *     and `preserved` items always survive (plan §3, rule #13).
 *   - The first occurrence of a cluster is always kept as the canonical,
 *     verbatim; later near-duplicates are dropped and their provenance merged.
 *   - Shadow by default: in "observe" mode the returned `items` are the caller's
 *     original array, untouched, while `proposal`/`collapsed` describe what
 *     "active" mode WOULD do.
 *   - Bounded cost: at most `maxComparisons` pairwise similarity calls; once the
 *     cap is hit, remaining items are kept intact (a safe partial).
 *   - Fail-open: on any internal error the original list is returned unchanged.
 */
export function collapseSemanticRedundancy(
	items: ContextItem[],
	options: SemanticRedundancyOptions = {},
): SemanticRedundancyResult {
	const now = options.now ?? (() => new Date());
	const collapsedAt = now().toISOString();
	const counter = options.counter ?? heuristicTokenCounter;
	const scorer = options.scorer ?? lexicalSimilarityScorer;
	const mode: SemanticRedundancyMode = options.mode ?? "observe";
	const threshold = clampThreshold(options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD);
	const maxComparisons = options.maxComparisons ?? DEFAULT_MAX_COMPARISONS;
	const skipEmpty = options.skipEmpty ?? true;
	const fidelityOf = options.fidelityOf ?? defaultFidelityOf;
	const isProtected = options.isProtected ?? ((item: ContextItem) => defaultIsProtected(item, fidelityOf));

	const inputCount = items.length;
	const tokensBefore = sumTokens(items, counter);

	try {
		const kept: CollapsedContextItem[] = [];
		const collapsed: CollapsedRecord[] = [];
		// Canonicals eligible to ABSORB near-duplicates (non-protected, non-empty).
		const canonicals: CollapsedContextItem[] = [];
		let comparisons = 0;
		let comparisonCapHit = false;

		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			const empty = skipEmpty && isEmptyContent(item.content);
			const protectedItem = isProtected(item);

			// Protected/empty items are always kept and never removed. They do not
			// absorb near-duplicates either (we never want to fold distinct copies
			// into a protected authoritative item).
			if (protectedItem || empty) {
				kept.push(toCollapsed(item));
				continue;
			}

			// Try to fold this item into an existing canonical.
			let matched: { canonical: CollapsedContextItem; similarity: number } | undefined;
			for (const canonical of canonicals) {
				if (comparisons >= maxComparisons) {
					comparisonCapHit = true;
					break;
				}
				comparisons++;
				const sim = safeSimilarity(scorer, item.content, canonical.content);
				if (sim >= threshold) {
					matched = { canonical, similarity: sim };
					break; // first-wins
				}
			}

			if (matched) {
				const merged: CollapsedDuplicate = {
					originId: item.provenance?.originId ?? item.id,
					source: item.source ?? item.provenance?.source,
					index,
					similarity: matched.similarity,
				};
				appendCollapse(matched.canonical, merged, collapsedAt);
				collapsed.push({ ...merged, canonicalId: matched.canonical.id, fidelity: fidelityOf(item) });
				continue;
			}

			// No match (or cap hit): keep it, and let it act as a future canonical.
			const clone = toCollapsed(item);
			kept.push(clone);
			canonicals.push(clone);
		}

		const tokensAfter = sumTokens(kept, counter);
		const telemetry: SemanticRedundancyTelemetry = {
			collapser: COLLAPSER_NAME,
			collapserVersion: COLLAPSER_VERSION,
			scorer: scorer.name,
			scorerVersion: scorer.version,
			mode,
			threshold,
			inputCount,
			keptCount: kept.length,
			collapsedCount: collapsed.length,
			comparisons,
			comparisonCapHit,
			tokensBefore,
			tokensAfter,
			approxTokensSaved: tokensBefore - tokensAfter,
			collapsedAt,
			failedOpen: false,
		};

		// Shadow: observe returns originals untouched; active returns the proposal.
		const emitted: CollapsedContextItem[] = mode === "active" ? kept : items.map(toCollapsed);
		return { items: emitted, proposal: kept, collapsed, telemetry };
	} catch {
		// Fail open (rule #4): emit the safe original, unchanged.
		const passthrough = items.map(toCollapsed);
		return {
			items: passthrough,
			proposal: passthrough,
			collapsed: [],
			telemetry: {
				collapser: COLLAPSER_NAME,
				collapserVersion: COLLAPSER_VERSION,
				scorer: scorer.name,
				scorerVersion: scorer.version,
				mode,
				threshold,
				inputCount,
				keptCount: passthrough.length,
				collapsedCount: 0,
				comparisons: 0,
				comparisonCapHit: false,
				tokensBefore,
				tokensAfter: tokensBefore,
				approxTokensSaved: 0,
				collapsedAt,
				failedOpen: true,
			},
		};
	}
}

/** Similarity that never throws (a bad scorer must not break the pipeline). */
function safeSimilarity(scorer: SimilarityScorer, a: string, b: string): number {
	try {
		const s = scorer.similarity(a, b);
		if (!Number.isFinite(s)) return 0;
		return Math.max(0, Math.min(1, s));
	} catch {
		return 0; // treat as "not a duplicate" — fail toward preservation.
	}
}

function clampThreshold(t: number): number {
	if (!Number.isFinite(t)) return DEFAULT_SIMILARITY_THRESHOLD;
	return Math.max(0, Math.min(1, t));
}

/** Build a drop-in collapser hook with options pre-bound. */
export function makeSemanticCollapser(
	options: SemanticRedundancyOptions = {},
): (items: ContextItem[]) => SemanticRedundancyResult {
	return items => collapseSemanticRedundancy(items, options);
}
