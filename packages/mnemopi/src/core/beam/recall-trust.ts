import {
	importedWeight,
	inferredWeight,
	statedWeight,
	tier1Weight,
	tier2Weight,
	tier3Weight,
	toolWeight,
	unknownWeight,
} from "../../config";

/**
 * Score multipliers for a candidate's stored `veracity` label and, for episodic
 * rows, its degradation tier. Resolved once per recall from the
 * `MNEMOPI_<LABEL>_WEIGHT` and `MNEMOPI_TIER<N>_WEIGHT` readers in `config.ts`,
 * clamped at 0 like the hybrid weights so a negative value cannot rank a row
 * below one labelled `false`; `true`, `likely_true` and `false` have no override.
 */
export interface TrustWeights {
	readonly veracity: Readonly<Record<string, number>> & { readonly unknown: number };
	readonly tiers: readonly [tier1: number, tier2: number, tier3: number];
}

export function resolveTrustWeights(): TrustWeights {
	return {
		veracity: {
			stated: Math.max(0, statedWeight()),
			true: 1.0,
			likely_true: 1.0,
			unknown: Math.max(0, unknownWeight()),
			inferred: Math.max(0, inferredWeight()),
			imported: Math.max(0, importedWeight()),
			tool: Math.max(0, toolWeight()),
			false: 0,
		},
		tiers: [Math.max(0, tier1Weight()), Math.max(0, tier2Weight()), Math.max(0, tier3Weight())],
	};
}

/**
 * Veracity multiplier times degradation-tier multiplier for a stored row. A
 * result of 0 means the row must not surface in any recall path. Pass `tier`
 * only for episodic rows; an unrecognised or empty label counts as `unknown`.
 */
export function recallTrustWeight(trust: TrustWeights, veracity: unknown, tier?: number): number {
	const label = typeof veracity === "string" && veracity.length > 0 ? veracity : "unknown";
	const known = Object.hasOwn(trust.veracity, label) ? trust.veracity[label] : undefined;
	const veracityWeight = known ?? trust.veracity.unknown;
	if (tier === undefined) return veracityWeight;
	const [tier1, tier2, tier3] = trust.tiers;
	return veracityWeight * (tier === 1 ? tier1 : tier === 2 ? tier2 : tier3);
}
