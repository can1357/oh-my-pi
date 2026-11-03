import { materializeWithdrawnRates } from "../pricing";
import type { CatalogPolicyInputs, EffectiveTokenCost } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

const NONE: readonly EffectiveTokenCost[] = Object.freeze([]);
/** Keyed by the model object: bundled rows are shared, so a repeat lookup allocates nothing. */
const withdrawnCache = new WeakMap<CatalogPolicyInputs, readonly EffectiveTokenCost[]>();

/**
 * Dated rate cards a released catalog priced this model with and later
 * withdrew (`withdrawn-rates` axis), ascending by `effectiveFrom`; empty when
 * none. Each card replaced the model's whole base card from its date under the
 * model's recurring tariff, as a `time-based-cost` effective rate does, so
 * `calculateWithdrawnRateCost` reproduces the price it set. Throws on a
 * malformed rule.
 */
export function resolveWithdrawnRates(model: CatalogPolicyInputs): readonly EffectiveTokenCost[] {
	let cards = withdrawnCache.get(model);
	if (cards === undefined) {
		const value = resolveCatalogPolicy(model).withdrawnRates;
		cards = value === undefined ? NONE : Object.freeze(materializeWithdrawnRates(value));
		withdrawnCache.set(model, cards);
	}
	return cards;
}
