/**
 * Adaptive Context Fidelity — dynamic response density (ACF CH8).
 *
 * The density policy answers one question before the agent WRITES its reply:
 * "how much detail does this task actually warrant?" — and expresses the answer
 * as a density LEVEL plus a grammar-safe directive (plan §7 CH8 exit criterion
 * "one response-density classification — no broken grammar"; concept adapted
 * from Caveman's dynamic response density, §10).
 *
 * It is NOT a summarizer and NOT a rewriter: it never touches the model's text.
 * It reads a {@link ResponseRequest} (what the agent is about to answer) and
 * returns a {@link ResponseDensityAssessment} recommending a level on the
 * minimal → compact → standard → detailed ladder, together with a
 * {@link DensityDirective} the responder can follow.
 *
 * Safety posture (plan §2/§4):
 *   - The one inviolable rule: density controls DETAIL, never grammar. Every
 *     directive is `preserveGrammar: true`; even "minimal" means short but
 *     complete, grammatical sentences — never telegraphic "caveman-speak".
 *   - Safety floor: safety-critical replies are floored to full detail and
 *     marked `verbatimRequired` — density can only ever RAISE detail for them.
 *   - Coverage floor: required points raise detail (never ship a gap to save
 *     tokens), mirroring CH6's need-preservation stance.
 *   - Disabled by default (rule #11): the default mode is "observe", which holds
 *     the effective level at the neutral "standard" (no reduction / asserts
 *     nothing). Only "active" mode applies the proposed level.
 *   - Fail-open (rule #4): any error resolves to the neutral "standard" level
 *     with `failedOpen: true` — it never reduces detail on failure.
 *   - Deterministic (injectable clock + scorer), additive, non-mutating; not
 *     wired into any hot path.
 */

import { countTokens, heuristicTokenCounter, type TokenCounter } from "./token-accounting/token-accounting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Response-density ladder, least-detail first. */
export type ResponseDensityLevel = "minimal" | "compact" | "standard" | "detailed";

/** Ladder order, least-detail first. Index doubles as an ordinal for clamping. */
export const DENSITY_LADDER: readonly ResponseDensityLevel[] = ["minimal", "compact", "standard", "detailed"];

/** Effective mode. observe = measure only (default, no reduction); active = apply. */
export type ResponseDensityMode = "observe" | "active";

/** Caller-declared audience; nudges detail up (novice) or down (expert). */
export type ResponseAudience = "novice" | "intermediate" | "expert";

/** A reply the agent is about to produce, described enough to size its density. */
export interface ResponseRequest {
	id: string;
	/** The task / question being answered (used to infer complexity). */
	summary: string;
	/** Structural kind of the reply (advisory; does not by itself set the level). */
	kind?: "answer" | "status" | "explanation" | "code-change" | "review" | "report" | "question";
	/** Optional caller complexity hint in [0, 1]; overrides inference when present. */
	complexity?: number;
	/** True when the reply must carry safety-critical content (floored to full detail, verbatim). */
	safetyCritical?: boolean;
	/** Audience expertise; novice → more detail, expert → less. */
	audience?: ResponseAudience;
	/** Explicit caller preference; honored but never below the safety floor. */
	preference?: ResponseDensityLevel;
	/** Points the reply MUST cover (coverage floor; more points → more detail). */
	requiredPoints?: string[];
	[key: string]: unknown;
}

/**
 * The one seam CH8 needs from the outside world: score a request's complexity in
 * [0, 1]. Pure; it may throw — callers go through {@link classifyResponseDensity},
 * which fails open. When absent, a deterministic built-in scorer is used.
 */
export interface ComplexityScorer {
	score(request: ResponseRequest): number;
}

/**
 * A grammar-safe instruction set for the responder. `preserveGrammar` is ALWAYS
 * true — this type cannot express a grammar-breaking directive.
 */
export interface DensityDirective {
	level: ResponseDensityLevel;
	/** Invariant: always true. Density adjusts detail, never grammar. */
	preserveGrammar: true;
	/** May the reply omit optional/background detail? Only at minimal/compact. */
	allowOmitOptional: boolean;
	/** Must safety-critical content be reproduced verbatim? */
	verbatimRequired: boolean;
	/** Soft target token budget for the reply (a hint, not a hard cap — rule #16). */
	targetTokensHint: number;
	/** Human/agent-readable style guidance; every entry is grammar-preserving. */
	directives: string[];
}

