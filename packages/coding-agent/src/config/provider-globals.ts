import { setImageProviderOrder } from "../tools/image-gen";
import * as webSearch from "../web/search";

interface ProviderGlobalSettings {
	get(path: "providers.webSearchOrder"): unknown;
	get(path: "providers.webSearchExclude"): unknown;
	get(path: "providers.imageOrder"): unknown;
}

export function applyProviderGlobalsFromSettings(settings: ProviderGlobalSettings): void {
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		webSearch.setExcludedSearchProviders(excludedWebSearchProviders.filter(webSearch.isSearchProviderId));
	}

	const orderedWebSearchProviders = settings.get("providers.webSearchOrder");
	if (Array.isArray(orderedWebSearchProviders)) {
		webSearch.setSearchProviderOrder(orderedWebSearchProviders.filter(webSearch.isSearchProviderId));
	}

	const orderedImageProviders = settings.get("providers.imageOrder");
	if (Array.isArray(orderedImageProviders)) {
		setImageProviderOrder(orderedImageProviders.filter((entry): entry is string => typeof entry === "string"));
	}
}
