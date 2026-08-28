/**
 * Adaptive Context Fidelity — solution minimality gate (ACF CH7).
 *
 * The minimality gate answers one question before the agent writes code:
 * "does an equivalent capability already exist, so we should reuse or extend it
 * instead of rebuilding?" It places a proposed unit of work on the
 * reuse → extend → new ladder by matching it against a catalog of existing
 * capabilities. "Don't rebuild what exists."
 *
 * It is NOT a code generator and NOT a planner. It reads a proposed unit of
 * work ({@link SolutionIntent}) and a catalog of already-existing capabilities
 * from an injectable {@link CapabilityCatalogPort} (backed by a symbol index —
 * no new parser), and returns a {@link MinimalityAssessment}. It never blocks
 * or mutates work; it advises.
 *
 * Safety posture:
 *   - Advisory only: never blocks, never mutates the intent.
 *   - No new source of truth / no new parser: existing capabilities come
 *     exclusively from the injectable catalog port.
 *   - Fail-open: a throwing catalog defaults to "new" with `failedOpen: true` —
 *     it NEVER falsely asserts that something exists (which could wrongly
 *     suppress needed work). Failing open means "just build it".
 *   - Disabled by default: the default catalog is empty, so every intent
 *     resolves to "new" and the gate asserts nothing.
 *   - Deterministic: pure token-overlap scoring, stable tie-breaking by id.
 *   - Additive, injectable; not wired into any hot path.
 */

import { countTokens, heuristicTokenCounter, type TokenCounter } from "./token-accounting/token-accounting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The minimal-solution decision ladder, least-invasive first. */
export type MinimalityRung = "reuse" | "extend" | "new";

/** Ladder order, least-invasive first (reuse preferred over building new). */
export const MINIMALITY_LADDER: readonly MinimalityRung[] = ["reuse", "extend", "new"];

/** A proposed unit of work the agent is considering building. */
export interface SolutionIntent {
	id: string;
	/** Short description of what the agent wants to build or do. */
	summary: string;
	/** Structural kind of the proposed work (drives redundancy judgement). */
	kind?: "function" | "module" | "endpoint" | "feature" | "capability" | "fix" | "test";
	/** Salient terms/symbol names the intent is about (optional; derived from summary otherwise). */
	keywords?: string[];
	/** Files/areas the intent targets (optional). */
	targets?: string[];
	[key: string]: unknown;
}

/**
 * An existing capability the codebase already provides. Supplied by the
 * injectable catalog port; sourced from a symbol index (reuse, not reparse).
 */
export interface ExistingCapability {
	id: string;
	/** Symbol / function / module name. */
	label: string;
	kind?: string;
	/** Source file the capability lives in (for the pointer / audit). */
	file?: string;
	/** Searchable terms describing the capability. */
	keywords?: string[];
	/** One-line description, when known. */
	summary?: string;
	/** Where to find it (audit / reuse handle). */
	pointer?: string;
}

/**
 * The one seam this gate needs from the outside world: given an intent, hand
 * back the existing capabilities that might already satisfy it (or an empty
 * list). MUST be pure; it may throw — callers go through
 * {@link assessMinimality}, which fails open. Returning [] (the default) means
 * "no catalog data" → always "new".
 */
export interface CapabilityCatalogPort {
	lookup(intent: SolutionIntent): ExistingCapability[];
}

/** A scored candidate match between an intent and an existing capability. */
export interface CapabilityMatch {
	capability: ExistingCapability;
	/** Coverage of the intent's terms by the capability, in [0, 1]. */
	score: number;
	/** The intent terms the capability covered (sorted, for audit). */
	overlap: string[];
}

/** The result of assessing one intent against the capability catalog. */
export interface MinimalityAssessment {
	gate: string;
	gateVersion: string;
	assessedAt: string;
	intentId: string;
	/** Recommended rung on the reuse → extend → new ladder. */
	rung: MinimalityRung;
	/** Confidence in the recommendation, in [0, 1]. */
	confidence: number;
	/** True when the work would rebuild something that already exists. */
	redundant: boolean;
	/** The strongest candidate match, when any candidates were found. */
	bestMatch?: CapabilityMatch;
	/** All candidate matches, ranked strongest-first (capped by maxMatches). */
	matches: CapabilityMatch[];
	/** Human-readable rationale. */
	rationale: string;
	/** Optional token cost of the intent summary (telemetry). */
	intentTokens?: number;
	/** True when the catalog errored and the gate defaulted to "new". */
	failedOpen: boolean;
}

/** Aggregate over a set of assessments. */
export interface MinimalitySummary {
	total: number;
	reuse: number;
	extend: number;
	new: number;
	redundant: number;
}

