import type { Api, Model } from "@oh-my-pi/pi-ai";
import { isCredentialScopedModelCacheProvider } from "@oh-my-pi/pi-catalog/provider-models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "./model-registry";
import { resolveSessionModelSelector, sessionModelDiscoveryProviders } from "./model-resolver";

interface RestoredSessionModel {
	model: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	index: number;
}

interface SessionModelRestoreOptions {
	disabledProviders: ReadonlySet<string>;
	allowOnlineRevalidation?: boolean;
}

function findSavedModel(
	modelRegistry: ModelRegistry,
	selectors: readonly string[],
	disabledProviders: ReadonlySet<string>,
): RestoredSessionModel | undefined {
	for (const [index, selector] of selectors.entries()) {
		const restored = resolveSessionModelSelector(modelRegistry, selector);
		if (restored && !disabledProviders.has(restored.model.provider)) return { ...restored, index };
	}
	return undefined;
}

/** Resolve saved models identically at startup and when switching conversations. */
export async function restoreSessionModels(
	modelRegistry: ModelRegistry,
	selectors: readonly string[],
	options: SessionModelRestoreOptions,
): Promise<RestoredSessionModel | undefined> {
	const local = findSavedModel(modelRegistry, selectors, options.disabledProviders);
	if (local) return local;

	const providers = sessionModelDiscoveryProviders(modelRegistry, selectors, options.disabledProviders);
	if (providers.size === 0) return undefined;

	// Share a pending startup request instead of issuing a competing fetch.
	await logger.time("restoreSessionModelDiscoveryFallback", () =>
		modelRegistry.refreshDiscoverableProviders(providers, "online-if-uncached"),
	);
	const discovered = findSavedModel(modelRegistry, selectors, options.disabledProviders);
	if (discovered || options.allowOnlineRevalidation === false) return discovered;

	const cachedProviders = new Set<string>();
	for (const provider of providers) {
		const state = modelRegistry.getProviderDiscoveryState(provider);
		// Only recheck built-in account catalogs that actually served fresh cache.
		// A provider fetch already established the current roster; failed/stale
		// discovery must not pay another network timeout. Public/configured
		// catalogs and extension routes retain their normal freshness policy.
		if (
			modelRegistry.getDiscoveryProviderId(provider) === undefined &&
			isCredentialScopedModelCacheProvider(provider) &&
			state?.source === "cache" &&
			!state.stale
		) {
			cachedProviders.add(provider);
		}
	}
	if (cachedProviders.size === 0) return undefined;

	await logger.time("restoreSessionModelOnlineRevalidation", () =>
		modelRegistry.refreshDiscoverableProviders(cachedProviders, "online"),
	);
	return findSavedModel(modelRegistry, selectors, options.disabledProviders);
}
