import { fetchAntigravityDiscoveryModels } from "../discovery/antigravity";
import { fetchGeminiModels } from "../discovery/gemini";
import { fetchGeminiCliQuotaModels } from "../discovery/gemini-cli";
import { isGeminiModelId } from "../identity/family";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";
import { GEMINI_CLI_VARIANT_COLLAPSE_TABLE } from "../variant-collapse";

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

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	fetch?: FetchImpl;
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	/** GCP project id required by Workspace/Standard credentials for quota discovery. */
	projectId?: string;
	endpoint?: string;
	fetch?: FetchImpl;
}

const CLOUD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

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
		...(apiKey
			? { fetchDynamicModels: () => fetchGeminiModels({ apiKey, fetch: toDiscoveryFetch(config?.fetch) }) }
			: undefined),
	};
}

export function googleVertexModelManagerOptions(_config?: GoogleVertexModelManagerConfig): ModelManagerOptions {
	return { providerId: "google-vertex" };
}

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	return {
		providerId: "google-antigravity",
		...(token
			? {
					fetchDynamicModels: () =>
						fetchAntigravityDiscoveryModels({
							token,
							endpoint: config?.endpoint,
							fetcher: toDiscoveryFetch(config?.fetch),
						}),
				}
			: undefined),
	};
}

export function googleGeminiCliModelManagerOptions(
	config?: GoogleGeminiCliModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	const endpoint = config?.endpoint ?? CLOUD_CODE_ASSIST_ENDPOINT;
	return {
		providerId: "google-gemini-cli",
		...(token
			? {
					fetchDynamicModels: async () => {
						const fetcher = toDiscoveryFetch(config?.fetch);
						const models = await fetchAntigravityDiscoveryModels({
							token,
							fetcher,
							collapseTable: GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
						});
						// Antigravity's fetchAvailableModels is unreachable for
						// credentials without Antigravity entitlement (Code Assist
						// Standard returns HTTP 403). Fall back to the account's own
						// retrieveUserQuota list on Cloud Code Assist.
						if (models === null) {
							return fetchGeminiCliQuotaModels({ token, projectId: config?.projectId, endpoint, fetcher });
						}
						return models
							.filter(m => isGeminiModelId(m.id))
							.map(m => ({
								...m,
								provider: "google-gemini-cli" as const,
								baseUrl: endpoint,
							}));
					},
				}
			: undefined),
	};
}
