import { buildModel } from "./build";
import { readModelCache, writeModelCache } from "./model-cache";
import { type GeneratedProvider, getBundledModels } from "./models";
import type { Api, Model, ModelSpec, Provider } from "./types";
import { isRecord } from "./utils";
import { collapseBuiltModelVariants } from "./variant-collapse";

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

/**
 * Controls when dynamic endpoint models should be fetched.
 */
export type ModelRefreshStrategy = "online" | "offline" | "online-if-uncached";

/**
 * Hook for loading and mapping models.dev fallback data into canonical model objects.
 */
export interface ModelsDevFallback<TApi extends Api = Api, TPayload = unknown> {
	/** Fetches raw fallback payload (for example from models.dev). */
	fetch(): Promise<TPayload>;
	/** Maps payload into provider models. */
	map(payload: TPayload, providerId: Provider): readonly ModelSpec<TApi>[];
}

/**
 * Configuration for provider model resolution.
 */
export interface ModelManagerOptions<TApi extends Api = Api, TModelsDevPayload = unknown> {
	/** Provider id used for static lookup and cache namespacing. */
	providerId: Provider;
	/** Optional static list override. When omitted, bundled models.json is used. */
	staticModels?: readonly ModelSpec<TApi>[];
	/** Optional override for the cache database path. Default: <agent-dir>/models.db. */
	cacheDbPath?: string;
	/** Optional provider id override for cache namespacing. Defaults to providerId. */
	cacheProviderId?: string;
	/** Maximum cache age in milliseconds before considered stale. Default: 24h. */
	cacheTtlMs?: number;
	/** When true, a successful dynamic fetch is the complete provider catalog and prunes static-only models. */
	dynamicModelsAuthoritative?: boolean;
	/** Cached model ids to ignore when the cache was written against a different static catalog fingerprint. */
	dropCachedModelIdsOnStaticMismatch?: readonly string[];
	/** Optional dynamic endpoint fetcher. */
	fetchDynamicModels?: () => Promise<readonly ModelSpec<TApi>[] | null>;
	/** Optional models.dev fallback hook. */
	modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;
	/** Clock override for deterministic tests. */
	now?: () => number;
}

/**
 * Resolution result.
 *
 * `stale` is false when the resolved catalog is authoritative for the selected provider:
 * - dynamic endpoint data was fetched in this call,
 * - a still-fresh authoritative cache was reused in `online-if-uncached` mode, or
 * - the provider has no dynamic fetcher configured.
 */
export interface ModelResolutionResult<TApi extends Api = Api> {
	models: Model<TApi>[];
	stale: boolean;
}

/**
 * Stateful facade over provider model resolution.
 */
export interface ModelManager<TApi extends Api = Api> {
	refresh(strategy?: ModelRefreshStrategy): Promise<ModelResolutionResult<TApi>>;
}

/**
 * Creates a reusable provider model manager.
 */
export function createModelManager<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): ModelManager<TApi> {
	return {
		refresh(strategy: ModelRefreshStrategy = "online-if-uncached") {
			return resolveProviderModels(options, strategy);
		},
	};
}

/**
 * Cheap fast path for trusted spec sources (caller-provided literals, our own
 * cache rows). Skips per-field validation; only guards against
 * catastrophically corrupt rows. Builds each spec into a runtime model.
 */
function passModelList<TApi extends Api>(value: unknown): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: Model<TApi>[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object" || typeof (item as { id: unknown }).id !== "string") {
			continue;
		}
		out.push(buildModel(item as ModelSpec<TApi>));
	}
	return out;
}

/**
 * Resolves provider models with source precedence:
 * static -> models.dev -> cache -> dynamic.
 *
 * Later sources override earlier ones by model id.
 */
