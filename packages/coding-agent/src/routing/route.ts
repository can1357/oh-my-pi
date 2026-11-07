// src/routing/route.ts
//
// Single-phase triage router: routes turn to capability tier via System One judgments.
//
// ---------------------------------------------------------------------------
// The one idea in this file: router errors are ASYMMETRIC.
// ---------------------------------------------------------------------------
//   under-route (hard task -> cheap model): bad output, user retries, trust lost
//   over-route (easy task -> frontier model): money only, output still correct
//
// So the default is the MOST CAPABLE tier, and we route DOWN only when the
// judge is confident. The intuitive implementation — start cheap, escalate
// when unsure — is backwards: it collects the quality penalty on every
// mistake and the savings only on successes.
//
// Corollary: fail-open here means fail EXPENSIVE. If the judge is unreachable,
// slow, or unconfigured, route to the top tier. A missing router must never be
// able to degrade output.
//
// The judge for routing is TypeSafe-only (`resolveRoutingJudge`): the
// `resolveJudge` chain would answer routing questions via an LLM fallback on
// Jev outage — extra tokens and latency on the turn critical path for a
// decision that should not exist. Jev down -> no routing decision -> top tier.

import type { ChoiceAnswer, Judge, Questions, ScoreAnswer } from "@oh-my-pi/pi-ai";
import { DEFAULT_ROUTING_POLICY, type RouteDecision, type RoutingPolicy, type TierSpec } from "./types";

interface RoutingAnswers {
	tier?: ChoiceAnswer;
	complexity?: ScoreAnswer;
}

/** Complexity levels for the score question. The decision API answers with a weighted level index over these — raw 0..n-1 (routing-spec v1.1: measured 0..2 on the wire). */
const COMPLEXITY_CRITERIA = [
	"Mechanical: single location, known pattern, no design decision",
	"Moderate: several locations, or requires some judgment",
	"Hard: architectural, ambiguous, or getting it wrong is expensive",
] as const;

/** Policy thresholds and the decision's `complexity` metadata speak 0..1; normalize the raw level index before either. */
const normalizeComplexity = (raw: number): number => raw / (COMPLEXITY_CRITERIA.length - 1);

export function buildRoutingQuestions(tiers: TierSpec[]): Questions {
	const criteria: Record<string, string> = {};
	for (const t of tiers) criteria[t.id] = t.capability;

	// Deliberately TWO axes, per TypeSafe's Intent Routing pattern. The choice
	// says "who"; the score independently says "how hard". Requiring both to
	// agree before degrading is what keeps the judge's error rate from turning
	// into a quality regression.
	return {
		tier: {
			type: "choice",
			instructions: "Which capability tier is sufficient to handle this request well?",
			criteria,
		},
		complexity: {
			type: "score",
			instructions: "How demanding is this request to carry out correctly?",
			criteria: COMPLEXITY_CRITERIA,
		},
	};
}

/** Hard cap on a routing judgment call (spec §1). Internal timeout aborts map to `engine-unavailable`, never to a swallowed user abort. */
export const ROUTING_JUDGE_TIMEOUT_MS = 1500;

/**
 * True when `error` came from the CALLER's signal aborting — rethrow those so
 * user escape propagates. Internal timeout aborts and all other failures
 * return false -> `engine-unavailable` (fail expensive).
 */
function isCallerAbort(_error: unknown, callerSignal: AbortSignal | undefined): boolean {
	return callerSignal?.aborted === true;
}

function routingSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

export async function routeTurn(
	judge: Judge,
	state: string,
	tiers: TierSpec[],
	policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
	signal?: AbortSignal,
	timeoutMs: number = ROUTING_JUDGE_TIMEOUT_MS,
): Promise<RouteDecision> {
	const top = tiers[tiers.length - 1];

	let answers: RoutingAnswers;
	try {
		const result = await judge.judge(
			{ state, questions: buildRoutingQuestions(tiers) },
			{ signal: routingSignal(signal, timeoutMs) },
		);
		answers = result.answers;
	} catch (error) {
		// The Judge contract throws instead of returning null; semantically a
		// thrown judgment is "no opinion" -> fail expensive. A caller abort is
		// not a judgment failure — rethrow so user escape propagates.
		if (isCallerAbort(error, signal)) throw error;
		return { tier: top.id, reason: "engine-unavailable" };
	}

	return decide(answers, tiers, policy);
}

function decide(answers: RoutingAnswers, tiers: TierSpec[], policy: RoutingPolicy): RouteDecision {
	const top = tiers[tiers.length - 1];
	const choice = answers.tier;
	const complexity = answers.complexity;

	if (!choice?.choice) return { tier: top.id, reason: "engine-unavailable" };

	const confidence = choice.confidence ?? 0;
	// Unknown complexity defaults to HARD, not easy. Fail expensive. The wire
	// score is a raw weighted level index (0..n-1); gates and policy speak 0..1.
	// `== null` also catches an explicit JSON null, which would otherwise
	// normalize to 0 and read as trivially easy.
	const rawScore = complexity?.score;
	const score = rawScore == null ? 1 : normalizeComplexity(rawScore);
	const complexityConfidence = complexity?.confidence ?? 0;

	const meta = { intent: choice.choice, complexity: score, confidence };

	// Three independent gates. Any one failing sends the turn to the top tier.
	if (confidence < policy.minConfidenceToDegrade) {
		return { tier: top.id, reason: "low-confidence", ...meta };
	}
	if (score > policy.maxComplexityForDegrade) {
		return { tier: top.id, reason: "high-complexity", ...meta };
	}
	if (complexityConfidence < policy.minComplexityConfidence) {
		return { tier: top.id, reason: "low-confidence", ...meta };
	}

	// The judge can only name tiers we actually have; an unknown id degrades to top.
	const chosen = tiers.find(t => t.id === choice.choice) ?? top;
	return { tier: chosen.id, reason: "jev-confident", ...meta };
}