/** The raw signals that produced a level, retained for audit / calibration. */
export interface ResponseDensitySignals {
	/** Complexity score actually used, in [0, 1]. */
	complexity: number;
	/** Whether the built-in scorer or a caller hint/port produced it. */
	complexitySource: "hint" | "port" | "inferred";
	safetyCritical: boolean;
	audience?: ResponseAudience;
	/** True when an explicit caller preference set the level. */
	preferenceApplied: boolean;
	/** True when the safety floor raised the level above what signals suggested. */
	safetyFloorApplied: boolean;
	requiredPointCount: number;
}

/** The result of classifying one response request. */
export interface ResponseDensityAssessment {
	policy: string;
	policyVersion: string;
	assessedAt: string;
	requestId: string;
	mode: ResponseDensityMode;
	/** Effective level. In observe mode this is always the neutral "standard". */
	level: ResponseDensityLevel;
	/** What active mode WOULD apply (the measured recommendation). */
	proposedLevel: ResponseDensityLevel;
	/** Grammar-safe directive for the effective level. */
	directive: DensityDirective;
	/** Confidence in the recommendation, in [0, 1]. */
	confidence: number;
	/** Human-readable rationale. */
	rationale: string;
	/** Signals that produced the recommendation. */
	signals: ResponseDensitySignals;
	/** Optional token cost of the request summary (CH0 telemetry). */
	promptTokens?: number;
	/** True when classification errored and the policy defaulted to "standard". */
	failedOpen: boolean;
}

/** Aggregate over a set of assessments. */
export interface ResponseDensitySummary {
	total: number;
	minimal: number;
	compact: number;
	standard: number;
	detailed: number;
	/** Assessments whose proposed level would reduce detail below "standard". */
	reduced: number;
}