export async function resolveProviderModels<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	strategy: ModelRefreshStrategy = "online-if-uncached",
): Promise<ModelResolutionResult<TApi>> {
	const cacheProviderId = options.cacheProviderId ?? options.providerId;
	const now = options.now ?? Date.now;
	const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const dbPath = options.cacheDbPath;
	const staticModels = options.staticModels
		? passModelList<TApi>(options.staticModels)
		: (getBundledModels(options.providerId as GeneratedProvider) as Model<TApi>[]);
	const cache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
	const dynamicModelsAuthoritative = options.dynamicModelsAuthoritative ?? false;
	const staticFingerprint = fingerprintStatic(staticModels, dynamicModelsAuthoritative);
	const cacheFingerprintMatches = cache?.staticFingerprint === staticFingerprint && staticFingerprint.length > 0;
	const hasUsableFreshCache = (cache?.fresh ?? false) && (!dynamicModelsAuthoritative || cacheFingerprintMatches);
	const dynamicFetcher = options.fetchDynamicModels;
	const hasDynamicFetcher = typeof dynamicFetcher === "function";
	const hasAuthoritativeCache = ((cache?.authoritative ?? false) && hasUsableFreshCache) || !hasDynamicFetcher;
	const cacheAgeMs = cache ? now() - cache.updatedAt : Number.POSITIVE_INFINITY;
	const shouldFetchFromNetwork = shouldFetchRemoteSources(
		strategy,
		hasUsableFreshCache,
		hasAuthoritativeCache,
		cacheAgeMs,
	);

	// Cold-start fast path: when a fresh, authoritative cache exists, the network
	// fetch is skipped, AND the static catalog slice is byte-identical to what
	// was merged in last time, the cache row IS the authoritative merge result.
	// Re-running `mergeDynamicModels(static, cache)` would just rebuild the same
	// objects (~800ms in the steady-state cold-start profile for `omp -p hi`).
	if (!shouldFetchFromNetwork && cache?.fresh && hasAuthoritativeCache && cacheFingerprintMatches) {
		return { models: collapseBuiltModelVariants(passModelList<TApi>(cache.models)), stale: false };
	}

	const [fetchedModelsDevModels, fetchedDynamicModels] = shouldFetchFromNetwork
		? await Promise.all([fetchModelsDev(options), dynamicFetcher ? fetchDynamicModels(dynamicFetcher) : null])
		: [null, null];
	const modelsDevModels = normalizeModelList<TApi>(fetchedModelsDevModels ?? []);
	const shouldUseFreshCacheAsAuthoritative =
		strategy === "online-if-uncached" && hasUsableFreshCache && hasAuthoritativeCache;
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;
	const cacheModels = dynamicFetchSucceeded
		? []
		: dropCachedModelIdsOnStaticMismatch(
				normalizeModelList<TApi>(cache?.models ?? []),
				cacheFingerprintMatches,
				options.dropCachedModelIdsOnStaticMismatch,
			);
	const dynamicModels = fetchedDynamicModels ?? [];
	const mergedWithCache = mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), cacheModels);
	const mergedModels = mergeDynamicModels(mergedWithCache, dynamicModels);
	const models = collapseBuiltModelVariants(
		dynamicModelsAuthoritative && dynamicFetchSucceeded ? retainModelIds(mergedModels, dynamicModels) : mergedModels,
	);
	const dynamicAuthoritative = !hasDynamicFetcher || dynamicFetchSucceeded || shouldUseFreshCacheAsAuthoritative;
	if (shouldFetchFromNetwork) {
		if (dynamicFetchSucceeded) {
			const mergedSnapshot = mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), dynamicModels);
			const snapshotModels = dynamicModelsAuthoritative
				? retainModelIds(mergedSnapshot, dynamicModels)
				: mergedSnapshot;
			writeModelCache(
				cacheProviderId,
				now(),
				collapseBuiltModelVariants(snapshotModels),
				true,
				staticFingerprint,
				dbPath,
			);
		} else {
			// Dynamic fetch failed — update cache with a non-authoritative snapshot so
			// stale state remains visible while retry backoff still applies.
			const latestCache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
			writeModelCache(
				cacheProviderId,
				now(),
				collapseBuiltModelVariants(
					mergeDynamicModels(
						mergeModelSources(staticModels, modelsDevModels),
						dropCachedModelIdsOnStaticMismatch(
							normalizeModelList<TApi>(latestCache?.models ?? cache?.models ?? []),
							cacheFingerprintMatches,
							options.dropCachedModelIdsOnStaticMismatch,
						),
					),
				),
				false,
				staticFingerprint,
				dbPath,
			);
		}
	}
	return {
		models,
		stale: !dynamicAuthoritative,
	};
}

