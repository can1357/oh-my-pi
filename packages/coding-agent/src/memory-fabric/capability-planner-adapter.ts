/**
 * Capability Planner Adapter — approval-gated composition.
 *
 * Composes the whole read-only capability pipeline —
 *   `CapabilityGraph` → `expandExecutionComplete`
 *   → `mapBundleToFidelity` → `rankBundle`
 * — into a single planner-facing entry point, `planCapabilityBundle`, and
 * routes every would-be capability execution through an **injected gate** that
 * reuses the existing trust / health / approval checks.
 *
 * This is the first rung with an `active` (opt-in) mode, so the discipline is
 * stricter, not looser:
 *   - It NEVER executes a capability. It returns *decisions*; the caller (the
 *     real planner) executes only what the gate approved, through its own paths.
 *   - The gate is INJECTED. This adapter makes no trust/health/approval
 *     judgement of its own — it delegates to the function the caller supplies,
 *     so the live approval policy stays the single source of truth.
 *   - Disabled-by-default. Without `enabled: true` it is `mode: "off"` and inert.
 *   - Without a gate it can only reach `mode: "observe"`: every capability is
 *     reported as `needs-approval`; nothing is ever auto-approved.
 *   - Conservative safety override: a capability the fidelity risk policy
 *     flagged for exclusion can NEVER end up in `approved`, even if the gate
 *     says allow — it is downgraded to `needs-approval`. Defence in depth.
 *   - Fail-open: any error yields the inert `off` plan; never throws.
 *
 * Deliberately NOT done here: the one-line edit that calls
 * `planCapabilityBundle` from inside the live planner. That is the only
 * genuine hot-path change and is left for human review — flip it on behind an
 * explicit off-by-default flag once this adapter has been reviewed.
 */

import { type ExecutionCompleteBundle, type ExpandOptions, expandExecutionComplete } from "./capability-bundle";
import {
	type FidelityMapOptions,
	type FidelityPlan,
	type FidelityTier,
	mapBundleToFidelity,
} from "./capability-fidelity";
import type { CapabilityGraph } from "./capability-graph";
import { type RankedBundle, type RankOptions, rankBundle } from "./capability-ranking";

export type GateDecision = "allow" | "deny" | "needs-approval";
export type ExecutionCondition = "always" | "on-success" | "on-failure";

/** Context handed to the injected gate for each capability. */
export interface GateContext {
	tier: FidelityTier | null;
	rank: number;
	score: number;
	riskFlagged: boolean;
	recommendedExclusion: boolean;
}

export interface GateVerdict {
	decision: GateDecision;
	reason?: string;
}

/**
 * Injected approval/health/trust gate. Called for every capability; an `allow`
 * is never upgraded on this side — except the conservative risk downgrade
 * documented above. Reuse the existing checks here.
 */
export type CapabilityGate = (id: string, ctx: GateContext) => GateVerdict;

export interface PlanCapabilityOptions {
	/** Disabled-by-default. Without this the adapter is `mode: "off"`. */
	enabled?: boolean;
	/** Approval/health/trust gate. Required to reach `mode: "active"`. */
	gate?: CapabilityGate;
	/** Passed through to `expandExecutionComplete`. */
	bundle?: ExpandOptions;
	/** Risk signals + exclusion policy for fidelity (its `enabled` is forced true). */
	fidelity?: Omit<FidelityMapOptions, "enabled">;
	/** History + weights for ranking (its `enabled`/`plan` are supplied internally). */
	ranking?: Omit<RankOptions, "enabled" | "plan">;
}

export interface CapabilityExecutionDecision {
	id: string;
	tier: FidelityTier | null;
	rank: number;
	score: number;
	riskFlagged: boolean;
	recommendedExclusion: boolean;
	decision: GateDecision;
	executionCondition: ExecutionCondition;
	reason: string;
}

export interface CapabilityPlan {
	mode: "off" | "observe" | "active";
	enabled: boolean;
	seeds: string[];
	bundle: ExecutionCompleteBundle;
	fidelity: FidelityPlan;
	ranking: RankedBundle;
	decisions: CapabilityExecutionDecision[];
	/** The ONLY ids a caller may execute. Gate-approved and never risk-flagged. */
	approved: string[];
	requiresApproval: string[];
	denied: string[];
}

