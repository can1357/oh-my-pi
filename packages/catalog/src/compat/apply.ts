/**
 * Assign defined override values onto a freshly-built resolved compat record,
 * in place. Keys the record doesn't declare are ignored (loosely-typed config
 * may carry junk). `buildModel` is the only intended caller — the record being
 * mutated is the single per-model allocation; nothing here runs per request.
 */
export function applyCompatOverrides(compat: object, overrides: object | undefined): void {
	if (!overrides) return;
	for (const key in overrides) {
		const value = (overrides as Record<string, unknown>)[key];
		if (value !== undefined && key in compat) {
			(compat as Record<string, unknown>)[key] = value;
		}
	}
}
