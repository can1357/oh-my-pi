import type { Api, ModelSpec } from "../types";

/**
 * Merge per-account discovery catalogs into one list, deduped by model id.
 *
 * The first catalog to list an id supplies its spec; {@link ModelSpec.accountAccess}
 * is merged from every catalog listing that id, so credential selection can
 * route account-gated models to the accounts that serve them.
 * {@link ModelSpec.serviceTiers} becomes the union of every listing's tiers, so
 * a tier only some accounts hold (Codex Ultrafast) stays selectable; each
 * account's own list survives in its `accountAccess` entry. Used by
 * multi-account discovery for Codex, whose rosters differ per
 * account.
 */
export function unionAccountCatalogs<TApi extends Api>(
	catalogs: readonly (readonly ModelSpec<TApi>[])[],
): ModelSpec<TApi>[] {
	const byId = new Map<string, ModelSpec<TApi>>();
	for (const catalog of catalogs) {
		for (const model of catalog) {
			const existing = byId.get(model.id);
			if (!existing) {
				byId.set(model.id, model);
			} else if (model.accountAccess || model.serviceTiers) {
				const merged: ModelSpec<TApi> = { ...existing };
				if (model.accountAccess) {
					merged.accountAccess = { ...existing.accountAccess, ...model.accountAccess };
				}
				if (model.serviceTiers) {
					merged.serviceTiers = [...new Set([...(existing.serviceTiers ?? []), ...model.serviceTiers])];
				}
				byId.set(model.id, merged);
			}
		}
	}
	return [...byId.values()];
}