function offPlan(seeds: string[]): CapabilityPlan {
	const emptyBundle: ExecutionCompleteBundle = {
		mode: "observe",
		seeds,
		included: [...seeds],
		prerequisites: [],
		validations: [],
		rollbacks: [],
		conflicts: [],
		missing: [],
		truncated: false,
		cycles: [],
	};
	return {
		mode: "off",
		enabled: false,
		seeds,
		bundle: emptyBundle,
		fidelity: {
			mode: "observe",
			enabled: false,
			assignments: [],
			byTier: { L0: [], L1: [], L2: [], L3: [], L4: [] },
			riskFlags: [],
			recommendedExclusions: [],
		},
		ranking: { mode: "suggest", enabled: false, ranking: [] },
		decisions: [],
		approved: [],
		requiresApproval: [],
		denied: [],
	};
}

/**
 * Compose the capability pipeline and produce an approval-gated capability plan.
 * Pure, never executes, fail-open. Inert (`off`) when disabled.
 */
export function planCapabilityBundle(
	graph: CapabilityGraph,
	seedIds: readonly string[],
	options: PlanCapabilityOptions = {},
): CapabilityPlan {
	const seeds = Array.isArray(seedIds) ? seedIds.filter(s => typeof s === "string" && s.length > 0) : [];
	if (options.enabled !== true) return offPlan(seeds);

	try {
		const bundle = expandExecutionComplete(graph, seeds, options.bundle ?? {});
		const fidelity = mapBundleToFidelity(bundle, { enabled: true, ...(options.fidelity ?? {}) });
		const ranking = rankBundle(bundle, { enabled: true, plan: fidelity, ...(options.ranking ?? {}) });

		const excluded = new Set(fidelity.recommendedExclusions);
		const flagged = new Set(fidelity.riskFlags.filter(f => f.recommendExclude).map(f => f.id));
		const gate = options.gate;
		const mode: "observe" | "active" = gate ? "active" : "observe";

		const rollbacksSet = new Set(bundle.rollbacks);
		const validationsSet = new Set(bundle.validations);

		const decisions: CapabilityExecutionDecision[] = ranking.ranking.map((r, rank) => {
			const recommendedExclusion = excluded.has(r.id);
			const riskFlagged = flagged.has(r.id) || recommendedExclusion;
			const ctx: GateContext = { tier: r.tier, rank, score: r.score, riskFlagged, recommendedExclusion };

			let executionCondition: ExecutionCondition = "always";
			if (rollbacksSet.has(r.id)) {
				executionCondition = "on-failure";
			} else if (validationsSet.has(r.id)) {
				executionCondition = "on-success";
			}

			let decision: GateDecision = "needs-approval";
			let reason = "no gate supplied → observe-only; approval required before execution";

			if (gate) {
				let verdict: GateVerdict;
				try {
					verdict = gate(r.id, ctx);
				} catch {
					verdict = { decision: "deny", reason: "gate threw; failing closed" };
				}
				decision = verdict.decision;
				reason = verdict.reason ?? `gate: ${verdict.decision}`;

				// Conservative override: a risk-flagged exclusion is never auto-approved.
				if (decision === "allow" && recommendedExclusion) {
					decision = "needs-approval";
					reason = "risk override: gate allowed but capability is a recommended exclusion → needs approval";
				}
			}

			return {
				id: r.id,
				tier: r.tier,
				rank,
				score: r.score,
				riskFlagged,
				recommendedExclusion,
				decision,
				executionCondition,
				reason,
			};
		});

		const approved = decisions.filter(d => d.decision === "allow").map(d => d.id);
		const requiresApproval = decisions.filter(d => d.decision === "needs-approval").map(d => d.id);
		const denied = decisions.filter(d => d.decision === "deny").map(d => d.id);

		return { mode, enabled: true, seeds, bundle, fidelity, ranking, decisions, approved, requiresApproval, denied };
	} catch {
		return offPlan(seeds);
	}
}
