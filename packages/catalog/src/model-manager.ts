import { buildModel } from "./build";
import { readModelCache, writeModelCache } from "./model-cache";
import { type GeneratedProvider, getBundledModels } from "./models";
import type { Api, Model, ModelCost, ModelSpec, Provider, TokenCost } from "./types";
import { isRecord } from "./utils";
import { collapseBuiltModelVariants } from "./variant-collapse";

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

/**
 * Controls when dynamic endpoint models should be fetched.
 */
export type ModelRefreshStrategy = "online" | "offline" | "online-if-uncached";

/**
 * Hook for loading and mapping stencil.so fallback data into canonical model objects.
 */
export interface ModelsDevFallback<TApi extends Api = Api, TPayload = unknown> {
	/** Fetches raw fallback payload (for example from stencil.so). */
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
	/** Maximum cache age in milliseconds before considered stale. Default: 2h (`DEFAULT_CACHE_TTL_MS`). */
	cacheTtlMs?: number;
	/** When true, a successful dynamic fetch is the complete provider catalog and prunes static-only models. */
	dynamicModelsAuthoritative?: boolean;
	/** Cached model ids whose presence forces refresh when the static or migration-policy fingerprint changes. */
	dropCachedModelIdsOnStaticMismatch?: readonly string[];
	/**
	 * Trusted, provider-wide request headers that can be safely re-derived at
	 * cache-read time. The cache never persists their values. Models whose live
	 * headers matched this record at write time can survive offline reads without
	 * a bundled static source, including configured discovery providers whose
	 * bearer header comes from the current local config.
	 */
	restorableHeaderFallback?: Record<string, string>;
	/** Optional dynamic endpoint fetcher. */
	fetchDynamicModels?: () => Promise<readonly ModelSpec<TApi>[] | null>;
	/** Optional stencil.so fallback hook. */
	modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;
	/** Clock override for deterministic tests. */
	now?: () => number;
}

/**
 * Resolution result.
 *
 * `stale` is false when the resolved catalog is authoritative for the selected provider:
 * - a dynamic endpoint fetch succeeded in this call (an empty catalog is still
 *   authoritative for the cycle, so downstream pruning of removed models runs),
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
interface CachedHeaderRestoreResult<TApi extends Api> {
	models: Model<TApi>[];
	unresolvedModelIds: ReadonlySet<string>;
}

/**
 * Restore cache-omitted headers from the current static source.
 *
 * A same-id static match is trusted only when the row did not flag the model
 * unrestorable (its live headers matched static when cached). Request-model
 * fallback also honors that marker for current rows. Only legacy rows written
 * before request-model header matching may bypass it: their id-only writer
 * necessarily marked every synthesized variant unrestorable (#6037, #6284).
 * Header-bearing models without a trusted source cannot be reconstructed
 * safely without persisting arbitrary credential values; callers must refetch
 * them online or omit them rather than return a broken model.
 */
function restoreCachedModelHeaders<TApi extends Api>(
	cachedModels: readonly ModelSpec<TApi>[],
	staticModels: readonly Model<TApi>[],
	headerOmittedModelIds: readonly string[],
	unrestorableHeaderModelIds: readonly string[],
	legacyHeaderRestoreMarkers: boolean,
	restorableHeaderFallback: Record<string, string> | undefined,
): CachedHeaderRestoreResult<TApi> {
	const models = passModelList<TApi>(cachedModels);
	if (headerOmittedModelIds.length === 0) {
		return { models, unresolvedModelIds: new Set() };
	}
	const omittedIds = new Set(headerOmittedModelIds);
	const unrestorableIds = new Set(unrestorableHeaderModelIds);
	const staticById = new Map(staticModels.map(model => [model.id, model]));
	const unresolvedModelIds = new Set<string>();
	const restored = models.map(model => {
		if (!omittedIds.has(model.id)) return model;
		const unrestorable = unrestorableIds.has(model.id);
		// Current unrestorable markers prove that neither same-id nor request-model
		// static headers matched the live model. Only the old id-only writer's
		// markers may recover a synthesized variant through `requestModelId`.
		const staticModel = unrestorable
			? legacyHeaderRestoreMarkers && model.requestModelId
				? staticById.get(model.requestModelId)
				: undefined
			: (staticById.get(model.id) ?? (model.requestModelId ? staticById.get(model.requestModelId) : undefined));
		if (!staticModel?.headers) {
			// A non-unrestorable row whose static source is gone was cached with
			// headers matching the provider's trusted constant (e.g. a Copilot
			// model with no bundled entry). Reattach the constant by value instead
			// of dropping the model on this offline read.
			if (!unrestorable && restorableHeaderFallback) {
				return { ...model, headers: { ...restorableHeaderFallback } };
			}
			unresolvedModelIds.add(model.id);
			return model;
		}
		return { ...model, headers: staticModel.headers };
	});
	return { models: restored, unresolvedModelIds };
}