async function fetchModelsDev<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): Promise<Model<TApi>[] | null> {
	if (!options.modelsDev) {
		return null;
	}

	try {
		const payload = await options.modelsDev.fetch();
		return normalizeModelList<TApi>(options.modelsDev.map(payload, options.providerId));
	} catch {
		return null;
	}
}

async function fetchDynamicModels<TApi extends Api>(
	fetcher: () => Promise<readonly ModelSpec<TApi>[] | null>,
): Promise<Model<TApi>[] | null> {
	try {
		const models = await fetcher();
		if (models === null) {
			return null;
		}
		return normalizeModelList<TApi>(models);
	} catch {
		return null;
	}
}

function shouldFetchRemoteSources(
	strategy: ModelRefreshStrategy,
	hasFreshCache: boolean,
	hasAuthoritativeCache: boolean,
	cacheAgeMs: number,
): boolean {
	if (strategy === "offline") {
		return false;
	}
	if (strategy === "online") {
		return true;
	}
	// online-if-uncached: skip fetch if cache is fresh.
	// For non-authoritative caches (dynamic fetch previously failed),
	// use a shorter retry interval instead of retrying every startup.
	if (!hasFreshCache) {
		return true;
	}
	if (!hasAuthoritativeCache) {
		return cacheAgeMs >= NON_AUTHORITATIVE_RETRY_MS;
	}
	return false;
}

function dropCachedModelIdsOnStaticMismatch<TApi extends Api>(
	models: readonly Model<TApi>[],
	cacheFingerprintMatches: boolean,
	ids: readonly string[] | undefined,
): Model<TApi>[] {
	if (cacheFingerprintMatches || ids === undefined || ids.length === 0 || models.length === 0) {
		return models.length === 0 ? [] : [...models];
	}
	const droppedIds = new Set(ids);
	return models.filter(model => !droppedIds.has(model.id));
}

function mergeModelSources<TApi extends Api>(...sources: readonly (readonly Model<TApi>[])[]): Model<TApi>[] {
	// Strip out empty/missing sources up front. The hot path is `(static, [])`
	// (modelsDev disabled / failed) — a single non-empty source means we can
	// skip the Map churn entirely and just hand back the array.
	const nonEmpty = sources.filter(source => source.length > 0);
	if (nonEmpty.length === 0) return [];
	if (nonEmpty.length === 1) return [...nonEmpty[0]];
	const merged = new Map<string, Model<TApi>>();
	for (const source of nonEmpty) {
		for (const model of source) {
			if (!model?.id) continue;
			merged.set(model.id, model);
		}
	}
	return Array.from(merged.values());
}

function mergeDynamicModels<TApi extends Api>(
	baseModels: readonly Model<TApi>[],
	dynamicModels: readonly Model<TApi>[],
): Model<TApi>[] {
	// Empty-side fast paths: `mergeDynamicModels(base, [])` is the common shape
	// after we've already merged the first pair, and `(...)` with no base
	// happens for providers without static catalogs.
	if (dynamicModels.length === 0) return baseModels.length === 0 ? [] : [...baseModels];
	if (baseModels.length === 0) return [...dynamicModels];
	const merged = new Map<string, Model<TApi>>(baseModels.map(model => [model.id, model]));
	for (const dynamicModel of dynamicModels) {
		if (!dynamicModel?.id) {
			continue;
		}
		const existingModel = merged.get(dynamicModel.id);
		if (!existingModel) {
			merged.set(dynamicModel.id, dynamicModel);
			continue;
		}
		merged.set(dynamicModel.id, mergeDynamicModel(existingModel, dynamicModel));
	}
	return Array.from(merged.values());
}

