import { describe, expect, test } from "bun:test";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";

/**
 * Providers whose bundled slice is one account's credential-scoped snapshot
 * rather than a public catalog, so a declared default missing from the bundle
 * is not proof the id is gone upstream. `devin` discovers through an
 * authenticated `GetCliModelConfigs` RPC; its snapshot carries only the SKUs
 * that account could see.
 */
const CREDENTIAL_SCOPED_SNAPSHOT_PROVIDERS = new Set(["devin"]);

describe("provider default models", () => {
	// A bundled slice is the catalog's own snapshot of what a provider serves.
	// When one exists, the declared `defaultModel` has to be in it: that id is
	// what `pickDefaultAvailableModel` matches on, so a default that no longer
	// exists demotes the provider to "no default" and first-run selection falls
	// through to whatever model happens to sort first.
	//
	// Providers with no bundled slice at all (local engines, discovery-only
	// backends) are out of scope — they resolve their catalog at runtime.
	test.each(
		CATALOG_PROVIDERS.filter(
			provider =>
				!CREDENTIAL_SCOPED_SNAPSHOT_PROVIDERS.has(provider.id) &&
				getBundledModels(provider.id as GeneratedProvider).length > 0,
		).map(provider => [provider.id, provider.defaultModel] as const),
	)("%s declares a bundled default model (%s)", (providerId, defaultModel) => {
		const ids = getBundledModels(providerId as GeneratedProvider).map(model => model.id);
		expect(ids).toContain(defaultModel);
	});
});
