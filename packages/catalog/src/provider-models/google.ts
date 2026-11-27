import { logger } from "@oh-my-pi/pi-utils";
import { isExcludedModel } from "../compat/behavior";
import { providerEntry } from "../compat/providers";
import { fetchAntigravityDiscoveryModels } from "../discovery/antigravity";
import { fetchGeminiModels } from "../discovery/gemini";
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
	/** Cloud Code Assist project of the credential, sent with roster discovery like the native client. */
	projectId?: string;
	/** Provider-reported tier id of the credential, sent as the roster request's `entitlement.userTier`. */
	userTier?: string;
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
									projectId: account.projectId,
									userTier: account.userTier,
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
							// Caches written under older rules fail the compiled-rules hash in
							// the model cache, so filtering fresh rosters covers every source.
							catalogs.push({
								accountKey,
								models: result.models.filter(model => !isExcludedModel("google-antigravity", model.id)),
							});
						}
						if (catalogs.length === 0) return null;
						const tagAccess = catalogs.every(catalog => catalog.accountKey !== undefined);
						return unionAccountCatalogs(
							catalogs.map(({ accountKey, models }) =>
								tagAccess && accountKey !== undefined
									? models.map(model => ({
											...model,
											accountAccess: {
												[accountKey]:
													model.antigravityWireProfiles === undefined
														? {}
														: { antigravityWireProfiles: model.antigravityWireProfiles },
											},
										}))
									: models,
							),
						);
					},
				}
			: undefined),
	};
}