/** The result of classifying a batch of requests. */
export interface ResponseDensitySetReport {
	policy: string;
	policyVersion: string;
	assessedAt: string;
	assessments: ResponseDensityAssessment[];
	summary: ResponseDensitySummary;
	failedOpen: boolean;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const RESPONSE_DENSITY_POLICY_NAME = "acf-response-density-policy";
export const RESPONSE_DENSITY_POLICY_VERSION = "ch8-1";

/** The neutral level: "no reduction". Observe mode always resolves here (unless safety raises it). */
export const NEUTRAL_LEVEL: ResponseDensityLevel = "standard";

/** The single inviolable CH8 rule, retained verbatim for audit / documentation. */
export const GRAMMAR_RULE =
	"Response density adjusts the amount of DETAIL, never grammar. Every level — including 'minimal' — must be composed of short but complete, grammatical sentences. Telegraphic, word-dropped 'caveman-speak' is never permitted.";

/** Soft per-level token budgets (hints, not hard caps — rule #16). */
const DEFAULT_TARGET_TOKENS: Readonly<Record<ResponseDensityLevel, number>> = {
	minimal: 120,
	compact: 320,
	standard: 720,
	detailed: 1600,
};

const LEVEL_GUIDANCE: Readonly<Record<ResponseDensityLevel, readonly string[]>> = {
	minimal: [
		"Answer directly in one or two complete, grammatical sentences.",
		"State the result first; omit background and optional detail.",
		"Do not drop words or use fragments — brevity comes from scope, not broken grammar.",
	],
	compact: [
		"Lead with the answer, then add only the detail needed to act on it.",
		"Prefer a short paragraph or a tight list; skip tangential context.",
		"Keep every sentence complete and grammatical.",
	],
	standard: [
		"Give the answer with the reasoning and context a competent reader needs.",
		"Include relevant caveats; omit exhaustive enumeration.",
		"Balanced detail — the neutral default.",
	],
	detailed: [
		"Cover the answer, the reasoning, edge cases, and alternatives.",
		"Enumerate required points explicitly and preserve safety-critical content verbatim.",
		"Favor completeness over brevity; never sacrifice a needed point to save tokens.",
	],
};

export interface ResponseDensityOptions {
	/** observe = measure only (default, holds effective level at neutral); active = apply proposed level. */
	mode?: ResponseDensityMode;
	/** Injectable complexity scorer in [0,1]. May throw; the policy fails open. */
	scorer?: ComplexityScorer;
	/** Token counter for the summary-token telemetry (CH0). */
	counter?: TokenCounter;
	/** Injectable clock for deterministic timestamps. */
	now?: () => Date;
	/** Complexity below which a reply is "minimal". Default 0.25. */
	minimalBelow?: number;
	/** Complexity below which a reply is "compact". Default 0.5. */
	compactBelow?: number;
	/** Complexity below which a reply is "standard"; at/above → "detailed". Default 0.75. */
	standardBelow?: number;
	/** Per-level soft token-budget overrides. */
	targetTokens?: Partial<Record<ResponseDensityLevel, number>>;
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

function ordinal(level: ResponseDensityLevel): number {
	return DENSITY_LADDER.indexOf(level);
}

function fromOrdinal(index: number): ResponseDensityLevel {
	const clamped = Math.max(0, Math.min(DENSITY_LADDER.length - 1, index));
	return DENSITY_LADDER[clamped];
}

/** Raise `level` to at least `floor` (never lowers). */
function raiseTo(level: ResponseDensityLevel, floor: ResponseDensityLevel): ResponseDensityLevel {
	return ordinal(floor) > ordinal(level) ? floor : level;
}

const KIND_WEIGHT: Readonly<Record<NonNullable<ResponseRequest["kind"]>, number>> = {
	status: 0,
	answer: 0.05,
	question: 0.05,
	explanation: 0.2,
	review: 0.25,
	report: 0.3,
	"code-change": 0.35,
};

/**
 * Deterministic built-in complexity heuristic in [0,1]: reply length signal +
 * kind weight + required-point weight. Used when no caller hint / scorer is given.
 */
function inferComplexity(request: ResponseRequest, counter: TokenCounter): number {
	const summaryTokens = countTokens(request.summary ?? "", counter).tokens;
	const lengthSignal = clamp01(summaryTokens / 80) * 0.5; // up to 0.5 from length
	const kindSignal = request.kind ? KIND_WEIGHT[request.kind] : 0.1;
	const pointSignal = Math.min((request.requiredPoints?.length ?? 0) * 0.08, 0.3);
	return clamp01(lengthSignal + kindSignal + pointSignal);
}

function levelFromComplexity(complexity: number, options: ResponseDensityOptions): ResponseDensityLevel {
	const minimalBelow = options.minimalBelow ?? 0.25;
	const compactBelow = options.compactBelow ?? 0.5;
	const standardBelow = options.standardBelow ?? 0.75;
	if (complexity < minimalBelow) return "minimal";
	if (complexity < compactBelow) return "compact";
	if (complexity < standardBelow) return "standard";
	return "detailed";
}

/** Coverage floor: more required points → at least this much detail (raise-only). */
function coverageFloor(pointCount: number): ResponseDensityLevel {
	if (pointCount >= 5) return "detailed";
	if (pointCount >= 2) return "standard";
	if (pointCount >= 1) return "compact";
	return "minimal";
}

/**
 * Build the grammar-safe directive for a level. `preserveGrammar` is always true
 * by construction — the type cannot express a grammar-breaking directive.
 */
export function directiveFor(
	level: ResponseDensityLevel,
	opts: { safetyCritical?: boolean; targetTokens?: Partial<Record<ResponseDensityLevel, number>> } = {},
): DensityDirective {
	const targetTokensHint = opts.targetTokens?.[level] ?? DEFAULT_TARGET_TOKENS[level];
	const directives = [...LEVEL_GUIDANCE[level]];
	if (opts.safetyCritical) {
		directives.push("Reproduce safety-critical content verbatim; do not paraphrase or abbreviate it.");
	}
	return {
		level,
		preserveGrammar: true,
		allowOmitOptional: level === "minimal" || level === "compact",
		verbatimRequired: opts.safetyCritical === true,
		targetTokensHint,
		directives,
	};
}

/** Human-readable one-line description of a density level. */
export function describeDensity(level: ResponseDensityLevel): string {
	switch (level) {
		case "minimal":
			return "Minimal: the answer in one or two complete sentences; optional detail omitted.";
		case "compact":
			return "Compact: the answer plus just enough detail to act on it.";
		case "standard":
			return "Standard: balanced answer, reasoning, and context — the neutral default.";
		case "detailed":
			return "Detailed: full answer with reasoning, edge cases, and required points enumerated.";
	}
}

/** A directive is grammar-preserving iff it asserts `preserveGrammar: true`. Always true by construction. */
export function isGrammarPreserving(directive: DensityDirective): boolean {
	return directive.preserveGrammar === true;
}

function neutralAssessment(
	request: ResponseRequest,
	mode: ResponseDensityMode,
	assessedAt: string,
	options: ResponseDensityOptions,
	failedOpen: boolean,
): ResponseDensityAssessment {
	const safetyCritical = request?.safetyCritical === true;
	const level: ResponseDensityLevel = safetyCritical ? "detailed" : NEUTRAL_LEVEL;
	return {
		policy: RESPONSE_DENSITY_POLICY_NAME,
		policyVersion: RESPONSE_DENSITY_POLICY_VERSION,
		assessedAt,
		requestId: request?.id ?? "unknown",
		mode,
		level,
		proposedLevel: level,
		directive: directiveFor(level, { safetyCritical, targetTokens: options.targetTokens }),
		confidence: 0,
		rationale: failedOpen
			? "Density classification failed; defaulting to the neutral 'standard' level (fail-open) — no reduction asserted."
			: "Neutral 'standard' level — no reduction asserted.",
		signals: {
			complexity: 0,
			complexitySource: "inferred",
			safetyCritical,
			audience: request?.audience,
			preferenceApplied: false,
			safetyFloorApplied: safetyCritical,
			requiredPointCount: request?.requiredPoints?.length ?? 0,
		},
		promptTokens: undefined,
		failedOpen,
	};
}

/**
 * Classify one response request. Pure, deterministic, non-mutating, fail-open.
 * In observe mode (default) the effective `level` is held at the neutral
 * "standard" (or "detailed" when safety-critical) while `proposedLevel` carries
 * the measured recommendation active mode WOULD apply.
 */
export function classifyResponseDensity(
	request: ResponseRequest,
	options: ResponseDensityOptions = {},
): ResponseDensityAssessment {
	const now = options.now ?? (() => new Date());
	const assessedAt = now().toISOString();
	const mode: ResponseDensityMode = options.mode ?? "observe";

	try {
		const counter = options.counter ?? heuristicTokenCounter;
		const safetyCritical = request.safetyCritical === true;
		const requiredPointCount = request.requiredPoints?.length ?? 0;
		const promptTokens = countTokens(request.summary ?? "", counter).tokens;

		// 1. Complexity in [0,1]: caller hint > injectable scorer > built-in heuristic.
		let complexity: number;
		let complexitySource: ResponseDensitySignals["complexitySource"];
		if (typeof request.complexity === "number") {
			complexity = clamp01(request.complexity);
			complexitySource = "hint";
		} else if (options.scorer) {
			complexity = clamp01(options.scorer.score(request));
			complexitySource = "port";
		} else {
			complexity = inferComplexity(request, counter);
			complexitySource = "inferred";
		}

		// 2. Base level from complexity.
		let level = levelFromComplexity(complexity, options);

		// 3. Audience nudge: novice → +1 detail, expert → −1 (intermediate unchanged).
		if (request.audience === "novice") level = fromOrdinal(ordinal(level) + 1);
		else if (request.audience === "expert") level = fromOrdinal(ordinal(level) - 1);

		// 4. Explicit caller preference sets the level (safety/coverage floors may still raise it).
		const preferenceApplied = request.preference !== undefined;
		if (request.preference !== undefined) level = request.preference;

		// 5. Coverage floor from required points (raise-only — never ship a gap to save tokens).
		const preFloorLevel = level;
		level = raiseTo(level, coverageFloor(requiredPointCount));

		// 6. Safety floor: safety-critical → full detail (raise-only).
		let safetyFloorApplied = false;
		if (safetyCritical) {
			const raised = raiseTo(level, "detailed");
			safetyFloorApplied = ordinal(raised) > ordinal(preFloorLevel);
			level = raised;
		}

		const proposedLevel = level;

		// 7. Effective level: active applies the proposal; observe holds neutral (never reduces),
		//    but a safety-critical reply is still floored to detailed even in observe.
		const effectiveLevel: ResponseDensityLevel =
			mode === "active" ? proposedLevel : safetyCritical ? "detailed" : NEUTRAL_LEVEL;

		// Confidence: explicit signals are trusted more than the heuristic; safety is decisive.
		let confidence: number;
		if (safetyCritical) confidence = 0.95;
		else if (complexitySource === "hint" || preferenceApplied) confidence = 0.9;
		else if (complexitySource === "port") confidence = 0.8;
		else confidence = 0.6;

		const reduces = ordinal(proposedLevel) < ordinal(NEUTRAL_LEVEL);
		const rationaleParts = [
			`Recommended '${proposedLevel}' (complexity ${complexity.toFixed(2)} via ${complexitySource}`,
			safetyFloorApplied ? ", safety floor applied" : "",
			preferenceApplied ? ", caller preference applied" : "",
			requiredPointCount > 0 ? `, ${requiredPointCount} required point(s)` : "",
			`). ${reduces ? "Active mode would reduce detail below standard." : "No reduction below standard."}`,
			mode === "active" ? "" : " Observe mode: effective level held neutral.",
		];

		return {
			policy: RESPONSE_DENSITY_POLICY_NAME,
			policyVersion: RESPONSE_DENSITY_POLICY_VERSION,
			assessedAt,
			requestId: request.id,
			mode,
			level: effectiveLevel,
			proposedLevel,
			directive: directiveFor(effectiveLevel, { safetyCritical, targetTokens: options.targetTokens }),
			confidence,
			rationale: rationaleParts.join(""),
			signals: {
				complexity,
				complexitySource,
				safetyCritical,
				audience: request.audience,
				preferenceApplied,
				safetyFloorApplied,
				requiredPointCount,
			},
			promptTokens,
			failedOpen: false,
		};
	} catch {
		return neutralAssessment(request, mode, assessedAt, options, true);
	}
}

/** Classify a batch of requests; returns per-request assessments plus a summary. */
export function classifyResponseSet(
	requests: ResponseRequest[],
	options: ResponseDensityOptions = {},
): ResponseDensitySetReport {
	const now = options.now ?? (() => new Date());
	const assessedAt = now().toISOString();

	try {
		const assessments = requests.map(r => classifyResponseDensity(r, options));
		const summary: ResponseDensitySummary = {
			total: assessments.length,
			minimal: assessments.filter(a => a.proposedLevel === "minimal").length,
			compact: assessments.filter(a => a.proposedLevel === "compact").length,
			standard: assessments.filter(a => a.proposedLevel === "standard").length,
			detailed: assessments.filter(a => a.proposedLevel === "detailed").length,
			reduced: assessments.filter(a => ordinal(a.proposedLevel) < ordinal(NEUTRAL_LEVEL)).length,
		};
		return {
			policy: RESPONSE_DENSITY_POLICY_NAME,
			policyVersion: RESPONSE_DENSITY_POLICY_VERSION,
			assessedAt,
			assessments,
			summary,
			failedOpen: assessments.some(a => a.failedOpen),
		};
	} catch {
		return {
			policy: RESPONSE_DENSITY_POLICY_NAME,
			policyVersion: RESPONSE_DENSITY_POLICY_VERSION,
			assessedAt,
			assessments: [],
			summary: { total: 0, minimal: 0, compact: 0, standard: 0, detailed: 0, reduced: 0 },
			failedOpen: true,
		};
	}
}

/** Build a drop-in policy hook (request → assessment) with options pre-bound. */
export function makeDensityPolicy(
	options: ResponseDensityOptions = {},
): (request: ResponseRequest) => ResponseDensityAssessment {
	return request => classifyResponseDensity(request, options);
}