function retainModelIds<TApi extends Api>(
	models: readonly Model<TApi>[],
	retainedModels: readonly Model<TApi>[],
): Model<TApi>[] {
	if (retainedModels.length === 0 || models.length === 0) return [];
	const retainedIds = new Set(retainedModels.map(model => model.id));
	return models.filter(model => retainedIds.has(model.id));
}

/**
 * Stable, low-collision fingerprint of a static catalog slice. Cached by
 * reference so repeat calls in the same process (e.g. multiple cold-start
 * arms calling `resolveProviderModels` with the same `staticModels` array)
 * skip the JSON+hash work after the first call.
 */
const MODEL_CACHE_FINGERPRINT_VERSION = "merge-v3";
const kStaticFingerprint = Symbol("model-manager.staticFingerprint");
type ModelArrayWithFingerprint = readonly Model<Api>[] & { [kStaticFingerprint]?: string };
function fingerprintStatic<TApi extends Api>(
	models: readonly Model<TApi>[],
	dynamicModelsAuthoritative = false,
): string {
	if (models.length === 0) return `${MODEL_CACHE_FINGERPRINT_VERSION}:empty`;
	if (dynamicModelsAuthoritative)
		return `${MODEL_CACHE_FINGERPRINT_VERSION}:authoritative:${fingerprintStatic(models)}`;
	const tagged = models as ModelArrayWithFingerprint;
	const cached = tagged[kStaticFingerprint];
	if (cached !== undefined) return cached;
	// `Bun.hash` returns a `bigint`; base36 keeps the string short for the
	// SQLite column without sacrificing distinguishability.
	const fingerprint = `${MODEL_CACHE_FINGERPRINT_VERSION}:${Bun.hash(JSON.stringify(models)).toString(36)}`;
	tagged[kStaticFingerprint] = fingerprint;
	return fingerprint;
}

function mergeDynamicModel<TApi extends Api>(existingModel: Model<TApi>, dynamicModel: Model<TApi>): Model<TApi> {
	// When discovery resolves the same model id to a different endpoint (e.g.
	// a GitHub Copilot business/enterprise host), the bundled reference's
	// capabilities are pinned to the canonical host and no longer apply —
	// honour the dynamic value alone. Same-endpoint merges still OR-upgrade so
	// a discovery that omits the capability flag doesn't drop bundled vision.
	const endpointChanged = existingModel.baseUrl !== dynamicModel.baseUrl;
	const supportsImage = endpointChanged
		? dynamicModel.input.includes("image")
		: existingModel.input.includes("image") || dynamicModel.input.includes("image");
	// Re-build from spec stage: sparse compat comes from `compatConfig` (the
	// verbatim override vocabulary), never the resolved `compat` record.
	return buildModel({
		...existingModel,
		...dynamicModel,
		name: preferDiscoveryName(dynamicModel.name, existingModel.name, dynamicModel.id),
		reasoning: existingModel.reasoning || dynamicModel.reasoning,
		input: supportsImage ? ["text", "image"] : ["text"],
		cost: {
			input: preferDiscoveryCost(dynamicModel.cost.input, existingModel.cost.input),
			output: preferDiscoveryCost(dynamicModel.cost.output, existingModel.cost.output),
			cacheRead: preferDiscoveryCost(dynamicModel.cost.cacheRead, existingModel.cost.cacheRead),
			cacheWrite: preferDiscoveryCost(dynamicModel.cost.cacheWrite, existingModel.cost.cacheWrite),
		},
		contextWindow: preferDiscoveryLimit(dynamicModel.contextWindow, existingModel.contextWindow),
		maxTokens: preferDiscoveryLimit(dynamicModel.maxTokens, existingModel.maxTokens),
		headers: dynamicModel.headers ? { ...existingModel.headers, ...dynamicModel.headers } : existingModel.headers,
		compat: dynamicModel.compatConfig ?? existingModel.compatConfig,
		contextPromotionTarget: dynamicModel.contextPromotionTarget ?? existingModel.contextPromotionTarget,
	} as ModelSpec<TApi>);
}