/** The result of assessing a batch of intents. */
export interface MinimalitySetReport {
	gate: string;
	gateVersion: string;
	assessedAt: string;
	assessments: MinimalityAssessment[];
	summary: MinimalitySummary;
	failedOpen: boolean;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export const MINIMALITY_GATE_NAME = "acf-solution-minimality-gate";
export const MINIMALITY_GATE_VERSION = "ch7-1";

/** Default catalog: knows nothing, so every intent resolves to "new". */
export const emptyCapabilityCatalog: CapabilityCatalogPort = {
	lookup: () => [],
};

/** Generic verbs / articles that carry no domain signal for matching. */
const STOPWORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"the",
	"to",
	"of",
	"and",
	"or",
	"for",
	"in",
	"on",
	"with",
	"that",
	"this",
	"from",
	"into",
	"as",
	"at",
	"by",
	"be",
	"is",
	"it",
	"we",
	"our",
	"add",
	"adds",
	"create",
	"creates",
	"build",
	"builds",
	"make",
	"makes",
	"new",
	"implement",
	"implements",
	"support",
	"supports",
	"use",
	"uses",
	"using",
	"want",
	"need",
	"should",
	"would",
	"please",
	"code",
]);

export interface MinimalityOptions {
	/** Existing-capability source. Default: {@link emptyCapabilityCatalog}. */
	catalog?: CapabilityCatalogPort;
	/** Min score to recommend REUSE. Default 0.6. */
	reuseThreshold?: number;
	/** Min score to recommend EXTEND. Default 0.3. */
	extendThreshold?: number;
	/** Cap on ranked matches retained. Default 5. */
	maxMatches?: number;
	/** Token counter for the optional intent-token telemetry. */
	counter?: TokenCounter;
	/** Injectable clock for deterministic timestamps. */
	now?: () => Date;
	/** Custom scorer (intent, capability) → { score, overlap }. */
	score?: (intent: SolutionIntent, capability: ExistingCapability) => { score: number; overlap: string[] };
}

/** Split camelCase/underscores, lowercase, drop stopwords + short tokens. */
export function tokenize(text: string): string[] {
	if (!text) return [];
	const spaced = text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
		.replace(/[^A-Za-z0-9]+/g, " ");
	const out: string[] = [];
	for (const raw of spaced.split(/\s+/)) {
		const t = raw.toLowerCase();
		if (t.length < 2) continue;
		if (STOPWORDS.has(t)) continue;
		out.push(t);
	}
	return out;
}

function intentTerms(intent: SolutionIntent): Set<string> {
	const terms = new Set<string>();
	for (const t of tokenize(intent.summary)) terms.add(t);
	for (const kw of intent.keywords ?? []) for (const t of tokenize(kw)) terms.add(t);
	for (const tg of intent.targets ?? []) for (const t of tokenize(tg)) terms.add(t);
	return terms;
}

function capabilityTerms(capability: ExistingCapability): Set<string> {
	const terms = new Set<string>();
	for (const t of tokenize(capability.label)) terms.add(t);
	for (const kw of capability.keywords ?? []) for (const t of tokenize(kw)) terms.add(t);
	if (capability.summary) for (const t of tokenize(capability.summary)) terms.add(t);
	if (capability.file) for (const t of tokenize(capability.file)) terms.add(t);
	return terms;
}

/** Default scorer: fraction of the intent's terms the capability covers. */
function defaultScore(intent: SolutionIntent, capability: ExistingCapability): { score: number; overlap: string[] } {
	const wanted = intentTerms(intent);
	if (wanted.size === 0) return { score: 0, overlap: [] };
	const have = capabilityTerms(capability);
	const overlap: string[] = [];
	for (const t of wanted) if (have.has(t)) overlap.push(t);
	return { score: overlap.length / wanted.size, overlap: overlap.sort() };
}

const CREATION_KINDS: ReadonlySet<string> = new Set(["function", "module", "endpoint", "feature", "capability"]);

function decideRung(bestScore: number, reuseThreshold: number, extendThreshold: number): MinimalityRung {
	if (bestScore >= reuseThreshold) return "reuse";
	if (bestScore >= extendThreshold) return "extend";
	return "new";
}

/**
 * Assess one intent against the capability catalog. Pure, deterministic,
 * non-mutating, fail-open.
 */
