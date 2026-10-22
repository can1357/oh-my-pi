// src/routing/types.ts
//
// Jev as a MODEL ROUTER — typed judgments dispatching each turn to a
// capability tier.
//
// The one idea: router errors are ASYMMETRIC.
//   under-route (hard task -> cheap model): bad output, user retries, trust lost
//   over-route (easy task -> frontier model): money only, output still correct
// So the default is the MOST CAPABLE tier, and we route DOWN only when the
// judge is confident. Fail-open here means fail EXPENSIVE.
//
// Contract: jev-routing-spec.md (shared with the opencode/bifrost/litellm
// ports). Where this file and the spec disagree, fix this file.

import type { Model } from "@oh-my-pi/pi-ai";

/** Tiers are ordered cheapest -> most capable. Order is load-bearing. */
export interface TierSpec {
	id: string;
	/**
	 * Free-text capability description handed to the judge as the `criteria`
	 * entry for this tier. THIS IS HOW THE ROUTER LEARNS YOUR POOL — there is
	 * no training step, so the pool's shape has to be described in the
	 * question. Write it as an eligibility test, not a model name.
	 */
	capability: string;
	/** Reporting only; the router never optimizes cost directly. */
	costHintUsdPerMTokOut?: number;
}

/** A tier bound to a concrete pool model. */
export interface ModelTier extends TierSpec {
	model: Model;
}

export type RouteReason =
	| "jev-confident" // routed down: judge confident AND complexity low
	| "low-confidence" // judge unsure -> stayed at top tier
	| "high-complexity" // judge says it's hard -> stayed at top tier
	| "engine-unavailable" // no router at all -> stayed at top tier
	| "verification-failed"; // post-hoc check rejected the cheap output

export interface RouteDecision {
	tier: string;
	reason: RouteReason;
	intent?: string;
	complexity?: number;
	confidence?: number;
	escalated?: boolean;
	/** How many times this turn has already been re-run on a stronger tier. */
	escalationCount?: number;
}

export interface RoutingPolicy {
	/**
	 * Confidence required before we route DOWN to a cheaper tier.
	 * 0.85 = TypeSafe's own high-stakes threshold (their `approve_transfer`
	 * example) for mixed-capability pools; flat pools may lower to 0.55–0.65.
	 * Routing down is the high-stakes action.
	 */
	minConfidenceToDegrade: number;
	/** Complexity score (normalized 0..1; the raw wire score is a weighted level index) at or below which degrading is allowed. */
	maxComplexityForDegrade: number;
	/** If we can't trust the complexity score, treat the task as hard. */
	minComplexityConfidence: number;
	allowVerify: boolean;
	/** Confidence required before we act on a "not adequate" verdict. */
	minConfidenceToEscalate: number;
	maxEscalationsPerTurn: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
	minConfidenceToDegrade: 0.85,
	maxComplexityForDegrade: 0.5,
	minComplexityConfidence: 0.5,
	allowVerify: true,
	minConfidenceToEscalate: 0.7,
	maxEscalationsPerTurn: 1,
};
