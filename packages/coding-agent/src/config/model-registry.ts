import * as path from "node:path";
import type { ApiKeyResolver, FetchImpl, UsageProvider } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { registerOAuthProvider, unregisterOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { setCodexAttestationProvider } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type {
	Api,
	Context,
	Model,
	ModelSpec,
	RemoteCompactionConfig,
	SimpleStreamOptions,
	ThinkingConfig,
} from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { collapseBuiltVariants } from "@oh-my-pi/pi-catalog/compat/collapse";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import {
	createModelManager,
	fingerprintStaticModels,
	type ModelManagerOptions,
	type ModelRefreshStrategy,
} from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import {
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	isCredentialScopedModelCacheProvider,
	MODELS_DEV_CATALOG_PROVIDER_IDS,
	modelsDevCatalogFallback,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
	resolveModelCacheProviderId,
	resolveOllamaModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { getAgentDir, isBunTestRuntime, logger, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import { resolveProviderModelReference } from "../config/model-resolver";
import { generateCodexAttestation } from "../live/attestation";
import type { AuthStorage } from "../session/auth-storage";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import type { ConfigError, ConfigFile } from "./config-file";
import {
	buildCustomModelOverlay,
	type CustomModelDefinitionLike,
	type CustomModelOverlay,
	finalizeCustomModel,
	mergeAuthHeaderSources,
	normalizeSuppressedSelector,
	resolveModelOverrideWithAliases,
} from "./custom-models";
import {
	type CommandApiKeyResolution,
	createLiveConfigHeaders,
	invalidateCommandConfig,
	isCommandConfigValue,
	resolveConfigHeaders,
	resolveConfigValue,
} from "./model-config-values";
import {
	applyLlamaCppQwenThinking,
	DISCOVERY_DEFAULT_MAX_TOKENS,
	type DiscoveryContext,
	type DiscoveryProviderConfig,
	discoverLlamaCppModelRuntimeMetadata,
	discoverLmStudioModelRuntimeMetadata,
	discoverModelsByProviderType,
	ensureLlamaCppV1BaseUrl,
	getImplicitOllamaBaseUrl,
	getOllamaContextLengthOverride,
	normalizeBareDiscoveryBaseUrl,
	normalizeLiteLLMDiscoveryBaseUrl,
	normalizeLlamaCppBaseUrl,
} from "./model-discovery";
import {
	AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS,
	applyModelOverride,
	applyModelPatch,
	dropProviderModels,
	type ModelPatch,
	mergeByModelKey,
	mergeCompat,
	mergeDiscoveredModel,
	mergeProviderRemoteCompactionConfig,
	mergeRemoteCompactionConfig,
	type ProviderOverride,
	providersWithAuthoritativeProjectCatalog,
} from "./model-patch";
import {
	BUILT_IN_DISCOVERY_CACHE_TTL_MS,
	BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS,
	type BuiltInDiscoveryResult,
	extractGoogleOAuthProjectId,
	extractGoogleOAuthToken,
	getOAuthCredentialsForProvider,
	isAuthenticated,
	isDiscoveryBearerApiKey,
	kNoAuth,
	type ProviderDiscoveryState,
	RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS,
	resolveCodexDiscoveryAccounts,
	SPECIAL_MODEL_MANAGER_PROVIDER_IDS,
	STARTUP_MODEL_CACHE_PROVIDER_IDS,
	withModelDiscoveryTimeout,
} from "./model-provider-discovery";

export { mergeDiscoveredModel } from "./model-patch";
export {
	isAuthenticated,
	kNoAuth,
	type ProviderDiscoveryState,
	type ProviderDiscoveryStatus,
} from "./model-provider-discovery";

import { ModelsConfigFile, type ProviderValidationModel, validateProviderConfiguration } from "./models-config";
import type { ModelOverride, ModelsConfig, ProviderAuthMode } from "./models-config-schema";
import { type Settings, settings } from "./settings";

// DeviceCheck attestation (`x-oai-attestation`) for ChatGPT-OAuth Codex
// requests; the pi-ai provider resolves it just-in-time per request.
setCodexAttestationProvider(generateCodexAttestation);

const BUILT_IN_MODEL_MANAGER_PROVIDER_IDS: Readonly<Record<string, true>> = Object.freeze(
	Object.fromEntries(
		[...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId), ...SPECIAL_MODEL_MANAGER_PROVIDER_IDS].map(
			providerId => [providerId, true as const],
		),
	),
);
const MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP: Readonly<Record<string, true>> = Object.freeze(
	Object.fromEntries(MODELS_DEV_CATALOG_PROVIDER_IDS.map(providerId => [providerId, true as const])),
);
const ADDITIVE_MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP: Readonly<Record<string, true>> = Object.freeze(
	Object.fromEntries(
		MODELS_DEV_CATALOG_PROVIDER_IDS.filter(
			providerId =>
				!PROVIDER_DESCRIPTORS.some(
					descriptor => descriptor.providerId === providerId && descriptor.dynamicModelsAuthoritative,
				),
		).map(providerId => [providerId, true as const]),
	),
);

/**
 * Bedrock guardrail fields to spread onto a model spec, dropping keys that a
 * provider override left unset so an override never clobbers an existing value
 * with `undefined`.
 */
function guardrailOverrideFields(override: ProviderOverride): Partial<ModelSpec<Api>> {
	const fields: Partial<ModelSpec<Api>> = {};
	if (override.guardrailIdentifier !== undefined) fields.guardrailIdentifier = override.guardrailIdentifier;
	if (override.guardrailVersion !== undefined) fields.guardrailVersion = override.guardrailVersion;
	if (override.guardrailTrace !== undefined) fields.guardrailTrace = override.guardrailTrace;
	return fields;
}

/** Result of loading custom models config. */
interface CustomModelsResult {
	models?: CustomModelOverlay[];
	overrides?: Map<string, ProviderOverride>;
	modelOverrides?: Map<string, Map<string, ModelOverride>>;
	keylessProviders?: Set<string>;
	discoverableProviders?: DiscoveryProviderConfig[];
	configuredProviders?: Set<string>;
	error?: ConfigError;
	found: boolean;
}

/**
 * Credential-aware model projection supplied by an extension provider. Receives
 * the fully composed catalog and returns the list the host should serve.
 */
type ModifyModelsHook = (models: Model<Api>[], credentials: OAuthCredentials) => Model<Api>[];

function getDisabledProviderIdsFromSettings(settingsInstance?: Settings): Set<string> {
	try {
		return new Set((settingsInstance ?? settings).get("disabledProviders"));
	} catch {
		return new Set();
	}
}

/**
 * Whether premium long-context windows are enabled. Defaults to true when no
 * settings source is available (SDK embedding, early boot).
 */
function isExtendedContextEnabledFromSettings(settingsInstance?: Settings): boolean {
	try {
		return (settingsInstance ?? settings).get("extendedContext");
	} catch {
		return true;
	}
}

interface CatalogModelMetrics {
	int?: number;
	tps?: number;
}

function collectCatalogModelMetrics(models: readonly Model<Api>[]): Map<string, CatalogModelMetrics> {
	const metrics = new Map<string, CatalogModelMetrics>();
	for (const model of models) {
		const int = model.int != null && Number.isFinite(model.int) ? model.int : undefined;
		const tps = model.tps != null && Number.isFinite(model.tps) && model.tps > 0 ? model.tps : undefined;
		if (int === undefined && tps === undefined) continue;
		const key = model.id.toLowerCase();
		const current = metrics.get(key);
		metrics.set(key, {
			...(int !== undefined || current?.int !== undefined ? { int: int ?? current?.int } : {}),
			...(tps !== undefined || current?.tps !== undefined ? { tps: tps ?? current?.tps } : {}),
		});
	}
	return metrics;
}

function applyCatalogModelMetrics(
	models: Model<Api>[],
	metrics: ReadonlyMap<string, CatalogModelMetrics>,
): Model<Api>[] {
	if (metrics.size === 0) return models;
	let changed: Model<Api>[] | undefined;
	for (let index = 0; index < models.length; index++) {
		const model = models[index];
		const metric = metrics.get(model.id.toLowerCase());
		if (!metric) continue;
		if (
			(metric.int === undefined || metric.int === model.int) &&
			(metric.tps === undefined || metric.tps === model.tps)
		) {
			continue;
		}
		changed ??= [...models];
		changed[index] = {
			...model,
			...(metric.int !== undefined ? { int: metric.int } : {}),
			...(metric.tps !== undefined ? { tps: metric.tps } : {}),
		};
	}
	return changed ?? models;
}

/** Authentication material returned to legacy extensions for one model request. */
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	#models: Model<Api>[] = [];
	#unprojectedModels: Model<Api>[] = [];
	#hasFullSnapshot = false;
	#cachedStandardModelsByProvider: Map<string, Model<Api>[]> = new Map();
	#pendingStandardCacheProviders: Set<string> = new Set();
	#cachedDiscoverableModels: Model<Api>[] = [];
	#cachedAuthoritativeProviders: Set<string> = new Set();
	#runtimeDiscoveredModels: Model<Api>[] = [];
	#runtimeAuthoritativeProviders: Set<string> = new Set();
	#catalogMetrics: Map<string, CatalogModelMetrics> = new Map();
	#internedStaticModels: Map<string, Model<Api>> = new Map();
	#providerLookupSnapshots: Map<string, Model<Api>[]> = new Map();
	#customProviderApiKeys: Map<string, string> = new Map();
	// Every command-backed (`!cmd`) config value a provider carries — apiKey plus
	// provider/model-override header values — keyed by provider. The 401 auth
	// retry invalidates these command caches so refreshed credentials reach the
	// retry request through the live header proxy, not just the apiKey (#9760).
	#commandConfigsByProvider: Map<string, Set<string>> = new Map();
	#keylessProviders: Set<string> = new Set();
	#discoverableProviders: DiscoveryProviderConfig[] = [];
	#customModelOverlays: CustomModelOverlay[] = [];
	#providerOverrides: Map<string, ProviderOverride> = new Map();
	#modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	#configError: ConfigError | undefined = undefined;
	#modelsConfigFile: ConfigFile<ModelsConfig>;
	#lastStaticLoadMtime: number | null = null;
	#registeredProviderSources: Set<string> = new Set();
	#providerDiscoveryStates: Map<string, ProviderDiscoveryState> = new Map();
	#cacheDbPath?: string;
	#suppressedSelectors: Map<string, number> = new Map();
	#backgroundRefresh?: Promise<void>;
	/** Whether the first background discovery has settled; latches once so a late-armed waiter still resolves. */
	#initialRefreshSettled = false;
	/** Waiter armed before the initial background refresh starts (CLI kicks it off after the session is built, #10048). */
	#initialRefreshWaiters = new Set<() => void>();
	#credentialScopedCacheHydration?: Promise<void>;
	#configuredDiscoveryInFlight: Map<DiscoveryProviderConfig, Map<ModelRefreshStrategy, Promise<Model<Api>[]>>> =
		new Map();
	#policyReapply?: Promise<void>;
	#lastDiscoveryWarnings: Map<string, string> = new Map();
	// Runtime extension model overlays — persist across refresh() cycles so that
	// models registered by extensions survive the model selector's offline reload.
	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();
	// Credential-aware model projections registered via
	// `registerProvider({ oauth: { modifyModels } })`. Persisted for the same
	// reason as #runtimeModelOverlays: the overlays hold the *pre-projection*
	// definitions, so without re-applying the projection every static reload
	// would silently revert the provider to its unprojected catalog.
	#runtimeModelModifiers: Map<string, ModifyModelsHook> = new Map();
	#lastModelModifierWarnings: Map<string, string> = new Map();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();
	// Runtime model managers registered by extensions via fetchDynamicModels.
	// Keyed by provider name; use the same SQLite cache path as builtins.
	#runtimeModelManagers: Map<string, { options: ModelManagerOptions<Api>; sourceId: string }> = new Map();
	#ignoreLocalModelConfig: boolean;
	#fetch: FetchImpl;
	#settings: Settings | undefined;

	#captureCatalogMetrics(models: readonly Model<Api>[], replace: boolean): void {
		const incoming = collectCatalogModelMetrics(models);
		if (incoming.size === 0) return;
		if (replace) {
			this.#catalogMetrics = incoming;
			return;
		}
		for (const [id, metrics] of incoming) this.#catalogMetrics.set(id, metrics);
	}

	#withCatalogMetrics(models: Model<Api>[]): Model<Api>[] {
		return applyCatalogModelMetrics(models, this.#catalogMetrics);
	}

	#resolveCommandBackedApiKey(provider: string, options?: { forceCommandRefresh?: boolean }): CommandApiKeyResolution {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		if (!isCommandConfigValue(keyConfig)) return { configured: false };
		const value = resolveConfigValue(keyConfig, options);
		if (value) {
			this.authStorage.setConfigApiKey(provider, value);
			return { configured: true, value };
		}
		this.authStorage.removeConfigApiKey(provider);
		return { configured: true };
	}

	/**
	 * Accumulate every command-backed (`!cmd`) config value from an apiKey and a
	 * header record into `target`. Used at load time to record which commands a
	 * provider depends on so the 401 refresh path can invalidate all of them.
	 */
	#collectCommandConfigValues(
		target: Set<string>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
	): void {
		if (isCommandConfigValue(apiKey)) target.add(apiKey);
		if (!headers) return;
		for (const key in headers) {
			const value = headers[key];
			if (isCommandConfigValue(value)) target.add(value);
		}
	}

	/**
	 * Drop the process-cached results of every command-backed config value a
	 * provider carries (apiKey plus provider/model-override header commands) so
	 * the next resolve re-runs them. Invoked on the 401 force-refresh path: the
	 * apiKey alone was refreshed before, leaving command-backed header
	 * credentials pinned to their stale value across the retry (#9760).
	 */
	#invalidateProviderCommandConfigs(provider: string): void {
		invalidateCommandConfig(this.#customProviderApiKeys.get(provider));
		const configs = this.#commandConfigsByProvider.get(provider);
		if (!configs) return;
		for (const config of configs) invalidateCommandConfig(config);
	}

	#installProviderApiKey(provider: string, keyConfig: string): void {
		this.#customProviderApiKeys.set(provider, keyConfig);
		const resolved = resolveConfigValue(keyConfig);
		if (resolved) {
			this.authStorage.setConfigApiKey(provider, resolved);
		} else if (isCommandConfigValue(keyConfig)) {
			this.authStorage.removeConfigApiKey(provider);
		}
	}

	/**
	 * @param authStorage - Auth storage for API key resolution
	 *
	 * Sync constructor — eagerly loads config (including migrations), cache
	 * metadata, and custom models. Bundled providers are enriched selectively
	 * when synchronous callers query them. Production boot paths SHOULD prefer
	 * {@link ModelRegistry.create} so the YAML/JSONC migration step lands off the
	 * event loop's hot path before the first `tryLoad()` runs.
	 */
	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
		options?: {
			/**
			 * Gateway mode: ignore local `models.yml` entirely (provider overrides,
			 * config API keys, custom models, custom discovery). A broker-backed
			 * gateway serves only bundled + broker-discovered catalog metadata and
			 * must never apply client-side credential or routing overrides.
			 */
			ignoreLocalModelConfig?: boolean;
			/** Settings source for availability and context-window policies. */
			settings?: Settings;
			/** Model discovery cache database. Defaults beside an explicit models config. */
			cacheDbPath?: string;
			fetch?: FetchImpl;
		},
	) {
		this.#ignoreLocalModelConfig = options?.ignoreLocalModelConfig ?? false;
		this.#settings = options?.settings;
		this.#fetch =
			options?.fetch ??
			(isBunTestRuntime()
				? () => Promise.reject(new Error("network disabled in model-registry runtime test"))
				: wrapFetchForExtraCa(fetch));
		this.#modelsConfigFile = ModelsConfigFile.relocate(modelsPath ?? path.join(getAgentDir(), "models.yml"));
		this.#cacheDbPath =
			options?.cacheDbPath ?? (modelsPath ? path.join(path.dirname(modelsPath), "models.db") : undefined);
		// Set up fallback resolver for custom provider API keys
		this.authStorage.setFallbackResolver(provider => {
			const keyConfig = this.#customProviderApiKeys.get(provider);
			if (!keyConfig) return undefined;
			return resolveConfigValue(keyConfig);
		});
		// Load config and cache-backed layers synchronously in the constructor.
		this.#loadModels();
	}

	/**
	 * Reload models from disk (built-in + custom config).
	 */
	async refresh(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		this.#reloadStaticModels();
		this.#suppressedSelectors.clear();
		await this.#refreshRuntimeDiscoveries(strategy);
	}

	/**
	 * Hydrate credential-scoped built-in catalogs from their exact cache rows.
	 *
	 * The synchronous constructor cannot resolve credentials, so session startup
	 * awaits this local-only, best-effort pass before validating model selectors.
	 */
	async hydrateCredentialScopedModelCaches(): Promise<void> {
		if (!this.#credentialScopedCacheHydration) {
			const providerIds = new Set<string>();
			for (const providerId of STARTUP_MODEL_CACHE_PROVIDER_IDS) {
				if (isCredentialScopedModelCacheProvider(providerId)) providerIds.add(providerId);
			}
			this.#credentialScopedCacheHydration = this.#refreshRuntimeDiscoveries("offline", providerIds).catch(error => {
				logger.debug("credential-scoped model cache hydration failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
		const hydration = this.#credentialScopedCacheHydration;
		try {
			await hydration;
		} finally {
			if (this.#credentialScopedCacheHydration === hydration) {
				this.#credentialScopedCacheHydration = undefined;
			}
		}
	}

	/**
	 * Rebuild the catalog after a policy-affecting setting change (e.g.
	 * `extendedContext`). Forces the static reload past the models.yml mtime
	 * gate, then restores runtime-discovered models from the SQLite cache —
	 * offline, a settings flip must never hit the network. Concurrent calls
	 * coalesce onto one rebuild.
	 */
	reapplyModelPolicies(): Promise<void> {
		this.#policyReapply ??= this.#runPolicyReapply();
		return this.#policyReapply;
	}

	async #runPolicyReapply(): Promise<void> {
		try {
			this.#lastStaticLoadMtime = null;
			await this.refresh("offline");
		} finally {
			this.#policyReapply = undefined;
		}
	}

	refreshInBackground(strategy: ModelRefreshStrategy = "online-if-uncached"): void {
		if (this.#backgroundRefresh) {
			return;
		}
		const refreshPromise = this.refresh(strategy)
			.catch(error => {
				logger.warn("background model refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.#backgroundRefresh === refreshPromise) {
					this.#backgroundRefresh = undefined;
				}
				this.#markInitialRefreshSettled();
			});
		this.#backgroundRefresh = refreshPromise;
	}

	/**
	 * Wait for any in-flight background model discovery to settle.
	 *
	 * Background discovery started by {@link refreshInBackground} is
	 * fire-and-forget; RPC consumers (e.g. `get_available_models`,
	 * `set_model`) and deferred `--model` resolution that read the registry
	 * immediately after session creation can otherwise observe a partial
	 * catalog before discovery-backed providers have populated `#models`.
	 * Awaiting the tracked promise ensures the response reflects every
	 * configured provider once the initial background refresh resolves.
	 *
	 * No-op when no refresh is in flight (`#backgroundRefresh` cleared in the
	 * `finally` of `refreshInBackground` on completion). Resolves immediately
	 * in that case so already-warm sessions are unaffected. Discovery errors
	 * remain swallowed by `refreshInBackground`'s existing `.catch`.
	 */
	async awaitBackgroundRefresh(): Promise<void> {
		if (this.#backgroundRefresh) {
			await this.#backgroundRefresh;
		}
	}

	/**
	 * Resolve once the initial background discovery has settled, arming a waiter
	 * even when the refresh has not started yet. In the CLI path
	 * {@link refreshInBackground} runs right after the session is constructed
	 * (`main.ts`), so a consumer created in the constructor cannot rely on an
	 * in-flight snapshot — it must observe the settle whenever it happens.
	 * Resolves immediately once any background refresh has completed; never
	 * rejects (discovery errors are swallowed by `refreshInBackground`). Stays
	 * pending when no background refresh is ever started (e.g. an embedder that
	 * manages discovery itself), which leaves startup suppression in place.
	 * An optional abort signal releases a waiter when its owning session is
	 * disposed before an embedder starts discovery.
	 */
	awaitInitialBackgroundRefresh(signal?: AbortSignal): Promise<void> {
		if (this.#initialRefreshSettled) return Promise.resolve();
		if (signal?.aborted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const settle = () => {
			signal?.removeEventListener("abort", settle);
			this.#initialRefreshWaiters.delete(settle);
			resolve();
		};
		this.#initialRefreshWaiters.add(settle);
		signal?.addEventListener("abort", settle, { once: true });
		// Close the race with a refresh or abort settling between the guards
		// above and listener registration.
		if (this.#initialRefreshSettled || signal?.aborted) settle();
		return promise;
	}

	#markInitialRefreshSettled(): void {
		if (this.#initialRefreshSettled) return;
		this.#initialRefreshSettled = true;
		for (const settle of this.#initialRefreshWaiters) settle();
	}

	async refreshProvider(providerId: string, strategy: ModelRefreshStrategy = "online"): Promise<void> {
		this.#reloadStaticModels();
		for (const selector of this.#suppressedSelectors.keys()) {
			if (selector.startsWith(`${providerId}/`)) {
				this.#suppressedSelectors.delete(selector);
			}
		}
		await this.#refreshRuntimeDiscoveries(strategy, new Set([providerId]));
		// #reloadStaticModels above may have rebuilt #models from static sources,
		// dropping models previously discovered by OTHER runtime providers (their
		// fetchDynamicModels results live only in #models + the SQLite cache, not
		// in #loadModels' static inputs). Restore them from cache with the default
		// online-if-uncached strategy: no network while their cached row is
		// fresh, so the scoped refresh above stays the only forced fetch.
		const otherRuntimeProviderIds = new Set(
			[...this.#runtimeModelManagers.keys()].filter(runtimeId => runtimeId !== providerId),
		);
		if (otherRuntimeProviderIds.size > 0) {
			await this.#refreshRuntimeDiscoveries("online-if-uncached", otherRuntimeProviderIds);
		}
	}

	/**
	 * Refresh only the named discovery-backed providers, leaving every other
	 * provider's discovered models and any in-flight runtime discovery untouched.
	 *
	 * Unlike {@link refreshProvider}, this does no static reload and never
	 * re-fetches the other runtime managers, so restoring a saved
	 * discovery-backed model (e.g. on `omp --resume`) cannot wait on — or
	 * duplicate — an unrelated provider's network/OAuth work. Ids that are not
	 * configured discovery providers are ignored by the underlying filter.
	 */
	async refreshDiscoverableProviders(
		providerIds: Iterable<string>,
		strategy: ModelRefreshStrategy = "online-if-uncached",
	): Promise<void> {
		const filter = new Set(providerIds);
		if (filter.size === 0) return;
		await this.#refreshRuntimeDiscoveries(strategy, filter);
	}

	/**
	 * True when the provider's models expose context metadata that only appears
	 * after a lazy load — llama.cpp's `meta.n_ctx` once a cold instance spins up
	 * (#3310/#3311), LM Studio's `loaded_context_length` once it JIT-loads the
	 * model on the first inference (#9001). Callers use this to decide whether a
	 * post-first-response refresh is worth a native probe.
	 */
	hasLazyRuntimeMetadata(provider: string): boolean {
		return this.#findLazyRuntimeDiscovery(provider) !== undefined;
	}

	#findLazyRuntimeDiscovery(provider: string): DiscoveryProviderConfig | undefined {
		return this.#discoverableProviders.find(
			providerConfig =>
				providerConfig.provider === provider &&
				(providerConfig.discovery.type === "llama.cpp" || providerConfig.discovery.type === "lm-studio"),
		);
	}

	/**
	 * Refresh dynamic metadata that can appear only after a local model loads.
	 *
	 * llama.cpp exposes `meta.n_ctx` once a lazy-loaded instance is up
	 * (#3310/#3311); LM Studio exposes `loaded_context_length` once it JIT-loads
	 * the model on first inference (#9001). Both are captured only as a snapshot
	 * at discovery time, so re-probe the selected model's native runtime metadata
	 * and patch its context window to what the backend actually serves.
	 */
	async refreshSelectedModelMetadata(model: Model<Api>): Promise<Model<Api>> {
		const discoveryConfig = this.#findLazyRuntimeDiscovery(model.provider);
		if (!discoveryConfig) {
			return model;
		}
		this.#ensureFullSnapshot();
		const runtimeMetadata =
			discoveryConfig.discovery.type === "lm-studio"
				? await discoverLmStudioModelRuntimeMetadata(
						model,
						this.#nonResolvingDiscoveryContext(),
						discoveryConfig.discovery.timeoutMs,
					)
				: await discoverLlamaCppModelRuntimeMetadata(
						model,
						this.#nonResolvingDiscoveryContext(),
						discoveryConfig.discovery.timeoutMs,
					);
		if (runtimeMetadata === undefined) {
			return this.find(model.provider, model.id) ?? model;
		}
		const { contextWindow, maxTokens, input } = runtimeMetadata;
		const current = this.find(model.provider, model.id) ?? model;
		const override = this.#resolveLiveModelOverride(current);
		const customModel = this.#resolveLiveCustomModelOverlay(current);
		const patch: ModelPatch = {};
		if (
			contextWindow !== undefined &&
			override?.contextWindow === undefined &&
			customModel?.contextWindow === undefined &&
			current.contextWindow !== contextWindow
		) {
			patch.contextWindow = contextWindow;
		}
		const effectiveContextWindow =
			override?.contextWindow ??
			customModel?.contextWindow ??
			patch.contextWindow ??
			current.contextWindow ??
			contextWindow;
		if (maxTokens !== undefined && effectiveContextWindow !== undefined) {
			const effectiveMaxTokens = Math.min(maxTokens, effectiveContextWindow);
			if (
				override?.maxTokens === undefined &&
				customModel?.maxTokens === undefined &&
				current.maxTokens !== effectiveMaxTokens
			) {
				patch.maxTokens = effectiveMaxTokens;
			}
		}
		if (
			input !== undefined &&
			override?.input === undefined &&
			customModel?.input === undefined &&
			(current.input.length !== input.length || current.input.some((value, index) => value !== input[index]))
		) {
			patch.input = input;
		}
		if (patch.contextWindow === undefined && patch.maxTokens === undefined && patch.input === undefined) {
			return current;
		}
		const unprojected = resolveProviderModelReference(current.provider, current.id, this.#unprojectedModels);
		if (unprojected) {
			const patchedBase = applyModelPatch(unprojected, patch, "merge");
			this.#unprojectedModels = this.#unprojectedModels.map(candidate =>
				candidate.provider === unprojected.provider && candidate.id === unprojected.id ? patchedBase : candidate,
			);
			this.#models = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
			return resolveProviderModelReference(current.provider, current.id, this.#models) ?? patchedBase;
		}
		const patched = applyModelPatch(current, patch, "merge");
		this.#models = this.#models.map(candidate =>
			candidate.provider === current.provider && candidate.id === current.id ? patched : candidate,
		);
		return patched;
	}

	/**
	 * Discover models for providers registered at runtime via `fetchDynamicModels`
	 * (extension providers). Merges the discovered catalog into the existing model
	 * set without reloading static models, so dynamically-discovered models from
	 * other providers are preserved. No-op when no runtime providers are registered.
	 *
	 * Drives the same SQLite model cache as built-in providers, so the default
	 * `online-if-uncached` strategy fetches at most once per cache TTL (24 h).
	 */
	async refreshRuntimeProviders(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		if (this.#runtimeModelManagers.size === 0) {
			return;
		}
		await this.#refreshRuntimeDiscoveries(strategy, new Set(this.#runtimeModelManagers.keys()));
	}

	#reloadStaticModels(): void {
		const currentMtime = this.#modelsConfigFile.getMtimeMs();
		if (currentMtime !== null && currentMtime === this.#lastStaticLoadMtime) {
			// Models config unchanged since last load; reloading would be redundant.
			return;
		}
		this.#modelsConfigFile.invalidate();
		this.#customProviderApiKeys.clear();
		this.#keylessProviders.clear();
		this.#discoverableProviders = [];
		// Drop config-sourced apiKeys from AuthStorage before reload; entries
		// removed from models.yml must actually disappear from the resolver, not
		// linger from the previous parse. The post-load setters below repopulate.
		this.authStorage.clearConfigApiKeys();
		// Restore runtime API keys before #loadModels — survives because
		// #loadModels only calls .set() on #customProviderApiKeys, never reassigns it.
		for (const [k, v] of this.#runtimeProviderApiKeys) {
			this.#installProviderApiKey(k, v);
		}
		this.#providerOverrides.clear();
		this.#modelOverrides.clear();
		this.#configError = undefined;
		this.#providerDiscoveryStates.clear();
		this.#loadModels();
	}

	/**
	 * Get any error from loading custom models config (undefined if no error).
	 */
	getError(): ConfigError | undefined {
		return this.#configError;
	}

	#loadModels() {
		this.#resetStaticComposition();
		// Load custom config first (to know which providers to override).
		const {
			models: customModels = [],
			overrides = new Map(),
			modelOverrides = new Map(),
			keylessProviders = new Set<string>(),
			discoverableProviders = [],
			configuredProviders = new Set<string>(),
			error: configError,
		} = logger.time("modelRegistry:loadCustomModels", () => this.#loadCustomModels());
		this.#configError = configError;
		this.#keylessProviders = keylessProviders;
		this.#discoverableProviders = discoverableProviders;
		this.#customModelOverlays = customModels;
		this.#providerOverrides = overrides;
		this.#modelOverrides = modelOverrides;

		this.#addImplicitDiscoverableProviders(configuredProviders);
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(provider => provider.provider));
		this.#pendingStandardCacheProviders = new Set(
			STARTUP_MODEL_CACHE_PROVIDER_IDS.filter(
				providerId =>
					!configuredDiscoveryProviders.has(providerId) && !isCredentialScopedModelCacheProvider(providerId),
			),
		);
		this.#cachedDiscoverableModels = logger.time("modelRegistry:loadDiscoverableModels", () =>
			this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels()),
		);
		this.#lastStaticLoadMtime = this.#modelsConfigFile.getMtimeMs();
	}

	#resetStaticComposition(): void {
		this.#models = [];
		this.#unprojectedModels = [];
		this.#hasFullSnapshot = false;
		this.#cachedStandardModelsByProvider.clear();
		this.#pendingStandardCacheProviders.clear();
		this.#cachedAuthoritativeProviders.clear();
		this.#runtimeDiscoveredModels = [];
		this.#runtimeAuthoritativeProviders.clear();
		this.#internedStaticModels.clear();
		this.#providerLookupSnapshots.clear();
		this.#commandConfigsByProvider.clear();
	}

	#knownStaticProviders(): string[] {
		const providers = new Set<string>(getBundledProviders());
		for (const provider of this.#pendingStandardCacheProviders) providers.add(provider);
		for (const provider of this.#cachedStandardModelsByProvider.keys()) providers.add(provider);
		for (const model of this.#cachedDiscoverableModels) providers.add(model.provider);
		for (const model of this.#runtimeDiscoveredModels) providers.add(model.provider);
		for (const model of this.#customModelOverlays) providers.add(model.provider);
		for (const model of this.#runtimeModelOverlays) providers.add(model.provider);
		return [...providers];
	}

	#internStaticModels(models: Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			const key = `${model.provider}\u0000${model.id}`;
			const interned = this.#internedStaticModels.get(key);
			if (interned) return interned;
			this.#internedStaticModels.set(key, model);
			return model;
		});
	}

	#invalidateProviderModelCache(providerName: string): void {
		const prefix = `${providerName}\u0000`;
		for (const key of this.#internedStaticModels.keys()) {
			if (key.startsWith(prefix)) {
				this.#internedStaticModels.delete(key);
			}
		}
		this.#providerLookupSnapshots.delete(providerName);
	}

	/**
	 * Re-apply the credential-aware projections registered by extension providers.
	 *
	 * Runtime overlays hold the pre-projection definitions, so the registry keeps
	 * those definitions separate from `#models` and reruns the ordered hooks after
	 * every catalog rebuild. Otherwise an offline refresh silently restores the
	 * provider's placeholder catalog.
	 *
	 * A throwing hook falls back to the catalog produced by earlier hooks instead
	 * of failing the whole composition; one bad extension must not empty the
	 * registry. The failure is logged (deduped per provider) so it is not silent.
	 * Each hook receives a deep clone because the public contract permits
	 * mutation of both the array and its model records before returning.
	 */
	#applyRuntimeModelModifiers(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeModelModifiers.size === 0) return models;
		let projected = models;
		for (const [providerName, modifyModels] of this.#runtimeModelModifiers) {
			const credential = this.authStorage.getOAuthCredential(providerName);
			if (!credential) continue;
			try {
				// Live command-backed headers are a Proxy, which structuredClone
				// rejects. Materialize only header-bearing models before cloning so
				// modifier hooks still get an isolated, mutable catalog snapshot.
				let cloneableModels = projected;
				for (let index = 0; index < projected.length; index += 1) {
					const model = projected[index]!;
					if (!model.headers) continue;
					if (cloneableModels === projected) cloneableModels = [...projected];
					cloneableModels[index] = { ...model, headers: { ...model.headers } };
				}
				projected = modifyModels(structuredClone(cloneableModels), credential);
			} catch (error) {
				this.#warnModelModifierFailure(providerName, error instanceof Error ? error.message : String(error));
			}
		}
		return projected;
	}

	/**
	 * Dedup key is separate from `#lastDiscoveryWarnings` so a repeated modifier
	 * failure cannot mask a subsequent discovery failure for the same provider.
	 */
	#warnModelModifierFailure(provider: string, error: string): void {
		if (this.#lastModelModifierWarnings.get(provider) === error) return;
		this.#lastModelModifierWarnings.set(provider, error);
		logger.warn("extension model projection failed; serving unprojected catalog", { provider, error });
	}

	#composeUnprojectedStaticModels(providerFilter?: ReadonlySet<string>): Model<Api>[] {
		const select = <T extends { provider: string }>(models: readonly T[]): T[] =>
			providerFilter ? models.filter(model => providerFilter.has(model.provider)) : [...models];
		const cachedStandardModels = this.#getCachedStandardModels(providerFilter);
		let builtInModels = this.#applyHardcodedModelPolicies(
			this.#loadBuiltInModels(this.#providerOverrides, providerFilter),
		);
		if (this.#cachedAuthoritativeProviders.size > 0) {
			builtInModels = dropProviderModels(builtInModels, this.#cachedAuthoritativeProviders);
		}
		let resolvedDefaults = this.#mergeResolvedModels(
			this.#mergeResolvedModels(builtInModels, cachedStandardModels),
			select(this.#cachedDiscoverableModels),
		);
		if (this.#runtimeAuthoritativeProviders.size > 0) {
			resolvedDefaults = dropProviderModels(resolvedDefaults, this.#runtimeAuthoritativeProviders);
		}
		resolvedDefaults = this.#mergeResolvedModels(resolvedDefaults, select(this.#runtimeDiscoveredModels));
		const withConfigModels = this.#mergeCustomModels(resolvedDefaults, select(this.#customModelOverlays));
		const combined = this.#mergeCustomModels(withConfigModels, select(this.#runtimeModelOverlays));
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltVariants(combined), this.#modelOverrides);
		const withProviderGuardrails = this.#applyProviderGuardrailOverrides(withModelOverrides);
		return this.#applyLlamaCppModelFixups(this.#applyRuntimeProviderOverrides(withProviderGuardrails));
	}

	#composeStaticModels(providerFilter?: ReadonlySet<string>): Model<Api>[] {
		// A modifier is a whole-catalog transform. Build and project the full catalog
		// before narrowing a lazy lookup, matching getAll() followed by filtering.
		const projectFullCatalog = providerFilter !== undefined && this.#runtimeModelModifiers.size > 0;
		const unprojected = this.#composeUnprojectedStaticModels(projectFullCatalog ? undefined : providerFilter);
		const projected = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(unprojected));
		const selected = projectFullCatalog ? projected.filter(model => providerFilter.has(model.provider)) : projected;
		return this.#internStaticModels(selected);
	}

	#ensureFullSnapshot(): Model<Api>[] {
		if (!this.#hasFullSnapshot) {
			this.#unprojectedModels = this.#composeUnprojectedStaticModels();
			this.#models = this.#internStaticModels(
				this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels)),
			);
			this.#hasFullSnapshot = true;
			this.#providerLookupSnapshots.clear();
		}
		return this.#models;
	}

	/** Load built-in models, applying provider-level overrides only.
	 *  Per-model overrides are applied later by #applyModelOverrides. */
	#loadBuiltInModels(overrides: Map<string, ProviderOverride>, providerFilter?: ReadonlySet<string>): Model<Api>[] {
		return getBundledProviders().flatMap(provider => {
			if (providerFilter && !providerFilter.has(provider)) return [];
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			const providerOverride = overrides.get(provider);

			return models.map(m => {
				if (!providerOverride) return m;
				const withTransportOverride = this.#applyProviderTransportOverride(toModelSpec(m), providerOverride);
				return buildModel({
					...withTransportOverride,
					compat: mergeCompat(m.compatConfig, providerOverride.compat),
				} as ModelSpec<Api>);
			});
		});
	}

	#mergeResolvedModels(baseModels: Model<Api>[], replacementModels: Model<Api>[]): Model<Api>[] {
		return mergeByModelKey(baseModels, replacementModels, (existing, replacementModel) => {
			if (!existing) return replacementModel;
			const supportsTools = replacementModel.supportsTools ?? existing.supportsTools;
			return {
				...replacementModel,
				contextWindow: replacementModel.contextWindow ?? existing.contextWindow,
				maxTokens: replacementModel.maxTokens ?? existing.maxTokens,
				omitMaxOutputTokens: replacementModel.omitMaxOutputTokens ?? existing.omitMaxOutputTokens,
				...(supportsTools !== undefined ? { supportsTools } : {}),
			};
		});
	}

	/** Merge custom models with built-in, replacing by provider+id match */
	#mergeCustomModels(builtInModels: Model<Api>[], customModels: CustomModelOverlay[]): Model<Api>[] {
		return mergeByModelKey(builtInModels, customModels, (existingModel, customModel) => {
			if (!existingModel) return finalizeCustomModel(customModel, { useDefaults: true });
			// Same-id custom definitions replace bundled transport behavior, so the
			// patch is applied with the `replace` transport policy.
			return applyModelPatch(
				{
					...existingModel,
					id: customModel.id,
					provider: customModel.provider,
					api: customModel.api,
					baseUrl: customModel.baseUrl,
				},
				customModel,
				"replace",
			);
		});
	}

	#descriptorBaseUrl(providerId: string): string | undefined {
		return (
			this.#runtimeProviderOverrides.get(providerId)?.baseUrl ??
			this.#providerOverrides.get(providerId)?.baseUrl ??
			(this.#hasFullSnapshot ? this.getProviderBaseUrl(providerId) : undefined)
		);
	}

	#resolveStartupModelCacheProviderId(providerId: string): string {
		const baseUrl =
			this.#runtimeProviderOverrides.get(providerId)?.baseUrl ??
			this.#providerOverrides.get(providerId)?.baseUrl ??
			(this.#hasFullSnapshot ? this.getProviderBaseUrl(providerId) : undefined);
		return resolveModelCacheProviderId(providerId, { baseUrl });
	}

	#loadCachedStandardProviderModels(providerIds: readonly string[]): {
		modelsByProvider: Map<string, Model<Api>[]>;
		authoritativeFreshProviders: Set<string>;
	} {
		const modelsByProvider = new Map<string, Model<Api>[]>();
		const authoritativeFreshProviders = new Set<string>();
		for (const providerId of providerIds) {
			const cacheProviderId = this.#resolveStartupModelCacheProviderId(providerId);
			const cache = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			const sharedCatalogProvider = MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP[providerId] === true;
			const additiveSharedCatalogProvider = ADDITIVE_MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP[providerId] === true;
			if (!cache) {
				if (sharedCatalogProvider) {
					this.#providerDiscoveryStates.set(providerId, {
						provider: providerId,
						status: "idle",
						optional: false,
						stale: false,
						source: "bundled",
						models: [],
					});
				}
				continue;
			}
			if (cache.fresh && cache.authoritative) {
				authoritativeFreshProviders.add(providerId);
			}
			// The v10 model cache never persists request headers (#5780): restore
			// them from the bundled static catalog, and drop cached rows whose
			// headers cannot be rebuilt so the bundled fallback (which still
			// carries its headers) wins the startup merge instead of a cached
			// model with required transport headers missing.
			const omittedHeaderIds = new Set(cache.headerOmittedModelIds);
			const unrestorableHeaderIds = new Set(cache.unrestorableHeaderModelIds);
			const bundledModels =
				omittedHeaderIds.size > 0 || sharedCatalogProvider
					? (getBundledModels(providerId as Parameters<typeof getBundledModels>[0]) as Model<Api>[])
					: undefined;
			const bundledFingerprint = bundledModels
				? fingerprintStaticModels(bundledModels, sharedCatalogProvider && !additiveSharedCatalogProvider)
				: undefined;
			// A matching cache may contain provider-endpoint overrides. Strip
			// same-id rows only across a bundled-catalog upgrade, where the
			// additive shared catalog must not replace the new bundled metadata.
			const additiveCacheStaticMismatch =
				additiveSharedCatalogProvider &&
				bundledFingerprint !== undefined &&
				cache.staticFingerprint !== bundledFingerprint &&
				!cache.staticFingerprint.startsWith(`${bundledFingerprint}:drop:`);
			const bundledById = bundledModels
				? new Map(bundledModels.map(bundledModel => [bundledModel.id, bundledModel]))
				: undefined;
			const models: ModelSpec<Api>[] = [];
			for (const cachedModel of cache.models) {
				const spec = cachedModel.provider === providerId ? cachedModel : { ...cachedModel, provider: providerId };
				if (additiveCacheStaticMismatch && bundledById?.has(spec.id)) continue;
				if (!omittedHeaderIds.has(spec.id)) {
					models.push(spec);
					continue;
				}
				// Current unrestorable markers prove that neither same-id nor
				// request-model bundled headers matched the live model. Only markers
				// from the old id-only writer may recover through `requestModelId`.
				const unrestorable = unrestorableHeaderIds.has(spec.id);
				const bundledHeaders = (
					unrestorable
						? cache.legacyHeaderRestoreMarkers && spec.requestModelId
							? bundledById?.get(spec.requestModelId)
							: undefined
						: (bundledById?.get(spec.id) ??
							(spec.requestModelId ? bundledById?.get(spec.requestModelId) : undefined))
				)?.headers;
				if (!bundledHeaders) continue;
				models.push({ ...spec, headers: bundledHeaders });
			}
			const providerOverride = this.#providerOverrides.get(providerId);
			const withTransport = providerOverride
				? models.map(model => this.#applyProviderTransportOverride(model, providerOverride))
				: models;
			const withCompat = providerOverride?.compat
				? withTransport.map(model =>
						buildModel({
							...model,
							compat: mergeCompat(model.compat, providerOverride.compat),
						} as ModelSpec<Api>),
					)
				: withTransport.map(model => buildModel(model));
			const resolved = this.#applyProviderModelOverrides(providerId, withCompat);
			const cachedModels = this.#applyHardcodedModelPolicies(resolved);
			modelsByProvider.set(providerId, cachedModels);
			if (sharedCatalogProvider) {
				const cacheMatchesBundledFingerprint =
					bundledFingerprint !== undefined &&
					(cache.staticFingerprint === bundledFingerprint ||
						cache.staticFingerprint.startsWith(`${bundledFingerprint}:drop:`));
				const cachedSnapshotMatchesBundled =
					bundledFingerprint !== undefined &&
					fingerprintStaticModels(cache.models, !additiveSharedCatalogProvider) === bundledFingerprint;
				const cacheContributed = additiveSharedCatalogProvider
					? cachedModels.some(model => bundledById?.has(model.id) !== true)
					: !(cacheMatchesBundledFingerprint && cachedSnapshotMatchesBundled);
				const stale = !cache.fresh || !cache.authoritative;
				this.#providerDiscoveryStates.set(providerId, {
					provider: providerId,
					status: cacheContributed ? "cached" : stale ? "unavailable" : "idle",
					optional: false,
					stale,
					...(cacheContributed ? { fetchedAt: cache.updatedAt } : {}),
					source: cacheContributed ? "cache" : "bundled",
					models: cachedModels.map(model => model.id),
				});
			}
		}
		return { modelsByProvider, authoritativeFreshProviders };
	}

	/**
	 * Materialize only the cached provider slices needed by this composition.
	 * A full snapshot (`providerFilter` omitted) drains every pending provider in
	 * descriptor order; provider-scoped lookups leave unrelated JSON rows
	 * unparsed until their own first read.
	 */
	#getCachedStandardModels(providerFilter?: ReadonlySet<string>): Model<Api>[] {
		const providerIds = STARTUP_MODEL_CACHE_PROVIDER_IDS.filter(
			providerId =>
				this.#pendingStandardCacheProviders.has(providerId) &&
				(providerFilter === undefined || providerFilter.has(providerId)),
		);
		if (providerIds.length > 0) {
			for (const providerId of providerIds) this.#pendingStandardCacheProviders.delete(providerId);
			const loaded = logger.time("modelRegistry:loadCachedStandardModels", () =>
				this.#loadCachedStandardProviderModels(providerIds),
			);
			for (const [providerId, models] of loaded.modelsByProvider) {
				this.#cachedStandardModelsByProvider.set(providerId, models);
			}
			for (const providerId of loaded.authoritativeFreshProviders) {
				const models = loaded.modelsByProvider.get(providerId) ?? [];
				if (
					providersWithAuthoritativeProjectCatalog(models).has(providerId) ||
					AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS.has(providerId)
				) {
					this.#cachedAuthoritativeProviders.add(providerId);
				}
			}
		}

		const models: Model<Api>[] = [];
		for (const providerId of STARTUP_MODEL_CACHE_PROVIDER_IDS) {
			if (providerFilter && !providerFilter.has(providerId)) continue;
			const providerModels = this.#cachedStandardModelsByProvider.get(providerId);
			if (providerModels) models.push(...providerModels);
		}
		return models;
	}

	#configuredDiscoveryHeaderFallback(providerId: string): Record<string, string> | undefined {
		const override = this.#providerOverrides.get(providerId);
		if (override?.authHeader !== true || !override.apiKey) return undefined;
		const headers = mergeAuthHeaderSources([override.headers], override.authHeader, override.apiKey);
		return headers?.Authorization ? headers : undefined;
	}

	#loadCachedDiscoverableModels(): Model<Api>[] {
		const cachedModels: Model<Api>[] = [];
		for (const providerConfig of this.#discoverableProviders) {
			const cacheProviderId = this.#configuredDiscoveryCacheProviderId(providerConfig);
			const cache = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			if (!cache) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "idle",
					optional: providerConfig.optional ?? false,
					stale: false,
					models: [],
				});
				continue;
			}
			const configStale = this.#isDiscoveryCacheOlderThanModelsConfig(cache.updatedAt);
			// Cached rows never persist headers (#5780). A pinned models.yml
			// authHeader is re-derived from the current config; this also repairs
			// rows written before the discovery manager knew that fallback, when
			// every header-bearing model was marked unrestorable.
			const restorableHeaderFallback = this.#configuredDiscoveryHeaderFallback(providerConfig.provider);
			const omittedHeaderIds = new Set(cache.headerOmittedModelIds);
			const hasUnrestoredHeaders = omittedHeaderIds.size > 0 && !restorableHeaderFallback;
			const usableCacheModels =
				omittedHeaderIds.size === 0
					? cache.models
					: restorableHeaderFallback
						? cache.models.map(model =>
								omittedHeaderIds.has(model.id) ? { ...model, headers: { ...restorableHeaderFallback } } : model,
							)
						: cache.models.filter(model => !omittedHeaderIds.has(model.id));
			if (restorableHeaderFallback && cache.unrestorableHeaderModelIds.length > 0) {
				writeModelCache(
					cacheProviderId,
					cache.updatedAt,
					usableCacheModels.map(model => buildModel(model)),
					cache.authoritative,
					cache.staticFingerprint,
					this.#cacheDbPath,
					[],
					restorableHeaderFallback,
				);
			}
			const models = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(
						providerConfig.compat,
						usableCacheModels.map(model => buildModel(model)),
					),
				),
			);
			cachedModels.push(...models);
			this.#providerDiscoveryStates.set(providerConfig.provider, {
				provider: providerConfig.provider,
				status: "cached",
				optional: providerConfig.optional ?? false,
				stale:
					providerConfig.discovery.type === "llama.cpp" ||
					!cache.fresh ||
					!cache.authoritative ||
					configStale ||
					hasUnrestoredHeaders,
				fetchedAt: cache.updatedAt,
				models: models.map(model => model.id),
			});
		}
		return cachedModels;
	}

	#applyProviderCompat(compat: ModelSpec<Api>["compat"] | undefined, models: Model<Api>[]): Model<Api>[] {
		if (!compat) return models;
		return models.map(model =>
			buildModel({ ...model, compat: mergeCompat(model.compatConfig, compat) } as ModelSpec<Api>),
		);
	}

	#normalizeDiscoverableModels(providerConfig: DiscoveryProviderConfig, models: Model<Api>[]): Model<Api>[] {
		const withDecoderMetadata =
			providerConfig.discovery.type === "ollama" ||
			providerConfig.discovery.type === "llama.cpp" ||
			providerConfig.discovery.type === "lm-studio"
				? models.map(model =>
						buildModel({ ...model, imageInputDecoder: "stb", compat: model.compatConfig } as ModelSpec<Api>),
					)
				: models;

		const withRemoteCompaction = providerConfig.remoteCompaction
			? withDecoderMetadata.map(model =>
					buildModel({
						...model,
						remoteCompaction: mergeProviderRemoteCompactionConfig(
							model.remoteCompaction,
							providerConfig.remoteCompaction,
						),
						compat: model.compatConfig,
					} as ModelSpec<Api>),
				)
			: withDecoderMetadata;

		if (providerConfig.provider !== "ollama" || providerConfig.api !== "openai-responses") {
			return withRemoteCompaction;
		}

		const contextLengthOverride = getOllamaContextLengthOverride();
		return withRemoteCompaction.map(model => {
			const normalized =
				model.api === "openai-completions"
					? buildModel({
							...model,
							api: "openai-responses" as const,
							compat: model.compatConfig,
						} as ModelSpec<Api>)
					: model;
			if (contextLengthOverride === undefined) {
				return normalized;
			}
			return {
				...normalized,
				contextWindow: contextLengthOverride,
				maxTokens: Math.min(contextLengthOverride, DISCOVERY_DEFAULT_MAX_TOKENS),
			};
		});
	}

	#addImplicitDiscoverableProviders(configuredProviders: Set<string>): void {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const hasOllamaEndpointOverride = Boolean(Bun.env.OLLAMA_BASE_URL?.trim() || Bun.env.OLLAMA_HOST?.trim());
		if (!configuredProviders.has("ollama") && !disabledProviders.has("ollama")) {
			this.#discoverableProviders.push({
				provider: "ollama",
				api: "openai-responses",
				baseUrl: getImplicitOllamaBaseUrl(),
				discovery: { type: "ollama" },
				optional: !hasOllamaEndpointOverride,
			});
			this.#keylessProviders.add("ollama");
		}
		if (!configuredProviders.has("llama.cpp") && !disabledProviders.has("llama.cpp")) {
			this.#discoverableProviders.push({
				provider: "llama.cpp",
				api: "openai-responses",
				baseUrl: Bun.env.LLAMA_CPP_BASE_URL || "http://127.0.0.1:8080",
				discovery: { type: "llama.cpp" },
				optional: !Bun.env.LLAMA_CPP_BASE_URL,
			});
			// Only mark as keyless if no API key is configured
			if (!this.authStorage.hasAuth("llama.cpp")) {
				this.#keylessProviders.add("llama.cpp");
			}
		}
		if (!configuredProviders.has("lm-studio") && !disabledProviders.has("lm-studio")) {
			this.#discoverableProviders.push({
				provider: "lm-studio",
				api: "openai-completions",
				baseUrl: Bun.env.LM_STUDIO_BASE_URL || "http://127.0.0.1:1234/v1",
				discovery: { type: "lm-studio" },
				optional: !Bun.env.LM_STUDIO_BASE_URL,
			});
			this.#keylessProviders.add("lm-studio");
		}
	}

	#loadCustomModels(): CustomModelsResult {
		// Gateway mode: serve bundled + broker-discovered catalog metadata only.
		// Local models.yml provider overrides (baseUrl/apiKey/headers/transport),
		// custom models, custom discovery, and config API keys are all client-side
		// routing that MUST NOT reach a broker-backed gateway — applying them would
		// send broker bearers to a configured endpoint, install config keys that
		// shadow broker credentials (bypassing account pooling/refresh/accounting),
		// or route a pi-native gateway back into itself.
		if (this.#ignoreLocalModelConfig) {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				found: false,
			};
		}
		const { value, error, status } = this.#modelsConfigFile.tryLoad();

		if (status === "error") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				error,
				found: true,
			};
		} else if (status === "not-found") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				found: false,
			};
		}

		const overrides = new Map<string, ProviderOverride>();
		const allModelOverrides = new Map<string, Map<string, ModelOverride>>();
		const keylessProviders = new Set<string>();
		const discoverableProviders: DiscoveryProviderConfig[] = [];
		const providerEntries = Object.entries(value.providers ?? {});
		const configuredProviders = new Set(Object.keys(value.providers ?? {}));
		for (const [providerName, providerConfig] of providerEntries) {
			const resolvedProviderHeaders = resolveConfigHeaders(providerConfig.headers);
			const commandConfigs = new Set<string>();
			this.#collectCommandConfigValues(commandConfigs, providerConfig.apiKey, providerConfig.headers);
			for (const modelDef of providerConfig.models ?? []) {
				this.#collectCommandConfigValues(commandConfigs, undefined, modelDef.headers);
			}
			// Always set overrides when baseUrl/headers/apiKey/authHeader/compat/disableStrictTools/guardrail*/transport are present
			if (
				providerConfig.baseUrl ||
				resolvedProviderHeaders ||
				providerConfig.apiKey ||
				providerConfig.authHeader !== undefined ||
				providerConfig.compat ||
				providerConfig.disableStrictTools ||
				providerConfig.guardrailIdentifier ||
				providerConfig.remoteCompaction ||
				providerConfig.transport
			) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				overrides.set(providerName, {
					baseUrl:
						providerConfig.discovery?.type === "litellm"
							? normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl)
							: providerConfig.discovery?.type === "openai-models-list" &&
								  providerConfig.discovery.injectV1 === false
								? normalizeBareDiscoveryBaseUrl(providerConfig.baseUrl)
								: providerConfig.baseUrl,
					headers: providerConfig.headers,
					apiKey: providerConfig.apiKey,
					authHeader: providerConfig.authHeader,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					remoteCompaction: providerConfig.remoteCompaction,
					transport: providerConfig.transport,
					guardrailIdentifier: providerConfig.guardrailIdentifier,
					guardrailVersion: providerConfig.guardrailVersion,
					guardrailTrace: providerConfig.guardrailTrace,
				});
			}

			const authMode = (providerConfig.auth ?? "apiKey") as ProviderAuthMode;
			if (authMode === "none") {
				keylessProviders.add(providerName);
			}

			if (providerConfig.discovery && (providerConfig.api || providerConfig.discovery.type === "proxy")) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				discoverableProviders.push({
					provider: providerName,
					// Proxy discovery derives per-model api from /v1/models's
					// supported_endpoint_types; the provider-level api is only a
					// fallback for entries that don't advertise one.
					api: (providerConfig.api ?? "openai-completions") as Api,
					baseUrl: providerConfig.baseUrl,
					headers: resolvedProviderHeaders,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					remoteCompaction: providerConfig.remoteCompaction,
					discovery: providerConfig.discovery,
					optional: false,
				});
			}

			// Store API key for fallback resolver AND register as config override
			// so it wins over OAuth tokens from the broker — when the user pins a
			// bearer in models.yml (e.g. for an auth-gateway baseUrl), that bearer
			// must authenticate the outbound request.
			if (providerConfig.apiKey) {
				this.#installProviderApiKey(providerName, providerConfig.apiKey);
			}

			// Parse per-model overrides. Header values are kept raw (`!cmd` intact)
			// so the downstream live proxy re-resolves them per request, letting a
			// 401 refresh reach header-carried credentials (#9760).
			if (providerConfig.modelOverrides) {
				const perModel = new Map<string, ModelOverride>();
				for (const [modelId, override] of Object.entries(providerConfig.modelOverrides)) {
					this.#collectCommandConfigValues(commandConfigs, undefined, override.headers);
					perModel.set(modelId, override);
				}
				allModelOverrides.set(providerName, perModel);
			}
			if (commandConfigs.size > 0) this.#commandConfigsByProvider.set(providerName, commandConfigs);
		}

		return {
			models: this.#parseModels(value),
			overrides,
			modelOverrides: allModelOverrides,
			keylessProviders,
			discoverableProviders,
			configuredProviders,
			found: true,
		};
	}

	async #refreshRuntimeDiscoveries(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<void> {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const selectedDiscoverableProviders = (
			providerFilter
				? this.#discoverableProviders.filter(provider => providerFilter.has(provider.provider))
				: this.#discoverableProviders
		).filter(provider => !disabledProviders.has(provider.provider));
		const configuredDiscoveriesPromise =
			selectedDiscoverableProviders.length === 0
				? Promise.resolve<{ provider: DiscoveryProviderConfig; models: Model<Api>[] }[]>([])
				: Promise.all(
						selectedDiscoverableProviders.map(async provider => ({
							provider,
							models: await this.#discoverProviderModelsCoalesced(provider, strategy),
						})),
					);
		const [configuredDiscoveryResults, builtInDiscovery] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter),
		]);
		this.#captureCatalogMetrics(builtInDiscovery.models, providerFilter === undefined);
		const currentDiscoverableProviders = new Set(this.#discoverableProviders);
		const configuredDiscovered = configuredDiscoveryResults
			.filter(result => currentDiscoverableProviders.has(result.provider))
			.flatMap(result => result.models);
		const discovered = [...configuredDiscovered, ...builtInDiscovery.models];
		if (discovered.length === 0 && builtInDiscovery.authoritativeProviders.size === 0) {
			return;
		}
		const touchedProviders = new Set(discovered.map(model => model.provider));
		for (const provider of builtInDiscovery.authoritativeProviders) touchedProviders.add(provider);
		const existingModels = this.#hasFullSnapshot
			? this.#unprojectedModels
			: this.#composeUnprojectedStaticModels(touchedProviders);
		const discoveredModels = this.#applyHardcodedModelPolicies(
			discovered.map(model =>
				mergeDiscoveredModel(
					model,
					resolveProviderModelReference(model.provider, model.id, existingModels),
					this.#providerOverrides.get(model.provider),
				),
			),
		);
		const authoritativeProviders = providersWithAuthoritativeProjectCatalog(discoveredModels);
		for (const provider of builtInDiscovery.authoritativeProviders) {
			authoritativeProviders.add(provider);
		}

		this.#runtimeDiscoveredModels = this.#runtimeDiscoveredModels.filter(
			model => !touchedProviders.has(model.provider),
		);
		this.#runtimeDiscoveredModels.push(...discoveredModels);
		for (const provider of touchedProviders) {
			if (authoritativeProviders.has(provider)) {
				this.#runtimeAuthoritativeProviders.add(provider);
			} else {
				this.#runtimeAuthoritativeProviders.delete(provider);
			}
			this.#invalidateProviderModelCache(provider);
		}
		if (!this.#hasFullSnapshot) return;

		const baseModels =
			authoritativeProviders.size > 0
				? dropProviderModels(this.#unprojectedModels, authoritativeProviders)
				: this.#unprojectedModels;
		const resolved = this.#mergeResolvedModels(baseModels, discoveredModels);
		const withConfigModels = this.#mergeCustomModels(resolved, this.#customModelOverlays);
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltVariants(combined), this.#modelOverrides);
		const withProviderGuardrails = this.#applyProviderGuardrailOverrides(withModelOverrides);
		this.#unprojectedModels = this.#applyLlamaCppModelFixups(
			this.#applyRuntimeProviderOverrides(withProviderGuardrails),
		);
		this.#models = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
	}

	/**
	 * Share a configured provider's discovery request between concurrent full
	 * and provider-scoped refreshes using the same cache/network strategy.
	 */
	#discoverProviderModelsCoalesced(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
	): Promise<Model<Api>[]> {
		let providerInFlight = this.#configuredDiscoveryInFlight.get(providerConfig);
		const inFlight = providerInFlight?.get(strategy);
		if (inFlight) return inFlight;

		providerInFlight ??= new Map();
		const discovery = this.#discoverProviderModels(providerConfig, strategy).finally(() => {
			if (providerInFlight.get(strategy) === discovery) {
				providerInFlight.delete(strategy);
				if (providerInFlight.size === 0) {
					this.#configuredDiscoveryInFlight.delete(providerConfig);
				}
			}
		});
		providerInFlight.set(strategy, discovery);
		this.#configuredDiscoveryInFlight.set(providerConfig, providerInFlight);
		return discovery;
	}

	#configuredDiscoveryCacheProviderId(providerConfig: DiscoveryProviderConfig): string {
		if (providerConfig.discovery.type === "ollama") {
			return resolveOllamaModelCacheProviderId(providerConfig.provider, providerConfig.baseUrl);
		}
		if (providerConfig.discovery.type === "openai-models-list") {
			// context-v3 invalidates rows cached before server-advertised input
			// modalities were parsed from `/v1/models`; warm v2 rows pinned
			// vision-capable ids at `input: ["text"]` until a forced refresh.
			// `injectV1: false` additionally splits off its own namespace: rows
			// cached from the `/v1`-injected URL can hold a different (smaller)
			// model set and must never satisfy a bare provider's cache read.
			return providerConfig.discovery.injectV1 === false
				? `${providerConfig.provider}:openai-models-list-bare-context-v3`
				: `${providerConfig.provider}:openai-models-list-context-v3`;
		}
		if (providerConfig.discovery.type === "litellm") {
			// rich-v4 invalidates rows whose `compatConfig` retained a colliding
			// bundled model's provider-specific transport (e.g. Fireworks
			// `wireModelIdMode`) before that leak was fixed (issue #9938); keep in
			// lockstep with the catalog package's `litellm:rich-vN` namespace
			// whenever LiteLLM mapping behavior changes.
			return `${providerConfig.provider}:litellm-rich-v4`;
		}
		return providerConfig.provider;
	}

	#isDiscoveryCacheOlderThanModelsConfig(cacheUpdatedAt: number): boolean {
		const configMtime = this.#modelsConfigFile.getMtimeMs();
		return configMtime !== null && cacheUpdatedAt < Math.floor(configMtime);
	}

	async #discoverProviderModels(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
	): Promise<Model<Api>[]> {
		const cacheProviderId = this.#configuredDiscoveryCacheProviderId(providerConfig);
		const cached = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
		const cacheOlderThanConfig = cached !== null && this.#isDiscoveryCacheOlderThanModelsConfig(cached.updatedAt);
		const bypassFreshCache = providerConfig.discovery.type === "llama.cpp" && strategy === "online-if-uncached";
		const effectiveStrategy =
			strategy === "online-if-uncached" && (cacheOlderThanConfig || bypassFreshCache) ? "online" : strategy;
		const requiresAuth = !this.#keylessProviders.has(providerConfig.provider);
		if (requiresAuth) {
			const apiKey = await this.#peekApiKeyForProvider(providerConfig.provider);
			if (!isAuthenticated(apiKey)) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "unauthenticated",
					optional: providerConfig.optional ?? false,
					stale: cached !== null,
					fetchedAt: cached?.updatedAt,
					models: cached?.models.map(model => model.id) ?? [],
				});
				this.#lastDiscoveryWarnings.delete(providerConfig.provider);
				return cached
					? this.#normalizeDiscoverableModels(
							providerConfig,
							cached.models.map(model => buildModel(model)),
						)
					: [];
			}
		}

		const providerId = providerConfig.provider;
		let discoveryError: string | undefined;
		const fetchDynamicModels = async (): Promise<readonly ModelSpec<Api>[] | null> => {
			try {
				const models = this.#applyProviderModelOverrides(
					providerId,
					await discoverModelsByProviderType(providerConfig, this.#discoveryContext()),
				);
				this.#lastDiscoveryWarnings.delete(providerId);
				return models.map(toModelSpec);
			} catch (error) {
				discoveryError = error instanceof Error ? error.message : String(error);
				return null;
			}
		};

		const manager = createModelManager<Api>({
			providerId,
			staticModels: [],
			cacheDbPath: this.#cacheDbPath,
			cacheProviderId,
			cacheTtlMs: 24 * 60 * 60 * 1000,
			fetchDynamicModels,
			restorableHeaderFallback: this.#configuredDiscoveryHeaderFallback(providerId),
		});
		const result = await manager.refresh(effectiveStrategy);
		const status = discoveryError
			? result.models.length > 0
				? "cached"
				: "unavailable"
			: effectiveStrategy === "offline"
				? cached
					? "cached"
					: "idle"
				: result.models.length > 0
					? "ok"
					: "empty";
		this.#providerDiscoveryStates.set(providerId, {
			provider: providerId,
			status,
			optional: providerConfig.optional ?? false,
			stale: result.stale || status === "cached" || ((cacheOlderThanConfig || bypassFreshCache) && status !== "ok"),
			fetchedAt: discoveryError ? cached?.updatedAt : Date.now(),
			models: result.models.map(model => model.id),
			error: discoveryError,
		});
		if (discoveryError) {
			this.#warnProviderDiscoveryFailure(providerConfig, discoveryError);
		}
		return this.#applyProviderModelOverrides(
			providerId,
			this.#normalizeDiscoverableModels(
				providerConfig,
				this.#applyProviderCompat(providerConfig.compat, result.models),
			),
		);
	}

	#discoveryContext(): DiscoveryContext {
		return {
			fetch: this.#fetch,
			getBearerApiKeyResolver: async provider => {
				const apiKey = await this.getApiKeyForProvider(provider);
				if (!isDiscoveryBearerApiKey(apiKey)) {
					return undefined;
				}
				return this.resolver(provider);
			},
		};
	}

	#nonResolvingDiscoveryContext(): DiscoveryContext {
		return {
			fetch: this.#fetch,
			getBearerApiKeyResolver: async () => undefined,
		};
	}

	#warnProviderDiscoveryFailure(providerConfig: DiscoveryProviderConfig, error: string): void {
		const previous = this.#lastDiscoveryWarnings.get(providerConfig.provider);
		if (previous === error) {
			return;
		}
		this.#lastDiscoveryWarnings.set(providerConfig.provider, error);
		logger.warn("model discovery failed for provider", {
			provider: providerConfig.provider,
			url: providerConfig.baseUrl,
			error,
		});
	}

	async #discoverBuiltInProviderModels(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<BuiltInDiscoveryResult> {
		// Skip providers already handled by configured discovery (e.g. user-configured ollama with discovery.type)
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(p => p.provider));
		const managerOptions = await this.#collectBuiltInModelManagerOptions(
			strategy,
			providerFilter,
			configuredDiscoveryProviders,
		);
		if (managerOptions.length === 0) {
			return { models: [], authoritativeProviders: new Set() };
		}
		const discoveries = await Promise.all(
			managerOptions.map(options => this.#discoverWithModelManager(options, strategy)),
		);
		const authoritativeProviders = new Set<string>();
		const models: Model<Api>[] = [];
		for (const discovery of discoveries) {
			models.push(...discovery.models);
			for (const provider of discovery.authoritativeProviders) {
				authoritativeProviders.add(provider);
			}
		}
		return { models, authoritativeProviders };
	}

	async #resolveBuiltInDiscoveryApiKey(
		providerId: string,
		strategy: ModelRefreshStrategy,
		cacheProviderId: string,
		authoritative: boolean,
	): Promise<string | undefined> {
		const peekedKey = await this.#peekApiKeyForProvider(providerId);
		if (isAuthenticated(peekedKey) || strategy === "offline") {
			return peekedKey;
		}
		const oauthCredentials = getOAuthCredentialsForProvider(this.authStorage, providerId);
		if (oauthCredentials.length === 0) {
			return peekedKey;
		}
		// Authoritative providers prune bundled models only when their manager is
		// actually constructed, which needs an authenticated key. A fresh cache does
		// not let us skip the refresh here: with an expired OAuth token peekedKey is
		// undefined, the manager is never added, and stale bundled models survive the
		// full cache TTL. So only take the no-refresh shortcut for non-authoritative
		// providers, whose bundled models stay visible regardless.
		if (strategy === "online-if-uncached" && !authoritative) {
			// Mirror shouldFetchRemoteSources: built-in managers use the catalog's
			// default TTL, so only refresh when the manager will actually fetch.
			const cache = readModelCache<Api>(
				cacheProviderId,
				BUILT_IN_DISCOVERY_CACHE_TTL_MS,
				Date.now,
				this.#cacheDbPath,
			);
			const cacheAgeMs = cache ? Date.now() - cache.updatedAt : Number.POSITIVE_INFINITY;
			if (cache?.fresh && (cache.authoritative || cacheAgeMs < BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS)) {
				return peekedKey;
			}
		}
		try {
			return await this.getApiKeyForProvider(providerId);
		} catch (error) {
			logger.debug("OAuth refresh failed during model discovery preflight", {
				provider: providerId,
				error: error instanceof Error ? error.message : String(error),
			});
			return peekedKey;
		}
	}

	/**
	 * Resolve the GCP project id for Gemini CLI quota discovery from the stored
	 * OAuth credential matched to the token in use. Used only as a fallback for
	 * the discovery fast path, where `peekApiKey` returns the bare access token
	 * (stripping the structured identity); matching strictly by `access` avoids
	 * attaching an unrelated account's project. Workspace/Standard accounts
	 * require the id because project-less `loadCodeAssist` cannot resolve one.
	 */
	#resolveGeminiCliDiscoveryProjectId(oauthToken: string): string | undefined {
		const credentials = getOAuthCredentialsForProvider(this.authStorage, "google-gemini-cli");
		const projectId = credentials.find(credential => credential.access === oauthToken)?.projectId?.trim();
		return projectId ? projectId : undefined;
	}

	async #collectBuiltInModelManagerOptions(
		strategy: ModelRefreshStrategy,
		providerFilter: ReadonlySet<string> | undefined,
		configuredDiscoveryProviders: ReadonlySet<string>,
	): Promise<ModelManagerOptions<Api>[]> {
		const specialProviderDescriptors: Array<{
			providerId: string;
			authoritative: boolean;
			resolveKey: (value: string | undefined) => string | undefined;
			createOptions: (key: string, raw: string | undefined) => ModelManagerOptions<Api>;
		}> = [
			{
				providerId: "google-antigravity",
				authoritative: false,
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleAntigravityModelManagerOptions({
						oauthToken,
						endpoint: this.#descriptorBaseUrl("google-antigravity"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "google-gemini-cli",
				authoritative: false,
				resolveKey: extractGoogleOAuthToken,
				createOptions: (oauthToken, raw) =>
					googleGeminiCliModelManagerOptions({
						oauthToken,
						projectId: extractGoogleOAuthProjectId(raw) ?? this.#resolveGeminiCliDiscoveryProjectId(oauthToken),
						endpoint: this.#descriptorBaseUrl("google-gemini-cli"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "openai-codex",
				authoritative: true,
				resolveKey: value => value,
				createOptions: accessToken =>
					openaiCodexModelManagerOptions({
						resolveAccounts: () => resolveCodexDiscoveryAccounts(this.authStorage, accessToken),
						fetch: this.#fetch,
					}),
			},
		];
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const standardProviderDescriptors = PROVIDER_DESCRIPTORS.filter(descriptor => {
			if (disabledProviders.has(descriptor.providerId)) return false;
			if (configuredDiscoveryProviders.has(descriptor.providerId)) return false;
			if (this.#runtimeModelManagers.has(descriptor.providerId)) return false;
			return providerFilter ? providerFilter.has(descriptor.providerId) : true;
		});
		const enabledSpecialProviderDescriptors = specialProviderDescriptors.filter(descriptor => {
			if (disabledProviders.has(descriptor.providerId)) return false;
			if (configuredDiscoveryProviders.has(descriptor.providerId)) return false;
			return providerFilter ? providerFilter.has(descriptor.providerId) : true;
		});
		const standardProviderKeys = await Promise.all(
			standardProviderDescriptors.map(descriptor => {
				const cacheProviderId = this.#resolveStartupModelCacheProviderId(descriptor.providerId);
				return this.#resolveBuiltInDiscoveryApiKey(
					descriptor.providerId,
					strategy,
					cacheProviderId,
					descriptor.dynamicModelsAuthoritative ?? false,
				);
			}),
		);
		const specialKeys = await Promise.all(
			enabledSpecialProviderDescriptors.map(descriptor =>
				this.#resolveBuiltInDiscoveryApiKey(
					descriptor.providerId,
					strategy,
					descriptor.providerId,
					descriptor.authoritative,
				),
			),
		);
		const options: ModelManagerOptions<Api>[] = [];
		for (let i = 0; i < standardProviderDescriptors.length; i++) {
			const descriptor = standardProviderDescriptors[i];
			const apiKey = standardProviderKeys[i];
			const hasExplicitVllmConfig =
				descriptor.providerId === "vllm" &&
				(this.#runtimeProviderOverrides.has(descriptor.providerId) ||
					this.#providerOverrides.has(descriptor.providerId) ||
					this.#keylessProviders.has(descriptor.providerId));
			const supportsSharedCatalog = MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP[descriptor.providerId] === true;
			const canUseSharedCatalogWithoutAuth = supportsSharedCatalog && !descriptor.dynamicModelsAuthoritative;
			if (
				isAuthenticated(apiKey) ||
				descriptor.allowUnauthenticated ||
				hasExplicitVllmConfig ||
				canUseSharedCatalogWithoutAuth
			) {
				const discoveryConfig = {
					apiKey: isDiscoveryBearerApiKey(apiKey) ? apiKey : undefined,
					baseUrl: this.#descriptorBaseUrl(descriptor.providerId),
					fetch: this.#fetch,
				};
				const preparedConfig =
					getProviderDefinition(descriptor.providerId)?.prepareModelDiscovery?.(discoveryConfig) ??
					discoveryConfig;
				const managerOptions = descriptor.createModelManagerOptions(preparedConfig);
				const modelsDev = managerOptions.modelsDev
					? { ...managerOptions.modelsDev, additiveOnly: true }
					: modelsDevCatalogFallback(descriptor.providerId, this.#fetch);
				options.push(modelsDev ? { ...managerOptions, modelsDev } : managerOptions);
			}
		}

		for (let i = 0; i < enabledSpecialProviderDescriptors.length; i++) {
			const descriptor = enabledSpecialProviderDescriptors[i];
			const key = descriptor.resolveKey(specialKeys[i]);
			if (!isAuthenticated(key)) {
				continue;
			}
			options.push(descriptor.createOptions(key, specialKeys[i]));
		}

		// Catalog-only providers have no endpoint manager. Give their bundled
		// slices the same shared remote layer without requiring credentials.
		const bundledProviderIds: Record<string, true> = Object.create(null);
		for (const providerId of getBundledProviders()) bundledProviderIds[providerId] = true;
		for (const providerId of MODELS_DEV_CATALOG_PROVIDER_IDS) {
			if (BUILT_IN_MODEL_MANAGER_PROVIDER_IDS[providerId] === true) continue;
			if (bundledProviderIds[providerId] !== true) continue;
			if (disabledProviders.has(providerId) || configuredDiscoveryProviders.has(providerId)) continue;
			if (providerFilter && !providerFilter.has(providerId)) continue;
			if (this.#runtimeModelManagers.has(providerId)) continue;
			const modelsDev = modelsDevCatalogFallback(providerId, this.#fetch);
			if (!modelsDev) continue;
			options.push({
				providerId,
				cacheProviderId: resolveModelCacheProviderId(providerId, {
					baseUrl: this.#descriptorBaseUrl(providerId),
				}),
				modelsDev,
			});
		}

		// Append runtime model managers registered by extensions via fetchDynamicModels.
		for (const { options: managerOpts } of this.#runtimeModelManagers.values()) {
			if (
				!configuredDiscoveryProviders.has(managerOpts.providerId) &&
				(!providerFilter || providerFilter.has(managerOpts.providerId))
			) {
				options.push(managerOpts);
			}
		}
		return options;
	}

	async #discoverWithModelManager(
		options: ModelManagerOptions<Api>,
		strategy: ModelRefreshStrategy,
	): Promise<BuiltInDiscoveryResult> {
		try {
			const manager = createModelManager({ ...options, cacheDbPath: this.#cacheDbPath });
			const result = await withModelDiscoveryTimeout(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS, () =>
				manager.refresh(strategy),
			);
			const models = result.models.map(model =>
				model.provider === options.providerId ? model : { ...model, provider: options.providerId },
			);
			if (options.modelsDev) {
				const status =
					result.source === "cache"
						? "cached"
						: result.source === "bundled" && result.stale
							? "unavailable"
							: result.source === "bundled"
								? "idle"
								: result.models.length > 0
									? "ok"
									: "empty";
				this.#providerDiscoveryStates.set(options.providerId, {
					provider: options.providerId,
					status,
					optional: false,
					stale: result.stale,
					fetchedAt: result.updatedAt,
					source: result.source,
					models: models.map(model => model.id),
				});
			}
			const authoritativeProviders = new Set<string>();
			if (options.dynamicModelsAuthoritative && !result.stale) {
				authoritativeProviders.add(options.providerId);
			}
			return { models, authoritativeProviders };
		} catch (error) {
			logger.warn("model discovery failed for provider", {
				provider: options.providerId,
				error: error instanceof Error ? error.message : String(error),
			});
			return { models: [], authoritativeProviders: new Set() };
		}
	}

	#applyProviderModelOverrides(provider: string, models: Model<Api>[]): Model<Api>[] {
		const overrides = this.#modelOverrides.get(provider);
		if (!overrides || overrides.size === 0) return models;
		let liveIds: Set<string> | null = null;
		const hasLiveModel = (_provider: string, id: string) => {
			liveIds ??= new Set(models.map(m => m.id));
			return liveIds.has(id);
		};
		return models.map(model => {
			const override = resolveModelOverrideWithAliases(overrides, model, hasLiveModel);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}

	// #applyLlamaCppModelFixups is the outermost transform for llama.cpp-provider
	// models, after discovery merges, cache fallbacks, and provider/transport
	// overrides have run. It applies Qwen-specific fixes (api, reasoning, compat)
	// and ensures all non-transport models have the `/v1` prefix in their baseUrl,
	// even when a configured override or stale cache row would strip it.
	#applyLlamaCppModelFixups(models: Model<Api>[]): Model<Api>[] {
		const llamaCppProviders = new Set<string>();
		for (const provider of this.#discoverableProviders) {
			if (provider.discovery.type === "llama.cpp") llamaCppProviders.add(provider.provider);
		}
		if (llamaCppProviders.size === 0) return models;
		return models.map(model => {
			if (!llamaCppProviders.has(model.provider)) return model;
			const withFixups = applyLlamaCppQwenThinking(model);
			if (!withFixups.transport && !withFixups.baseUrl.endsWith("/v1")) {
				return buildModel({
					...withFixups,
					baseUrl: ensureLlamaCppV1BaseUrl(normalizeLlamaCppBaseUrl(withFixups.baseUrl)),
				});
			}
			return withFixups;
		});
	}

	#mergeProviderOverride(baseOverride: ProviderOverride | undefined, override: ProviderOverride): ProviderOverride {
		return {
			baseUrl: override.baseUrl ?? baseOverride?.baseUrl,
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			authHeader: override.authHeader ?? baseOverride?.authHeader,
			headers: override.headers
				? createLiveConfigHeaders([baseOverride?.headers, override.headers])
				: baseOverride?.headers,
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
			remoteCompaction: mergeRemoteCompactionConfig(baseOverride?.remoteCompaction, override.remoteCompaction),
			transport: override.transport ?? baseOverride?.transport,
		};
	}
	#applyProviderTransportOverride<
		T extends { baseUrl?: string; headers?: Record<string, string>; remoteCompaction?: RemoteCompactionConfig<Api> },
	>(
		entry: T,
		override: Pick<
			ProviderOverride,
			"baseUrl" | "headers" | "authHeader" | "apiKey" | "remoteCompaction" | "transport"
		>,
	): T {
		const headers = mergeAuthHeaderSources(
			override.headers ? [entry.headers, override.headers] : [entry.headers],
			override.authHeader,
			override.apiKey,
		);
		return {
			...entry,
			baseUrl: override.baseUrl ?? entry.baseUrl,
			headers,
			// Preserve the model's existing transport when the override omits one;
			// providers without a `transport` field keep the default per-API dispatch.
			...(override.transport !== undefined ? { transport: override.transport } : {}),
			remoteCompaction: mergeProviderRemoteCompactionConfig(entry.remoteCompaction, override.remoteCompaction),
		};
	}
	#applyProviderTransportOverrideToModel(
		model: Model<Api>,
		override: Pick<
			ProviderOverride,
			"baseUrl" | "headers" | "authHeader" | "apiKey" | "remoteCompaction" | "transport"
		>,
	): Model<Api> {
		return buildModel(this.#applyProviderTransportOverride(toModelSpec(model), override));
	}

	#applyProviderGuardrailOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#providerOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#providerOverrides.get(model.provider);
			if (!override) return model;
			const guardrailFields = guardrailOverrideFields(override);
			if (
				guardrailFields.guardrailIdentifier === undefined &&
				guardrailFields.guardrailVersion === undefined &&
				guardrailFields.guardrailTrace === undefined
			) {
				return model;
			}
			return buildModel({ ...toModelSpec(model), ...guardrailFields } as ModelSpec<Api>);
		});
	}

	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			return this.#applyProviderTransportOverrideToModel(model, override);
		});
	}
	#resolveLiveModelOverride(model: Model<Api>): ModelOverride | undefined {
		const providerOverrides = this.#modelOverrides.get(model.provider);
		if (!providerOverrides) return undefined;
		return resolveModelOverrideWithAliases(
			providerOverrides,
			model,
			(provider, id) => this.find(provider, id) !== undefined,
		);
	}

	#resolveLiveCustomModelOverlay(model: Model<Api>): CustomModelOverlay | undefined {
		return (
			this.#customModelOverlays.find(overlay => overlay.provider === model.provider && overlay.id === model.id) ??
			this.#runtimeModelOverlays.find(overlay => overlay.provider === model.provider && overlay.id === model.id)
		);
	}

	#applyModelOverrides(models: Model<Api>[], overrides: Map<string, Map<string, ModelOverride>>): Model<Api>[] {
		if (overrides.size === 0) return models;
		let liveKeys: Set<string> | null = null;
		const hasLiveModel = (provider: string, id: string) => {
			liveKeys ??= new Set(models.map(m => `${m.provider}\u0000${m.id}`));
			return liveKeys.has(`${provider}\u0000${id}`);
		};
		return models.map(model => {
			const providerOverrides = overrides.get(model.provider);
			if (!providerOverrides) return model;
			const override = resolveModelOverrideWithAliases(providerOverrides, model, hasLiveModel);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}
	#applyHardcodedModelPolicies(models: Model<Api>[]): Model<Api>[] {
		const extendedContext = isExtendedContextEnabledFromSettings(this.#settings);
		return models.map(model => {
			// Extended context off: cap models with a premium long-context price
			// tier (e.g. GPT-5.6 bills 2x input above 272K) at the standard-pricing
			// threshold so compaction fires before a request crosses into the tier.
			// xai-oauth carries public xAI prices only for API-equivalent stats;
			// SuperGrok requests remain subscription-backed, so its estimated tier
			// must not constrain the runtime context window. Explicit per-model
			// `contextWindow` overrides reapply later in composition and win over
			// this cap.
			if (!extendedContext && model.provider !== "xai-oauth") {
				const threshold = model.cost.longContext?.inputThreshold;
				if (threshold !== undefined && model.contextWindow !== null && model.contextWindow > threshold) {
					model = applyModelOverride(model, { contextWindow: threshold });
				}
			}
			if (model.provider === "ollama-cloud" && model.omitMaxOutputTokens !== true) {
				model = applyModelOverride(model, { omitMaxOutputTokens: true });
			}
			if (model.id !== "gpt-5.4" || model.provider === "github-copilot") {
				return model;
			}
			const overrides = this.#modelOverrides.get(model.provider)?.get(model.id);
			if (!overrides) {
				return applyModelOverride(model, { contextWindow: 1_000_000 });
			}
			return applyModelOverride(model, {
				contextWindow: overrides.contextWindow ?? 1_000_000,
				...overrides,
			});
		});
	}

	#parseModels(config: ModelsConfig): CustomModelOverlay[] {
		const models: CustomModelOverlay[] = [];
		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models
			if (providerConfig.apiKey) {
				this.#installProviderApiKey(providerName, providerConfig.apiKey);
			}
			for (const modelDef of modelDefs) {
				const providerCompat = providerConfig.disableStrictTools
					? mergeCompat(providerConfig.compat, { disableStrictTools: true })
					: providerConfig.compat;
				const model = buildCustomModelOverlay(
					providerName,
					providerConfig.baseUrl!,
					providerConfig.api as Api | undefined,
					providerConfig.headers,
					providerConfig.apiKey,
					providerConfig.authHeader,
					providerCompat,
					(providerConfig.auth as ProviderAuthMode | undefined) ?? undefined,
					providerConfig.remoteCompaction,
					modelDef as CustomModelDefinitionLike,
				);
				if (!model) continue;
				models.push(model);
			}
		}
		return models;
	}

	#modelsForProviderLookup(provider: string): Model<Api>[] {
		if (this.#hasFullSnapshot) return this.#models;
		const normalizedProvider = provider.trim().toLowerCase();
		if (!normalizedProvider) return [];
		const cached = this.#providerLookupSnapshots.get(normalizedProvider);
		if (cached) return cached;
		const matchingProviders = new Set(
			this.#knownStaticProviders().filter(candidate => candidate.toLowerCase() === normalizedProvider),
		);
		const models = this.#composeStaticModels(matchingProviders);
		this.#providerLookupSnapshots.set(normalizedProvider, models);
		return models;
	}

	/**
	 * Get all models (built-in + custom).
	 * If custom config had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.#ensureFullSnapshot();
	}

	/**
	 * Availability predicate with per-provider memoization. Auth lookups
	 * (`authStorage.hasAuth`) and the disabled-provider set are resolved once
	 * per provider instead of once per model, which matters when filtering the
	 * full bundled catalog (thousands of models, ~50 providers).
	 */
	#createProviderAvailabilityCheck(): (provider: string) => boolean {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const byProvider = new Map<string, boolean>();
		return provider => {
			let available = byProvider.get(provider);
			if (available === undefined) {
				available =
					!disabledProviders.has(provider) &&
					(this.#keylessProviders.has(provider) || this.authStorage.hasAuth(provider));
				byProvider.set(provider, available);
			}
			return available;
		};
	}

	/**
	 * Get authenticated models for an explicit provider set without materializing
	 * unrelated cached catalogs. Startup role resolution uses this before the
	 * full model picker is needed.
	 */
	getAvailableForProviders(providers: ReadonlySet<string>): Model<Api>[] {
		const requested = new Set([...providers].map(provider => provider.trim().toLowerCase()).filter(Boolean));
		const isProviderAvailable = this.#createProviderAvailabilityCheck();
		if (this.#hasFullSnapshot) {
			return this.#models.filter(
				model => requested.has(model.provider.toLowerCase()) && isProviderAvailable(model.provider),
			);
		}
		const availableProviders = new Set(
			this.#knownStaticProviders().filter(
				provider => requested.has(provider.toLowerCase()) && isProviderAvailable(provider),
			),
		);
		return this.#composeStaticModels(availableProviders);
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.getAvailableForProviders(new Set(this.#knownStaticProviders()));
	}

	/**
	 * Check whether auth is configured for a model's provider.
	 *
	 * Mirrors the upstream `@mariozechner/pi-coding-agent` API surface so that
	 * external plugins/extensions and downstream wrappers (e.g. subagent launch
	 * paths that pre-flight auth before model resolution) can probe a model
	 * without resolving an API key. Returns true for keyless providers as well
	 * as providers with stored credentials. See issue #993.
	 *
	 * Side-effect-free and synchronous: a command-backed key (`!cmd`) counts as
	 * configured by its presence alone — the program is NOT executed — and OAuth
	 * tokens are NOT refreshed (`authStorage.hasResolvableAuth`). This is what keeps the
	 * model-switch pre-flight off the event loop's hot path; the real key
	 * (command execution + OAuth refresh) is resolved lazily per request via
	 * {@link ModelRegistry.resolver}.
	 *
	 * Cross-provider env aliases count here (`xai-oauth` can borrow `XAI_API_KEY`)
	 * so an explicit `xai-oauth/…` selector does not fail with "No API key".
	 * Default-model availability still uses {@link AuthStorage.hasAuth}, which
	 * ignores that alias so SuperGrok is not auto-selected from a paid key.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		const keyConfig = this.#customProviderApiKeys.get(model.provider);
		return (
			isCommandConfigValue(keyConfig) ||
			this.#keylessProviders.has(model.provider) ||
			this.authStorage.hasResolvableAuth(model.provider)
		);
	}

	/**
	 * Whether `provider` has a *concrete* credential — a stored login, a
	 * command/config/runtime key, or a keyless local endpoint — as opposed to a
	 * self-resolving AWS/Vertex sentinel that only signals an ambient credential
	 * *source* exists. Default-model auto-selection prefers concretely-authed
	 * providers so an ambiently-available Bedrock/Vertex provider never displaces
	 * the provider the user actually signed into. See {@link AuthStorage.hasConcreteAuth}
	 * and issue #9967.
	 */
	hasConcreteAuth(provider: string): boolean {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		return (
			isCommandConfigValue(keyConfig) ||
			this.#keylessProviders.has(provider) ||
			this.authStorage.hasConcreteAuth(provider)
		);
	}

	/**
	 * Whether the provider's configured API key is resolved from a command.
	 *
	 * Callers use this to distinguish the registry's command-first resolver
	 * path from lower-priority credentials in {@link authStorage}.
	 */
	hasCommandBackedApiKey(provider: string): boolean {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		return isCommandConfigValue(keyConfig);
	}

	getDiscoverableProviders(): string[] {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		return this.#discoverableProviders
			.filter(provider => !disabledProviders.has(provider.provider))
			.map(provider => provider.provider);
	}

	/**
	 * Whether `providerId` is known to the registry: it has at least one live
	 * model, or it is configured for dynamic discovery (models.yml `discovery:`
	 * or a runtime extension provider) and is not disabled. Discovery-only
	 * providers can hold zero models at startup — cached rows never persist
	 * live auth headers (#5780), so a provider whose discovered models all
	 * carry config headers (`authHeader: true`) only materializes models after
	 * the online refresh completes.
	 */
	hasProvider(providerId: string): boolean {
		const providerModels = this.#hasFullSnapshot ? this.#models : this.#composeStaticModels(new Set([providerId]));
		if (providerModels.some(model => model.provider === providerId)) return true;
		if (getDisabledProviderIdsFromSettings(this.#settings).has(providerId)) return false;
		return (
			this.#discoverableProviders.some(provider => provider.provider === providerId) ||
			this.#runtimeModelManagers.has(providerId)
		);
	}

	getProviderDiscoveryState(provider: string): ProviderDiscoveryState | undefined {
		return this.#providerDiscoveryStates.get(provider);
	}

	/**
	 * Whether a config-declared discovery provider has not yet produced a
	 * catalog in this process. A cold discovery cache (e.g. after `omp update`
	 * bumps the cache namespace) leaves the provider in its initial `idle`
	 * state with no models, so a selector the provider will supply looks
	 * unknown until background discovery lands (#10048).
	 */
	isProviderDiscoveryPending(provider: string): boolean {
		return this.#providerDiscoveryStates.get(provider)?.status === "idle";
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return resolveProviderModelReference(provider, modelId, this.#modelsForProviderLookup(provider));
	}

	/**
	 * Get the base URL associated with a provider, if any model defines one.
	 */
	getProviderBaseUrl(provider: string): string | undefined {
		return this.#modelsForProviderLookup(provider).find(m => m.provider === provider && m.baseUrl)?.baseUrl;
	}
	/**
	 * Get provider-level headers without including per-model overrides.
	 */
	getProviderHeaders(provider: string): Record<string, string> | undefined {
		return createLiveConfigHeaders([
			this.#providerOverrides.get(provider)?.headers,
			this.#runtimeProviderOverrides.get(provider)?.headers,
		]);
	}

	/**
	 * Get API key for a model.
	 */
	async getApiKey(
		model: Model<Api>,
		sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<string | undefined> {
		const commandKey = this.#resolveCommandBackedApiKey(model.provider);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(model.provider) && !this.authStorage.hasAuth(model.provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(model.provider, sessionId, {
			baseUrl: model.baseUrl,
			modelId: model.id,
			signal: options?.signal,
		});
	}

	/** Resolve request authentication through the historical Pi extension facade. */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const apiKey = await this.getApiKey(model);
			if (apiKey === undefined) {
				return { ok: false, error: `No API key found for "${model.provider}"` };
			}
			const headers = this.getProviderHeaders(model.provider);
			return { ok: true, apiKey, headers };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Get API key for a provider (e.g., "openai").
	 *
	 * `options.forceRefresh` powers step (b) of the auth-retry policy — it
	 * re-mints the session-sticky OAuth token even when the cached copy still
	 * looks valid. `options.signal` is threaded into any broker-bound refresh.
	 */
	async getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<string | undefined> {
		if (options?.forceRefresh) this.#invalidateProviderCommandConfigs(provider);
		const commandKey = this.#resolveCommandBackedApiKey(
			provider,
			options?.forceRefresh ? { forceCommandRefresh: true } : undefined,
		);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(provider, sessionId, {
			baseUrl: options?.baseUrl,
			modelId: options?.modelId,
			forceRefresh: options?.forceRefresh,
			signal: options?.signal,
		});
	}

	/**
	 * Build an {@link ApiKeyResolver} implementing the central a/b/c auth-retry
	 * policy. Accepts a provider id with options, or a model with an optional
	 * session id (`resolver(model, sessionId)`) which derives `baseUrl`/`modelId`
	 * from the model. Callers that need the initial key for a guard can call
	 * `resolveApiKeyOnce(resolver)`.
	 */
	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	resolver(target: string | ApiKeyResolverModel, optionsOrSessionId?: ApiKeyResolverOptions | string): ApiKeyResolver {
		const options = typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : optionsOrSessionId;
		if (typeof target === "string") {
			return createApiKeyResolver(this, target, options);
		}
		return createApiKeyResolver(this, target.provider, {
			...options,
			baseUrl: target.baseUrl,
			modelId: target.id,
		});
	}

	async #peekApiKeyForProvider(provider: string): Promise<string | undefined> {
		const commandKey = this.#resolveCommandBackedApiKey(provider);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.peekApiKey(provider);
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.hasOAuth(model.provider);
	}

	#clearRuntimeProviderState(providerName: string): void {
		this.#runtimeProviderApiKeys.delete(providerName);
		this.#runtimeProviderOverrides.delete(providerName);
		this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(overlay => overlay.provider !== providerName);
		this.#runtimeModelManagers.delete(providerName);
		this.#runtimeModelModifiers.delete(providerName);
		this.#lastModelModifierWarnings.delete(providerName);
		this.authStorage.removeConfigApiKey(providerName);
		this.authStorage.removeRuntimeUsageProvider(providerName);
	}

	/**
	 * Remove custom API/OAuth registrations for a specific extension source.
	 */
	clearSourceRegistrations(sourceId: string): void {
		unregisterCustomApis(sourceId);
		unregisterOAuthProviders(sourceId);
		const sourceProviders = this.#runtimeProvidersBySource.get(sourceId);
		if (!sourceProviders || sourceProviders.size === 0) {
			return;
		}
		this.#ensureFullSnapshot();
		this.#runtimeProvidersBySource.delete(sourceId);
		for (const providerName of sourceProviders) {
			if (this.#runtimeProviderSourceByName.get(providerName) !== sourceId) {
				continue;
			}
			this.#runtimeProviderSourceByName.delete(providerName);
			this.#clearRuntimeProviderState(providerName);
		}
		this.#lastStaticLoadMtime = null;
		this.#reloadStaticModels();
	}

	/**
	 * Remove one extension-registered provider and restore its static models.
	 */
	unregisterProvider(providerName: string): void {
		const sourceId = this.#runtimeProviderSourceByName.get(providerName);
		if (sourceId) {
			const sourceProviders = this.#runtimeProvidersBySource.get(sourceId);
			sourceProviders?.delete(providerName);
			if (sourceProviders?.size === 0) {
				this.#runtimeProvidersBySource.delete(sourceId);
			}
			this.#runtimeProviderSourceByName.delete(providerName);
		}
		unregisterOAuthProvider(providerName);
		this.#ensureFullSnapshot();
		this.#clearRuntimeProviderState(providerName);
		this.#lastStaticLoadMtime = null;
		this.#reloadStaticModels();
	}

	/**
	 * Remove registrations for extension sources that are no longer active.
	 */
	syncExtensionSources(activeSourceIds: string[]): void {
		const activeSources = new Set(activeSourceIds);
		for (const sourceId of this.#registeredProviderSources) {
			if (activeSources.has(sourceId)) {
				continue;
			}
			this.clearSourceRegistrations(sourceId);
			this.#registeredProviderSources.delete(sourceId);
		}
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has streamSimple: registers a custom API streaming function.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput, sourceId?: string): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		validateProviderConfiguration(
			providerName,
			{
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				api: config.api,
				oauthConfigured: Boolean(config.oauth),
				models: (config.models ?? []) as ProviderValidationModel[],
			},
			"runtime-register",
		);

		if (config.streamSimple && config.api) {
			const streamSimple = config.streamSimple;
			registerCustomApi(config.api, streamSimple, sourceId, (model, context, options) =>
				streamSimple(model, context, options as SimpleStreamOptions),
			);
		}

		if (config.oauth) {
			registerOAuthProvider({
				...config.oauth,
				id: providerName,
				sourceId,
			});
		}

		let sourceHandoff = false;
		if (sourceId) {
			this.#registeredProviderSources.add(sourceId);
			const previousSourceId = this.#runtimeProviderSourceByName.get(providerName);
			if (previousSourceId && previousSourceId !== sourceId) {
				const previousProviders = this.#runtimeProvidersBySource.get(previousSourceId);
				previousProviders?.delete(providerName);
				if (previousProviders && previousProviders.size === 0) {
					this.#runtimeProvidersBySource.delete(previousSourceId);
				}
				this.#clearRuntimeProviderState(providerName);
				sourceHandoff = true;
			}
			const sourceProviders = this.#runtimeProvidersBySource.get(sourceId) ?? new Set<string>();
			sourceProviders.add(providerName);
			this.#runtimeProvidersBySource.set(sourceId, sourceProviders);
			this.#runtimeProviderSourceByName.set(providerName, sourceId);
		}
		if (sourceHandoff) {
			this.#lastStaticLoadMtime = null;
			this.#reloadStaticModels();
		}

		// Extension usage providers override built-ins/configured resolvers for the
		// provider lifetime. #clearRuntimeProviderState removes this override when
		// the owning extension is unregistered or replaced.
		if (config.usage) {
			this.authStorage.setRuntimeUsageProvider(providerName, config.usage, config.apiKey);
		}
		if (config.apiKey) {
			this.#installProviderApiKey(providerName, config.apiKey);
			// Persist runtime API keys so they survive #reloadStaticModels() cycles
			this.#runtimeProviderApiKeys.set(providerName, config.apiKey);
		}

		if (config.models && config.models.length > 0) {
			// Build model overlays that persist across refresh() cycles
			const newOverlays: CustomModelOverlay[] = [];
			for (const modelDef of config.models) {
				const overlay = buildCustomModelOverlay(
					providerName,
					config.baseUrl!,
					config.api,
					config.headers,
					config.apiKey,
					config.authHeader,
					config.compat,
					undefined,
					config.remoteCompaction,
					modelDef as CustomModelDefinitionLike,
				);
				if (!overlay) {
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
				}
				newOverlays.push(overlay);
			}
			// Store as runtime overlays so they survive #reloadStaticModels()
			this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(m => m.provider !== providerName);
			this.#runtimeModelOverlays.push(...newOverlays);

			// A modifier is explicitly a whole-catalog transform and may throw
			// based on another provider's models. Preserve registration-time
			// execution/error reporting by materializing only for this case.
			if (config.oauth?.modifyModels && !this.#hasFullSnapshot) {
				logger.time(`modelRegistry:materializeModifier:${providerName}`, () => this.#ensureFullSnapshot());
			}
			if (config.oauth?.modifyModels) {
				this.#runtimeModelModifiers.set(providerName, config.oauth.modifyModels);
			} else {
				this.#runtimeModelModifiers.delete(providerName);
			}
			if (!this.#hasFullSnapshot) {
				// Lazy compositions read runtime overlays directly. A whole-catalog
				// modifier can affect providers beyond its owner, so discard every
				// provider slice; an ordinary overlay only invalidates its provider.
				if (config.oauth?.modifyModels) {
					this.#providerLookupSnapshots.clear();
					this.#internedStaticModels.clear();
				} else {
					this.#invalidateProviderModelCache(providerName);
				}
				if (!config.fetchDynamicModels) return;
			}

			// Update the unprojected snapshot, then rerun every whole-catalog
			// projection exactly once. Incremental projection is not safe because one
			// provider's hook may inspect or suppress another provider's models.
			const nextModels = this.#unprojectedModels.filter(model => model.provider !== providerName);
			for (const overlay of newOverlays) {
				nextModels.push(finalizeCustomModel(overlay, { useDefaults: true }));
			}
			const runtimeTransportOverride = this.#runtimeProviderOverrides.get(providerName);
			const nextModelsWithTransport = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyProviderTransportOverrideToModel(model, runtimeTransportOverride);
					})
				: nextModels;
			this.#unprojectedModels = this.#applyProviderGuardrailOverrides(nextModelsWithTransport);

			this.#models = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
			this.#invalidateProviderModelCache(providerName);
			if (!config.fetchDynamicModels) return;
		}

		if (config.fetchDynamicModels) {
			const fetcher = config.fetchDynamicModels;
			const providerBaseUrl = config.baseUrl ?? "";
			const providerApi = config.api;
			const providerHeaders = config.headers;
			const providerApiKey = config.apiKey;
			const providerAuthHeader = config.authHeader;
			const providerCompat = config.compat;
			const managerOptions: ModelManagerOptions<Api> = {
				providerId: providerName as Parameters<typeof createModelManager>[0]["providerId"],
				staticModels: [],
				cacheDbPath: this.#cacheDbPath,
				cacheTtlMs: 24 * 60 * 60 * 1000,
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: async () => {
					const apiKey = await this.#peekApiKeyForProvider(providerName);
					const resolvedKey = isAuthenticated(apiKey) ? apiKey : undefined;
					const modelDefs = await withModelDiscoveryTimeout(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS, () =>
						fetcher(resolvedKey),
					);
					const results: Model<Api>[] = [];
					for (const modelDef of modelDefs) {
						const overlay = buildCustomModelOverlay(
							providerName,
							modelDef.baseUrl ?? providerBaseUrl,
							modelDef.api ?? providerApi,
							providerHeaders,
							providerApiKey,
							providerAuthHeader,
							providerCompat,
							undefined,
							config.remoteCompaction,
							modelDef as CustomModelDefinitionLike,
						);
						if (overlay) results.push(finalizeCustomModel(overlay, { useDefaults: true }));
					}
					return results.map(toModelSpec);
				},
			};
			this.#runtimeModelManagers.set(providerName, { options: managerOptions, sourceId: sourceId ?? "" });
			// Discovery is driven by refreshRuntimeProviders() after the drain — not
			// here, so registration has no network side effect and callers can await.
		}

		if (
			config.baseUrl ||
			config.headers ||
			config.apiKey ||
			config.authHeader !== undefined ||
			config.remoteCompaction !== undefined ||
			config.transport !== undefined
		) {
			const transportOverride = {
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				authHeader: config.authHeader,
				remoteCompaction: config.remoteCompaction,
				transport: config.transport,
			};
			const nextRuntimeOverride = this.#mergeProviderOverride(
				this.#runtimeProviderOverrides.get(providerName),
				transportOverride,
			);
			this.#runtimeProviderOverrides.set(providerName, nextRuntimeOverride);
			if (this.#hasFullSnapshot) {
				this.#unprojectedModels = this.#applyLlamaCppModelFixups(
					this.#unprojectedModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyProviderTransportOverrideToModel(model, transportOverride);
					}),
				);
				this.#models = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
			}
			this.#invalidateProviderModelCache(providerName);
		}
	}

	/**
	 * Suppress a specific model selector (e.g., "provider/id") until a specific timestamp.
	 */
	suppressSelector(selector: string, untilMs: number): void {
		this.#suppressedSelectors.set(
			normalizeSuppressedSelector(selector, (provider, id) => this.find(provider, id) !== undefined),
			untilMs,
		);
	}

	/**
	 * Check if a model selector is currently suppressed due to rate limits.
	 */
	isSelectorSuppressed(selector: string): boolean {
		const normalizedSelector = normalizeSuppressedSelector(
			selector,
			(provider, id) => this.find(provider, id) !== undefined,
		);
		const suppressedUntil = this.#suppressedSelectors.get(normalizedSelector);
		if (!suppressedUntil) return false;
		if (suppressedUntil <= Date.now()) {
			this.#suppressedSelectors.delete(normalizedSelector);
			return false;
		}
		return true;
	}

	/**
	 * Clear the cooldown suppression for one selector after an explicit user selection.
	 */
	clearSuppressedSelector(selector: string): void {
		this.#suppressedSelectors.delete(
			normalizeSuppressedSelector(selector, (provider, id) => this.find(provider, id) !== undefined),
		);
	}

	/**
	 * Clear all cooldown suppressions recorded via {@link suppressSelector}.
	 * Used to reset retry-fallback cooldown state without a full {@link refresh}.
	 */
	clearSuppressedSelectors(): void {
		this.#suppressedSelectors.clear();
	}
}

/**
 * Input type for registerProvider API (from extensions).
 */
export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	authHeader?: boolean;
	/** Streaming transport override — see {@link Model.transport}. */
	transport?: Model<Api>["transport"];
	/** Optional normalized usage fetcher; takes precedence over built-in usage providers. */
	usage?: UsageProvider;
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey?(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
	/**
	 * Async factory that fetches the live model list from the provider endpoint.
	 * When present, the result is run through the same SQLite model-cache as
	 * built-in providers (keyed by provider name, default 24 h TTL).
	 * The factory receives the resolved API key (undefined when unauthenticated).
	 */
	fetchDynamicModels?: (
		apiKey: string | undefined,
	) => Promise<readonly NonNullable<ProviderConfigInput["models"]>[number][]>;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinking?: ThinkingConfig;
		input: ("text" | "image")[];
		supportsTools?: boolean;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		/** Whether Codex requests should prefer WebSocket transport. */
		preferWebsockets?: boolean;
		headers?: Record<string, string>;
		compat?: ModelSpec<Api>["compat"];
		contextPromotionTarget?: string;
		compactionModel?: string;
		remoteCompaction?: RemoteCompactionConfig<Api>;
		premiumMultiplier?: number;
	}>;
}