export function assessMinimality(intent: SolutionIntent, options: MinimalityOptions = {}): MinimalityAssessment {
	const now = options.now ?? (() => new Date());
	const counter = options.counter ?? heuristicTokenCounter;
	const assessedAt = now().toISOString();
	const reuseThreshold = options.reuseThreshold ?? 0.6;
	const extendThreshold = options.extendThreshold ?? 0.3;
	const maxMatches = options.maxMatches ?? 5;
	const scorer = options.score ?? defaultScore;
	const intentTokens = countTokens(intent.summary ?? "", counter).tokens;

	const base = {
		gate: MINIMALITY_GATE_NAME,
		gateVersion: MINIMALITY_GATE_VERSION,
		assessedAt,
		intentId: intent.id,
		intentTokens,
	};

	try {
		const catalog = options.catalog ?? emptyCapabilityCatalog;
		const candidates = catalog.lookup(intent) ?? [];

		const matches: CapabilityMatch[] = candidates
			.map(capability => {
				const { score, overlap } = scorer(intent, capability);
				return { capability, score, overlap };
			})
			.filter(m => m.score > 0)
			.sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
			.slice(0, Math.max(0, maxMatches));

		const bestMatch = matches[0];
		// No usable candidates → cannot assess reuse; proceed as "new" (unknown).
		if (bestMatch === undefined) {
			return {
				...base,
				rung: "new",
				confidence: candidates.length === 0 ? 0.5 : 0.6,
				redundant: false,
				matches: [],
				rationale:
					candidates.length === 0
						? "No capability-catalog data available; cannot assess reuse — proceeding as new."
						: "No existing capability overlaps this intent; building new is justified.",
				failedOpen: false,
			};
		}

		const rung = decideRung(bestMatch.score, reuseThreshold, extendThreshold);
		const isCreation = intent.kind === undefined || CREATION_KINDS.has(intent.kind);
		const redundant = rung === "reuse" && isCreation;

		let confidence: number;
		let rationale: string;
		if (rung === "reuse") {
			confidence = bestMatch.score;
			const where = bestMatch.capability.pointer ? ` @ ${bestMatch.capability.pointer}` : "";
			const what = `${bestMatch.capability.label}${where}`;
			rationale = `Equivalent capability already exists (${what}); reuse it instead of rebuilding.`;
		} else if (rung === "extend") {
			confidence = bestMatch.score;
			rationale = `A related capability exists (${bestMatch.capability.label}); prefer extending it over building new.`;
		} else {
			confidence = 1 - bestMatch.score;
			rationale = "No sufficiently similar existing capability found; building new is justified.";
		}

		return { ...base, rung, confidence, redundant, bestMatch, matches, rationale, failedOpen: false };
	} catch {
		// Fail open: never falsely assert reuse — default to "new".
		return {
			...base,
			rung: "new",
			confidence: 0,
			redundant: false,
			matches: [],
			rationale: "Capability catalog unavailable; defaulting to build (fail-open) — minimality not asserted.",
			failedOpen: true,
		};
	}
}

/** Assess a batch of intents; returns per-intent assessments plus a summary. */
export function assessSolutionSet(intents: SolutionIntent[], options: MinimalityOptions = {}): MinimalitySetReport {
	const now = options.now ?? (() => new Date());
	const assessedAt = now().toISOString();

	try {
		const assessments = intents.map(intent => assessMinimality(intent, options));
		const summary: MinimalitySummary = {
			total: assessments.length,
			reuse: assessments.filter(a => a.rung === "reuse").length,
			extend: assessments.filter(a => a.rung === "extend").length,
			new: assessments.filter(a => a.rung === "new").length,
			redundant: assessments.filter(a => a.redundant).length,
		};
		return {
			gate: MINIMALITY_GATE_NAME,
			gateVersion: MINIMALITY_GATE_VERSION,
			assessedAt,
			assessments,
			summary,
			failedOpen: assessments.some(a => a.failedOpen),
		};
	} catch {
		return {
			gate: MINIMALITY_GATE_NAME,
			gateVersion: MINIMALITY_GATE_VERSION,
			assessedAt,
			assessments: [],
			summary: { total: 0, reuse: 0, extend: 0, new: 0, redundant: 0 },
			failedOpen: true,
		};
	}
}

/** Build a drop-in gate hook (intent → assessment) with options pre-bound. */
export function makeMinimalityGate(options: MinimalityOptions = {}): (intent: SolutionIntent) => MinimalityAssessment {
	return intent => assessMinimality(intent, options);
}

/**
 * Build a {@link CapabilityCatalogPort} from a static list of capabilities. The
 * simplest real catalog: a curated list of what the codebase already provides.
 * Scores every capability against the intent and returns those with any overlap.
 */
export function catalogFromCapabilities(
	capabilities: ExistingCapability[],
	scorer: (
		intent: SolutionIntent,
		capability: ExistingCapability,
	) => { score: number; overlap: string[] } = defaultScore,
): CapabilityCatalogPort {
	return {
		lookup(intent: SolutionIntent): ExistingCapability[] {
			return capabilities.filter(c => scorer(intent, c).score > 0);
		},
	};
}

/** A node as it appears in a capability graph export (tolerant/partial). */
export interface CapabilityGraphNode {
	id?: string;
	label?: string;
	kind?: string;
	source_file?: string;
	file?: string;
	summary?: string;
	keywords?: string[];
}

/**
 * Build a {@link CapabilityCatalogPort} from capability-graph nodes (reuse, not
 * reparse). Each node with a label becomes an existing capability; the pointer
 * uses a `graphify://<file>#<id>` scheme so a reuse recommendation is directly
 * resolvable.
 */
export function catalogFromGraphNodes(nodes: CapabilityGraphNode[]): CapabilityCatalogPort {
	const capabilities: ExistingCapability[] = [];
	for (const node of nodes) {
		const label = node.label;
		if (!label) continue;
		const file = node.source_file ?? node.file;
		const id = node.id ?? label;
		capabilities.push({
			id,
			label,
			kind: node.kind,
			file,
			keywords: node.keywords,
			summary: node.summary,
			pointer: file ? `graphify://${file}#${id}` : `graphify://symbol/${id}`,
		});
	}
	return catalogFromCapabilities(capabilities);
}
