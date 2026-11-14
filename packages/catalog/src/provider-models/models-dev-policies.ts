import { isExcludedModel } from "../compat/behavior";
import { seedModels } from "../compat/providers";
import type { Api, ModelSpec } from "../types";

/**
 * Remove models.dev rows that OMP cannot route successfully; the roster
 * policy lives in the `exclude-models` behavior rules.
 *
 * Generation and runtime refresh share this policy so a live catalog cannot
 * reintroduce selectors deliberately excluded from the bundled catalog.
 * A provider's own authored seed rows (`rules/providers/<id>.kdl`) win over
 * that provider's exclusions: a family exclusion such as `prefix="grok-voice-"`
 * keeps discovered ids out without dropping the seeded runner row.
 */
export function filterModelsDevCatalogRows<TApi extends Api>(models: readonly ModelSpec<TApi>[]): ModelSpec<TApi>[] {
	const seedIds = new Map<string, Set<string>>();
	const isSeed = (provider: string, id: string): boolean => {
		let ids = seedIds.get(provider);
		if (!ids) {
			ids = new Set(seedModels(provider).map(seed => seed.id));
			seedIds.set(provider, ids);
		}
		return ids.has(id);
	};
	return models.filter(model => !isExcludedModel(model.provider, model.id) || isSeed(model.provider, model.id));
}
