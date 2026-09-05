/**
 * Types and interfaces for high-performance dynamic multi-provider routing.
 */

import type { Model } from "@pk-nerdsaver-ai/pi-ai";

export type RoutingStrategy = "affinity-fallback" | "round-robin";

export interface ModelPoolConfig {
	/** Whether this specific pool is enabled. */
	enabled?: boolean;
	/** Display name or alias for the pool. */
	name?: string;
	/** Routing strategy for this pool (default: affinity-fallback). */
	strategy?: RoutingStrategy;
	/**
	 * Explicit members of this pool (e.g. `["anthropic/claude-3-7-sonnet", "openrouter/anthropic/claude-3.7-sonnet"]`).
	 * Users have full overwrite power to link any models together regardless of name.
	 */
	members: string[];
}

export interface DynamicRoutingConfig {
	/** Opt-in master switch. Off by default. */
	enabled?: boolean;
	/** Default routing strategy across pools. */
	strategy?: RoutingStrategy;
	/** Default backoff duration in milliseconds when a provider hits rate limit / quota (default: 60000ms). */
	cooldownDurationMs?: number;
	/**
	 * Configured model pools.
	 * Keyed by pool ID (or canonical model ID, or user alias).
	 */
	pools?: Record<string, ModelPoolConfig>;
	/**
	 * Pairs or selectors explicitly vetoed from being automatically grouped.
	 * e.g. `["provider-a/model-x", "provider-b/model-x"]`
	 */
	vetoes?: string[][];
}

export interface PoolHealthState {
	/** Unix timestamp (ms) until which this provider/model candidate is cooling down. */
	coolingUntil: number;
	/** Consecutive failure count for exponential backoff. */
	consecutiveFailures: number;
	/** Last error message encountered. */
	lastError?: string;
}

export interface ResolvedModelPool {
	id: string;
	name: string;
	strategy: RoutingStrategy;
	/** Models in the pool that are currently configured and authenticated. */
	candidates: Model[];
}

export interface PoolCandidateEvaluation {
	model: Model;
	isCooling: boolean;
	isContextSufficient: boolean;
	coolingRemainingMs: number;
}
