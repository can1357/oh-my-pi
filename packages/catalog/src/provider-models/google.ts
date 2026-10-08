import { logger } from "@oh-my-pi/pi-utils";
import { reviewedCollapseTable } from "../compat/collapse";
import { classifyModel } from "../compat/taxonomy";
import { providerEntry } from "../compat/providers";
import { fetchAntigravityDiscoveryModels } from "../discovery/antigravity";
import { fetchGeminiModels } from "../discovery/gemini";
import { fetchGeminiCliQuotaModels } from "../discovery/gemini-cli";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import { unionAccountCatalogs } from "./account-access";

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

/** One Antigravity OAuth account whose `fetchAvailableModels` roster discovery reads. */
export interface GoogleAntigravityAccount {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/**
	 * Credential identity recorded in {@link ModelSpec.accountAccess} for every
	 * model this account serves (see `oauthAccountKey` in `@oh-my-pi/pi-ai`).
	 * When any account lacks one, no model records per-account access.
	 */
	accountKey?: string;
}

export interface GoogleAntigravityModelManagerConfig {
	/**
	 * Resolves every configured Antigravity account at discovery time. Rosters
	 * are plan-scoped (Claude 5.5 is served to some accounts only) and
	 * authoritative, so each account's roster is fetched and the results are
	 * unioned; reading one account's roster would prune models only its
	 * siblings serve (#14924).
	 *
	 * Returns `null` to abort discovery (e.g. an account's credential failed to
	 * refresh), keeping the previous/bundled catalog instead of caching a
	 * partial one.
	 */
	resolveAccounts?: () => Promise<readonly GoogleAntigravityAccount[] | null>;
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

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const resolveAccounts = config?.resolveAccounts;
	return {
		providerId: "google-antigravity",
		dynamicModelsAuthoritative: providerEntry("google-antigravity")?.dynamicModelsAuthoritative === true,
		...(resolveAccounts
			? {
					fetchDynamicModels: async () => {
						const accounts = await resolveAccounts();
						if (!accounts || accounts.length === 0) return null;
						const fetcher = toDiscoveryFetch(config?.fetch);
						const rosters = await Promise.all(
							accounts.map(async account => ({
								accountKey: account.accountKey,
								result: await fetchAntigravityDiscoveryModels({
									token: account.accessToken,
									endpoint: config?.endpoint,
									fetcher,
								}),
							})),
						);
						const catalogs: { accountKey: string | undefined; models: ModelSpec<"google-gemini-cli">[] }[] = [];
						for (const { accountKey, result } of rosters) {
							// A transient failure would leave the union partial; keep the previous catalog.
							if (!result) return null;
							if (result.rejectedStatus !== undefined) {
								logger.warn("Antigravity model discovery skipped an account whose credential was rejected", {
									accountKey,
									status: result.rejectedStatus,
								});
								continue;
							}
							catalogs.push({ accountKey, models: result.models });
						}
						if (catalogs.length === 0) return null;
						const tagAccess = catalogs.every(catalog => catalog.accountKey !== undefined);
						return unionAccountCatalogs(
							catalogs.map(({ accountKey, models }) =>
								tagAccess && accountKey !== undefined
									? models.map(model => ({ ...model, accountAccess: { [accountKey]: {} } }))
									: models,
							),
						);
					},
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
						const collapseTable = reviewedCollapseTable("google-gemini-cli");
						if (collapseTable === undefined) {
							throw new Error("missing reviewed collapse table for google-gemini-cli");
						}
						const result = await fetchAntigravityDiscoveryModels({
							token,
							fetcher,
							collapseTable,
						});
						// Antigravity's fetchAvailableModels is unreachable for
						// credentials without Antigravity entitlement (Code Assist
						// Standard returns HTTP 403). Fall back to the account's own
						// retrieveUserQuota list on Cloud Code Assist.
						if (result === null || result.rejectedStatus !== undefined) {
							return fetchGeminiCliQuotaModels({ token, projectId: config?.projectId, endpoint, fetcher });
						}
						return result.models
							.filter(m => classifyModel("google-gemini-cli", m.id, { lenient: true }).class === "gemini")
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