function preferDiscoveryCost(discoveryCost: number, fallbackCost: number): number {
	if (Number.isFinite(discoveryCost) && discoveryCost > 0) {
		return discoveryCost;
	}
	return fallbackCost;
}

function preferDiscoveryName(discoveryName: string, fallbackName: string, modelId: string): string {
	const normalizedDiscoveryName = discoveryName.trim();
	if (normalizedDiscoveryName.length === 0) {
		return fallbackName;
	}
	if (normalizedDiscoveryName === modelId && fallbackName !== modelId) {
		return fallbackName;
	}
	return normalizedDiscoveryName;
}

function preferDiscoveryLimit(discoveryLimit: number, fallbackLimit: number): number;
function preferDiscoveryLimit(discoveryLimit: number | null, fallbackLimit: number | null): number | null;
function preferDiscoveryLimit(discoveryLimit: number | null, fallbackLimit: number | null): number | null {
	if (discoveryLimit === null || !Number.isFinite(discoveryLimit) || discoveryLimit <= 0) {
		return fallbackLimit;
	}
	if (discoveryLimit === 4096 && fallbackLimit !== null && fallbackLimit > discoveryLimit) {
		return fallbackLimit;
	}
	return discoveryLimit;
}

function normalizeModelList<TApi extends Api>(value: unknown): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const models: Model<TApi>[] = [];
	for (const item of value) {
		if (isModelLike(item)) {
			models.push(buildModel(item as ModelSpec<TApi>));
		}
	}
	return models;
}

function isModelLike(value: unknown): value is ModelSpec<Api> {
	if (!isRecord(value)) {
		return false;
	}
	const v = value as {
		id?: unknown;
		name?: unknown;
		api?: unknown;
		provider?: unknown;
		baseUrl?: unknown;
		reasoning?: unknown;
		input?: unknown;
		cost?: unknown;
		contextWindow?: unknown;
		maxTokens?: unknown;
	};
	if (typeof v.id !== "string" || v.id.length === 0) {
		return false;
	}
	if (typeof v.name !== "string" || v.name.length === 0) {
		return false;
	}
	if (typeof v.api !== "string" || v.api.length === 0) {
		return false;
	}
	if (typeof v.provider !== "string" || v.provider.length === 0) {
		return false;
	}
	if (typeof v.baseUrl !== "string" || v.baseUrl.length === 0) {
		return false;
	}
	if (typeof v.reasoning !== "boolean") {
		return false;
	}
	if (!isModelInputArray(v.input)) {
		return false;
	}
	if (!isModelCost(v.cost)) {
		return false;
	}
	// Finite positive: NaN > 0 is false, +Infinity < Infinity is false.
	const cw = v.contextWindow;
	if (cw !== null && (typeof cw !== "number" || !(cw > 0 && cw < Infinity))) {
		return false;
	}
	const mt = v.maxTokens;
	if (mt !== null && (typeof mt !== "number" || !(mt > 0 && mt < Infinity))) {
		return false;
	}
	return true;
}

function isModelInputArray(value: unknown): value is ("text" | "image")[] {
	if (!Array.isArray(value) || value.length === 0) {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (item !== "text" && item !== "image") {
			return false;
		}
	}
	return true;
}

function isModelCost(value: unknown): value is Model<Api>["cost"] {
	if (!isRecord(value)) {
		return false;
	}
	const c = value as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
	};
	// Finite (NaN-safe): -Infinity < x < Infinity rejects NaN and both infinities.
	// Preserves original behavior: 0 and negatives remain valid.
	const ci = c.input;
	if (typeof ci !== "number" || !(ci > -Infinity && ci < Infinity)) {
		return false;
	}
	const co = c.output;
	if (typeof co !== "number" || !(co > -Infinity && co < Infinity)) {
		return false;
	}
	const cr = c.cacheRead;
	if (typeof cr !== "number" || !(cr > -Infinity && cr < Infinity)) {
		return false;
	}
	const cw = c.cacheWrite;
	if (typeof cw !== "number" || !(cw > -Infinity && cw < Infinity)) {
		return false;
	}
	return true;
}
