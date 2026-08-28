/**
 * Capability Fidelity — risk/health filtering + tier mapping.
 *
 * Additive, disabled-by-default, OBSERVE-ONLY continuation of
 * `capability-bundle.ts`. Takes an execution-complete bundle and:
 *   1. Assigns each included capability a context **fidelity tier** (`L0`..`L4`,
 *      the repo's existing tier vocabulary), so a later hydration step can
 *      spend the token budget where it matters.
 *   2. Applies a **risk/health policy** that FLAGS (never silently drops)
 *      high-risk / unhealthy capabilities and emits advisory exclusions.
 *
 * Tier policy:
 *   - L0: safety-critical — rollback capabilities + any capability in a conflict.
 *   - L1: prerequisites (the `requires` closure — needed to actually run).
 *   - L2: seeds + validation companions.
 *   - L3: anything else in the bundle.
 *   - L4: reserved for cold/unreferenced (not produced here; kept for symmetry).
 *
 * Discipline: observe-only, disabled-by-default, fail-open, additive.
 */

import type { ExecutionCompleteBundle } from "./capability-bundle";

export type FidelityTier = "L0" | "L1" | "L2" | "L3" | "L4";

export type CapabilityRisk = "low" | "medium" | "high" | "unknown";
export type CapabilityHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

/** External risk/health signal for a capability (injected — read, never written). */
export interface CapabilityRiskSignal {
	risk?: CapabilityRisk;
	health?: CapabilityHealth;
}

export interface FidelityMapOptions {
	/** Disabled by default. When false, an inert (empty) plan is returned. */
	enabled?: boolean;
	/** Risk/health signals keyed by capability id. */
	risk?: Record<string, CapabilityRiskSignal>;
	/** Risk levels that trigger an advisory exclusion. Default: ["high"]. */
	excludeRisk?: CapabilityRisk[];
	/** Health levels that trigger an advisory exclusion. Default: ["unhealthy"]. */
	excludeHealth?: CapabilityHealth[];
}

export interface CapabilityTierAssignment {
	id: string;
	tier: FidelityTier;
	reason: string;
}

export interface RiskFlag {
	id: string;
	risk: CapabilityRisk;
	health: CapabilityHealth;
	/** Advisory only — nothing is removed from the bundle. */
	recommendExclude: boolean;
	reason: string;
}

export interface FidelityPlan {
	mode: "observe";
	enabled: boolean;
	assignments: CapabilityTierAssignment[];
	byTier: Record<FidelityTier, string[]>;
	riskFlags: RiskFlag[];
	/** Ids the risk policy recommends excluding — advisory, not applied. */
	recommendedExclusions: string[];
}

const ALL_TIERS: FidelityTier[] = ["L0", "L1", "L2", "L3", "L4"];

function emptyByTier(): Record<FidelityTier, string[]> {
	return { L0: [], L1: [], L2: [], L3: [], L4: [] };
}

function inertPlan(): FidelityPlan {
	return {
		mode: "observe",
		enabled: false,
		assignments: [],
		byTier: emptyByTier(),
		riskFlags: [],
		recommendedExclusions: [],
	};
}

/**
 * Map an execution-complete bundle to fidelity tiers and apply the risk/health
 * policy. Pure, observe-only, fail-open. Inert when disabled.
 */
export function mapBundleToFidelity(bundle: ExecutionCompleteBundle, options: FidelityMapOptions = {}): FidelityPlan {
	if (options.enabled !== true) return inertPlan();

	try {
		const seeds = new Set(bundle.seeds);
		const prerequisites = new Set(bundle.prerequisites);
		const validations = new Set(bundle.validations);
		const rollbacks = new Set(bundle.rollbacks);

		// Capabilities that appear in any conflict pair are safety-critical.
		const conflicted = new Set<string>();
		for (const c of bundle.conflicts) {
			conflicted.add(c.a);
			conflicted.add(c.b);
		}

		const assignTier = (id: string): { tier: FidelityTier; reason: string } => {
			if (rollbacks.has(id)) return { tier: "L0", reason: "safety-critical: rollback capability" };
			if (conflicted.has(id)) return { tier: "L0", reason: "safety-critical: participates in a conflict" };
			if (prerequisites.has(id)) return { tier: "L1", reason: "prerequisite (requires closure)" };
			if (seeds.has(id)) return { tier: "L2", reason: "seed capability" };
			if (validations.has(id)) return { tier: "L2", reason: "validation companion" };
			return { tier: "L3", reason: "supporting bundle member" };
		};

		const assignments: CapabilityTierAssignment[] = [];
		const byTier = emptyByTier();
		for (const id of bundle.included) {
			const { tier, reason } = assignTier(id);
			assignments.push({ id, tier, reason });
			byTier[tier].push(id);
		}

		// Risk/health policy — flag only, never drop.
		const excludeRisk = new Set<CapabilityRisk>(options.excludeRisk ?? ["high"]);
		const excludeHealth = new Set<CapabilityHealth>(options.excludeHealth ?? ["unhealthy"]);
		const signals = options.risk ?? {};

		const riskFlags: RiskFlag[] = [];
		const recommendedExclusions: string[] = [];
		for (const id of bundle.included) {
			const signal = signals[id] ?? {};
			const risk: CapabilityRisk = signal.risk ?? "unknown";
			const health: CapabilityHealth = signal.health ?? "unknown";
			if (risk === "unknown" && health === "unknown") continue; // nothing to say
			const riskHit = excludeRisk.has(risk);
			const healthHit = excludeHealth.has(health);
			const recommendExclude = riskHit || healthHit;
			const reasons: string[] = [];
			if (riskHit) reasons.push(`risk=${risk}`);
			if (healthHit) reasons.push(`health=${health}`);
			if (recommendExclude) recommendedExclusions.push(id);
			riskFlags.push({
				id,
				risk,
				health,
				recommendExclude,
				reason: recommendExclude ? `flagged: ${reasons.join(", ")}` : `noted: risk=${risk}, health=${health}`,
			});
		}

		return {
			mode: "observe",
			enabled: true,
			assignments,
			byTier,
			riskFlags,
			recommendedExclusions: [...new Set(recommendedExclusions)],
		};
	} catch {
		return inertPlan();
	}
}

/** Convenience: the tier vocabulary, exported for callers that want to iterate. */
export function fidelityTiers(): FidelityTier[] {
	return [...ALL_TIERS];
}
