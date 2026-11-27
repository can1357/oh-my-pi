import { fetchGeminiModels } from "../discovery/gemini";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";

export interface GoogleModelManagerConfig {
	apiKey?: string;
	fetch?: FetchImpl;
}

export interface GoogleVertexModelManagerConfig {
	apiKey?: string;
	project?: string;
	location?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

/** Rows whose cached effort ladder predates the native `minimal` drop (#10543). */
const GEMINI_FLASH_CACHE_MIGRATION_MODEL_IDS = ["gemini-3.7-flash", "gemini-3.8-flash"] as const;

function toDiscoveryFetch(fetchImpl: FetchImpl | undefined): typeof fetch | undefined {
	if (!fetchImpl) {
		return undefined;
	}
	return Object.assign(
		(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetchImpl(input, init),
		{ preconnect: fetchImpl.preconnect ?? fetch.preconnect },
	);
}

export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		dropCachedModelIdsOnStaticMismatch: GEMINI_FLASH_CACHE_MIGRATION_MODEL_IDS,
		...(apiKey
			? { fetchDynamicModels: () => fetchGeminiModels({ apiKey, fetch: toDiscoveryFetch(config?.fetch) }) }
			: undefined),
	};
}

export function googleVertexModelManagerOptions(_config?: GoogleVertexModelManagerConfig): ModelManagerOptions {
	return {
		providerId: "google-vertex",
		dropCachedModelIdsOnStaticMismatch: GEMINI_FLASH_CACHE_MIGRATION_MODEL_IDS,
	};
}