/**
 * Resolves provider models with source precedence:
 * static -> stencil.so -> cache -> dynamic.
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
	const restorableHeaderFallback = options.restorableHeaderFallback;
	const staticModels = options.staticModels
		? passModelList<TApi>(options.staticModels)
		: (getBundledModels(options.providerId as GeneratedProvider) as Model<TApi>[]);
	const cache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
	const restoredCache = restoreCachedModelHeaders(
		cache?.models ?? [],
		staticModels,
		cache?.headerOmittedModelIds ?? [],
		cache?.unrestorableHeaderModelIds ?? [],
		cache?.legacyHeaderRestoreMarkers ?? false,
		restorableHeaderFallback,
	);
	const usableCachedModels = restoredCache.models.filter(model => !restoredCache.unresolvedModelIds.has(model.id));
	const cacheHasUnresolvedHeaders = restoredCache.unresolvedModelIds.size > 0;
	const dynamicModelsAuthoritative = options.dynamicModelsAuthoritative ?? false;
	const cacheDropIds = options.dropCachedModelIdsOnStaticMismatch;
	const staticCatalogFingerprint = fingerprintStatic(staticModels, dynamicModelsAuthoritative);
	// Endpoint-migration policy is cache identity: adding an id must invalidate
	// matching-static-catalog caches written by the prior resolver.
	const staticFingerprint =
		cacheDropIds && cacheDropIds.length > 0
			? `${staticCatalogFingerprint}:drop:${Bun.hash(cacheDropIds.join("\0")).toString(36)}`
			: staticCatalogFingerprint;
	const cacheFingerprintMatches = cache?.staticFingerprint === staticFingerprint && staticFingerprint.length > 0;
	const cacheNeedsModelMigration =
		!cacheFingerprintMatches &&
		cacheDropIds !== undefined &&
		usableCachedModels.some(model => cacheDropIds.includes(model.id));
	const hasUsableFreshCache =
		(cache?.fresh ?? false) &&
		!cacheHasUnresolvedHeaders &&
		!cacheNeedsModelMigration &&
		(!dynamicModelsAuthoritative || cacheFingerprintMatches);
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
	if (
		!shouldFetchFromNetwork &&
		cache?.fresh &&
		hasAuthoritativeCache &&
		cacheFingerprintMatches &&
		!cacheHasUnresolvedHeaders
	) {
		return { models: collapseBuiltModelVariants(restoredCache.models), stale: false };
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
		: prepareCacheModelsForStaticMismatch(
				usableCachedModels,
				staticModels,
				cacheFingerprintMatches,
				options.dropCachedModelIdsOnStaticMismatch,
			);
	const dynamicModels = fetchedDynamicModels ?? [];
	// A successful empty result stays authoritative for THIS cycle (so an
	// intentional catalog emptying still prunes removed models downstream), but
	// is NOT pinned into the cache as authoritative — that would suppress the
	// short retry that recovers a transient empty response (#6620). The two
	// concerns are deliberately separate: result authority vs. cache retry.
	const dynamicCacheAuthoritative = dynamicFetchSucceeded && dynamicModels.length > 0;
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
				dynamicCacheAuthoritative,
				staticFingerprint,
				dbPath,
				staticModels,
				restorableHeaderFallback,
			);
		} else {
			// Dynamic fetch failed — update cache with a non-authoritative snapshot so
			// stale state remains visible while retry backoff still applies.
			const latestCache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
			const latestRestoredCache = restoreCachedModelHeaders(
				latestCache?.models ?? cache?.models ?? [],
				staticModels,
				latestCache?.headerOmittedModelIds ?? cache?.headerOmittedModelIds ?? [],
				latestCache?.unrestorableHeaderModelIds ?? cache?.unrestorableHeaderModelIds ?? [],
				latestCache?.legacyHeaderRestoreMarkers ?? cache?.legacyHeaderRestoreMarkers ?? false,
				restorableHeaderFallback,
			);
			const latestUsableCacheModels = latestRestoredCache.models.filter(
				model => !latestRestoredCache.unresolvedModelIds.has(model.id),
			);
			const fallbackSnapshotModels = collapseBuiltModelVariants(
				mergeDynamicModels(
					mergeModelSources(staticModels, modelsDevModels),
					prepareCacheModelsForStaticMismatch(
						latestUsableCacheModels,
						staticModels,
						cacheFingerprintMatches,
						options.dropCachedModelIdsOnStaticMismatch,
					),
				),
			);
			writeModelCache(
				cacheProviderId,
				now(),
				fallbackSnapshotModels,
				false,
				staticFingerprint,
				dbPath,
				staticModels,
				restorableHeaderFallback,
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

function prepareCacheModelsForStaticMismatch<TApi extends Api>(
	models: readonly Model<TApi>[],
	staticModels: readonly Model<TApi>[],
	cacheFingerprintMatches: boolean,
	ids: readonly string[] | undefined,
): Model<TApi>[] {
	if (models.length === 0) {
		return [];
	}
	if (cacheFingerprintMatches) {
		return [...models];
	}

	const droppedIds = ids && ids.length > 0 ? new Set(ids) : undefined;
	const staticIds = staticModels.length > 0 ? new Set(staticModels.map(model => model.id)) : undefined;
	const sanitizedModels: Model<TApi>[] = [];
	for (const model of models) {
		if (droppedIds?.has(model.id)) {
			continue;
		}
		sanitizedModels.push(staticIds?.has(model.id) ? { ...model, contextWindow: null, maxTokens: null } : model);
	}
	return sanitizedModels;
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
	// capabilities are pinned to another endpoint and no longer apply. Copilot
	// dynamic discovery also pre-applies the correct image fallback for omitted
	// `supports.vision`, so its explicit `false` must not be OR-upgraded by the
	// canonical bundled model.
	// DeepInfra's discovery is authoritative (`dynamicModelsAuthoritative`) and
	// its `vision`/`vlm` tags are the catalog's whole truth for modality. Every
	// row shares the single DeepInfra endpoint, so `endpointChanged` never fires
	// there: without this carve-out a model that dropped those tags would keep
	// the bundled reference's image support and the agent would go on sending
	// images to a now text-only route.
	const endpointChanged = existingModel.baseUrl !== dynamicModel.baseUrl;
	const dynamicInputAuthoritative =
		endpointChanged ||
		(existingModel.provider === "github-copilot" && dynamicModel.provider === "github-copilot") ||
		(existingModel.provider === "deepinfra" && dynamicModel.provider === "deepinfra");
	const supportsImage = dynamicInputAuthoritative
		? dynamicModel.input.includes("image")
		: existingModel.input.includes("image") || dynamicModel.input.includes("image");
	// Synthetic's discovery is authoritative (`dynamicModelsAuthoritative`) and
	// its per-model `reasoning_parameters.efforts` vocabulary is the route's
	// whole truth: when the wire advertises only the `none` off-state the
	// mapper emits `reasoning: false`, and OR-ing the bundled reference's
	// stale `reasoning: true` back would re-arm an effort dial the route
	// doesn't expose. Other providers keep the OR so a bundled reasoning flag
	// survives a discovery row that simply omits the capability.
	const dynamicReasoningAuthoritative =
		existingModel.provider === "synthetic" && dynamicModel.provider === "synthetic";
	const reasoning = dynamicReasoningAuthoritative
		? dynamicModel.reasoning
		: existingModel.reasoning || dynamicModel.reasoning;
	const longContextCost = dynamicModel.cost.longContext ?? existingModel.cost.longContext;
	// Re-build from spec stage: sparse compat comes from `compatConfig` (the
	// verbatim override vocabulary), never the resolved `compat` record.
	return buildModel({
		...existingModel,
		...dynamicModel,
		name: preferDiscoveryName(dynamicModel.name, existingModel.name, dynamicModel.id),
		reasoning,
		input: supportsImage ? ["text", "image"] : ["text"],
		cost: {
			input: preferDiscoveryCost(dynamicModel.cost.input, existingModel.cost.input),
			output: preferDiscoveryCost(dynamicModel.cost.output, existingModel.cost.output),
			cacheRead: preferDiscoveryCost(dynamicModel.cost.cacheRead, existingModel.cost.cacheRead),
			cacheWrite: preferDiscoveryCost(dynamicModel.cost.cacheWrite, existingModel.cost.cacheWrite),
			...(longContextCost ? { longContext: longContextCost } : {}),
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

function isTokenCost(value: unknown): value is TokenCost {
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

function isModelCost(value: unknown): value is ModelCost {
	if (!isTokenCost(value)) return false;
	const longContext = (value as TokenCost & { longContext?: unknown }).longContext;
	if (longContext === undefined) return true;
	if (!isTokenCost(longContext) || !isRecord(longContext)) return false;
	const threshold = longContext.inputThreshold;
	return typeof threshold === "number" && threshold > 0 && threshold < Infinity;
}
