import { VERSION } from "@oh-my-pi/pi-utils";
import { buildModel } from "./build";
import { collapseBuiltVariants } from "./compat/collapse";
import { applyCatalogMetrics, CatalogMetricsIndex } from "./identity/metrics";
import { readModelCache, writeModelCache } from "./model-cache";
import { type GeneratedProvider, getBundledModels } from "./models";
import { isTimeBasedCost } from "./pricing";
import {
	type Api,
	type Model,
	type ModelCost,
	modelKind,
	type ModelSpec,
	type Provider,
	type TokenCost,
} from "./types";
import { isRecord } from "./utils";

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
	/** When true, mapped rows can add model ids but cannot replace static metadata. */
	additiveOnly?: boolean;
}

/**
 * Configuration for provider model resolution.
 */
export interface ModelManagerOptions<TApi extends Api = Api, TModelsDevPayload = unknown> {
	/** Provider id used for static lookup and cache namespacing. */
	providerId: Provider;
	/**
	 * Optional static override. Raw ModelSpec rows are materialized with
	 * `buildModel`; explicitly prebuilt Model rows are consumed as trusted
	 * materializations. When omitted, generator-materialized models.json rows
	 * are consumed directly.
	 */
	staticModels?: readonly (ModelSpec<TApi> | Model<TApi>)[];
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
	/**
	 * Reconstruct omitted request headers from authoritative local configuration
	 * when no trusted static source remains. Return undefined to keep the row
	 * unavailable. This hook must not perform I/O; attach `resolveHeaders` for
	 * command-backed credentials that must wait until an actual request.
	 */
	restoreCachedHeaders?: (model: Readonly<Model>) => Pick<Model, "headers" | "resolveHeaders"> | undefined;
	/** Optional dynamic endpoint fetcher. */
	fetchDynamicModels?: () => Promise<readonly ModelSpec<TApi>[] | null>;
	/** Optional stencil.so fallback hook. */
	modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;
	/** Clock override for deterministic tests. */
	now?: () => number;
}

/**
 * Catalog source that most recently refreshed the resolved provider snapshot.
 */
export type ModelResolutionSource = "bundled" | "cache" | "models.dev" | "provider";

/**
 * Resolution result.
 *
 * `stale` is false when the resolved catalog is authoritative for the selected provider:
 * - a provider endpoint fetch succeeded in this call (an empty catalog is still
 *   authoritative for the cycle, so downstream pruning of removed models runs),
 * - a models.dev fetch succeeded for a provider without endpoint discovery,
 * - a still-fresh authoritative cache was reused in `online-if-uncached` mode, or
 * - the provider has no remote fetcher configured.
 */
export interface ModelResolutionResult<TApi extends Api = Api> {
	models: Model<TApi>[];
	stale: boolean;
	source: ModelResolutionSource;
	updatedAt?: number;
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

function isBuiltModel<TApi extends Api>(value: ModelSpec<TApi> | Model<TApi>): value is Model<TApi> {
	return isRecord(value) && isRecord(value.identity) && typeof value.identity.class === "string";
}

/**
 * Materialize caller-provided raw static specs while preserving explicitly
 * prebuilt override rows. Cache and bundled rows use separate trusted paths.
 */
function materializeStaticModels<TApi extends Api>(value: readonly (ModelSpec<TApi> | Model<TApi>)[]): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: Model<TApi>[] = [];
	for (let index = 0; index < value.length; index++) {
		const item: ModelSpec<TApi> | Model<TApi> = value[index];
		if (item === null || typeof item !== "object" || typeof item.id !== "string") continue;
		out.push(isBuiltModel<TApi>(item) ? item : buildModel(item));
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
	cachedModels: readonly Model<TApi>[],
	staticModels: readonly Model<TApi>[],
	headerOmittedModelIds: readonly string[],
	unrestorableHeaderModelIds: readonly string[],
	legacyHeaderRestoreMarkers: boolean,
	restorableHeaderFallback: Record<string, string> | undefined,
	restoreCachedHeaders: ModelManagerOptions<TApi>["restoreCachedHeaders"],
): CachedHeaderRestoreResult<TApi> {
	if (headerOmittedModelIds.length === 0) {
		return { models: [...cachedModels], unresolvedModelIds: new Set() };
	}
	const omittedIds = new Set(headerOmittedModelIds);
	const unrestorableIds = new Set(unrestorableHeaderModelIds);
	const staticById = new Map(staticModels.map(model => [model.id, model]));
	const unresolvedModelIds = new Set<string>();
	const restored = cachedModels.map(model => {
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
		if (!staticModel?.headers && !staticModel?.resolveHeaders) {
			// A non-unrestorable row whose static source is gone was cached with
			// headers matching the provider's trusted constant (e.g. a Copilot
			// model with no bundled entry). Reattach the constant by value instead
			// of dropping the model on this offline read.
			if (!unrestorable && restorableHeaderFallback) {
				return { ...model, headers: { ...restorableHeaderFallback } };
			}
			const configured = restoreCachedHeaders?.(model);
			if (configured?.headers || configured?.resolveHeaders) return { ...model, ...configured };
			unresolvedModelIds.add(model.id);
			return model;
		}
		return { ...model, headers: staticModel.headers, resolveHeaders: staticModel.resolveHeaders };
	});
	return { models: restored, unresolvedModelIds };
}

/**
 * Resolves provider models with source precedence:
 * static -> cached fallback -> stencil.so -> dynamic.
 *
 * Later sources override earlier ones by model id. Cached rows participate only
 * when at least one configured remote source did not refresh successfully.
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
		? materializeStaticModels<TApi>(options.staticModels)
		: (getBundledModels(options.providerId as GeneratedProvider) as Model<TApi>[]);
	const additiveStaticModelIds =
		options.modelsDev?.additiveOnly && staticModels.length > 0
			? new Set(staticModels.map(model => model.id))
			: undefined;
	const cache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
	const restoredCache = restoreCachedModelHeaders(
		cache?.models ?? [],
		staticModels,
		cache?.headerOmittedModelIds ?? [],
		cache?.unrestorableHeaderModelIds ?? [],
		cache?.legacyHeaderRestoreMarkers ?? false,
		restorableHeaderFallback,
		options.restoreCachedHeaders,
	);
	const usableCachedModels = restoredCache.models.filter(model => !restoredCache.unresolvedModelIds.has(model.id));
	const cacheHasUnresolvedHeaders = restoredCache.unresolvedModelIds.size > 0;
	const dynamicModelsAuthoritative = options.dynamicModelsAuthoritative ?? false;
	const cacheDropIds = options.dropCachedModelIdsOnStaticMismatch;
	const staticCatalogFingerprint = fingerprintStaticModels(staticModels, dynamicModelsAuthoritative);
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
	const hasModelsDevFetcher = options.modelsDev !== undefined;
	const hasRemoteFetcher = hasDynamicFetcher || hasModelsDevFetcher;
	const hasAuthoritativeCache = ((cache?.authoritative ?? false) && hasUsableFreshCache) || !hasRemoteFetcher;
	const cacheAgeMs = cache ? now() - cache.updatedAt : Number.POSITIVE_INFINITY;
	const shouldFetchFromNetwork =
		hasRemoteFetcher && shouldFetchRemoteSources(strategy, hasUsableFreshCache, hasAuthoritativeCache, cacheAgeMs);

	// Cold-start fast path: when a fresh, authoritative cache exists, the network
	// fetch is skipped, AND the static catalog slice is byte-identical to what
	// was merged in last time, the cache row IS the authoritative merge result.
	// Additive shared-catalog caches need same-id rows stripped, but authoritative
	// endpoint caches must not regain bundled IDs absent from the endpoint.
	if (
		!shouldFetchFromNetwork &&
		cache?.fresh &&
		hasAuthoritativeCache &&
		cacheFingerprintMatches &&
		!cacheHasUnresolvedHeaders
	) {
		const cacheContribution =
			additiveStaticModelIds && !dynamicModelsAuthoritative
				? restoredCache.models.filter(model => !additiveStaticModelIds.has(model.id))
				: restoredCache.models;
		const cachedModels =
			additiveStaticModelIds && !dynamicModelsAuthoritative
				? mergeCatalogMetrics(mergeDynamicModels(staticModels, cacheContribution), restoredCache.models)
				: restoredCache.models;
		const source: ModelResolutionSource = cacheContribution.length > 0 ? "cache" : "bundled";
		return {
			models: collapseBuiltVariants(cachedModels),
			stale: false,
			source,
			...(source === "cache" ? { updatedAt: cache.updatedAt } : {}),
		};
	}

	const [fetchedModelsDevModels, fetchedDynamicModels] = shouldFetchFromNetwork
		? await Promise.all([fetchModelsDev(options), dynamicFetcher ? fetchDynamicModels(dynamicFetcher) : null])
		: [null, null];
	const modelsDevFetchSucceeded = fetchedModelsDevModels !== null;
	const normalizedModelsDevModels = fetchedModelsDevModels?.models ?? [];
	const modelsDevModels = additiveStaticModelIds
		? normalizedModelsDevModels.filter(model => !additiveStaticModelIds.has(model.id))
		: normalizedModelsDevModels;
	const shouldUseFreshCacheAsAuthoritative =
		strategy === "online-if-uncached" && hasUsableFreshCache && hasAuthoritativeCache;
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;
	const anyRemoteFetchSucceeded = modelsDevFetchSucceeded || dynamicFetchSucceeded;
	const allConfiguredRemoteFetchesSucceeded =
		hasRemoteFetcher &&
		(!hasModelsDevFetcher || modelsDevFetchSucceeded) &&
		(!hasDynamicFetcher || dynamicFetchSucceeded);
	const authoritativeDynamicFetchSucceeded = dynamicModelsAuthoritative && dynamicFetchSucceeded;
	const remoteResolutionComplete = authoritativeDynamicFetchSucceeded || allConfiguredRemoteFetchesSucceeded;
	const preparedCacheModels = remoteResolutionComplete
		? []
		: prepareCacheModelsForStaticMismatch(
				usableCachedModels,
				staticModels,
				cacheFingerprintMatches,
				options.dropCachedModelIdsOnStaticMismatch,
			);
	// Additive shared-catalog rows may only introduce IDs. Apply that boundary
	// to cache fallback too, including snapshots written by an older binary.
	const cacheModels = additiveStaticModelIds
		? preparedCacheModels.filter(model => !additiveStaticModelIds.has(model.id))
		: preparedCacheModels;
	const dynamicModels = fetchedDynamicModels?.models ?? [];
	// A successful empty endpoint result stays authoritative for THIS cycle (so an
	// intentional catalog emptying still prunes removed models downstream), but
	// is NOT pinned into the cache as authoritative — that would suppress the
	// short retry that recovers a transient empty response (#6620). Shared
	// models.dev snapshots may be empty for one provider and remain authoritative.
	const cacheAuthoritative = hasDynamicFetcher
		? dynamicFetchSucceeded &&
			dynamicModels.length > 0 &&
			(dynamicModelsAuthoritative || !hasModelsDevFetcher || modelsDevFetchSucceeded)
		: modelsDevFetchSucceeded;
	const mergedWithCache = mergeDynamicModels(staticModels, cacheModels);
	const mergedWithModelsDev = mergeDynamicModels(
		mergedWithCache,
		modelsDevModels,
		fetchedModelsDevModels?.explicitKindModels,
	);
	const catalogMetricsSource = modelsDevFetchSucceeded ? normalizedModelsDevModels : preparedCacheModels;
	const mergedWithCatalogMetrics = additiveStaticModelIds
		? mergeCatalogMetrics(mergedWithModelsDev, catalogMetricsSource)
		: mergedWithModelsDev;
	const mergedModels = mergeDynamicModels(
		mergedWithCatalogMetrics,
		dynamicModels,
		fetchedDynamicModels?.explicitKindModels,
	);
	const models = collapseBuiltVariants(
		authoritativeDynamicFetchSucceeded ? retainModelIds(mergedModels, dynamicModels) : mergedModels,
	);
	const resolutionAuthoritative = !hasRemoteFetcher || remoteResolutionComplete || shouldUseFreshCacheAsAuthoritative;
	const remoteUpdatedAt = anyRemoteFetchSucceeded ? now() : undefined;
	if (shouldFetchFromNetwork) {
		if (anyRemoteFetchSucceeded) {
			writeModelCache(
				cacheProviderId,
				remoteUpdatedAt!,
				models,
				cacheAuthoritative,
				staticFingerprint,
				dbPath,
				staticModels,
				restorableHeaderFallback,
			);
		} else {
			// Remote fetch failed. Re-persist any prior catalog as a
			// non-authoritative snapshot so stale state stays visible while the
			// retry backoff applies. When there is no prior cache and nothing to
			// preserve (a discovery-only provider on its first failed fetch), leave
			// the row absent rather than writing an empty snapshot: an empty
			// non-authoritative row reads back as a fresh catalog and suppresses
			// refetch for NON_AUTHORITATIVE_RETRY_MS, hiding every discovery-only
			// model until it ages out. Writing nothing lets the next launch retry
			// immediately (#10964).
			const latestCache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
			const latestRestoredCache = restoreCachedModelHeaders(
				latestCache?.models ?? cache?.models ?? [],
				staticModels,
				latestCache?.headerOmittedModelIds ?? cache?.headerOmittedModelIds ?? [],
				latestCache?.unrestorableHeaderModelIds ?? cache?.unrestorableHeaderModelIds ?? [],
				latestCache?.legacyHeaderRestoreMarkers ?? cache?.legacyHeaderRestoreMarkers ?? false,
				restorableHeaderFallback,
				options.restoreCachedHeaders,
			);
			const latestUsableCacheModels = latestRestoredCache.models.filter(
				model => !latestRestoredCache.unresolvedModelIds.has(model.id),
			);
			const preparedLatestCacheModels = prepareCacheModelsForStaticMismatch(
				latestUsableCacheModels,
				staticModels,
				cacheFingerprintMatches,
				options.dropCachedModelIdsOnStaticMismatch,
			);
			const latestCacheModels = additiveStaticModelIds
				? preparedLatestCacheModels.filter(model => !additiveStaticModelIds.has(model.id))
				: preparedLatestCacheModels;
			const fallbackSnapshotModels = collapseBuiltVariants(
				mergeDynamicModels(mergeDynamicModels(staticModels, latestCacheModels), modelsDevModels),
			);
			if (fallbackSnapshotModels.length > 0 || latestCache !== null || cache !== null) {
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
	}
	const cacheContributed = cacheModels.length > 0;
	const source: ModelResolutionSource = dynamicFetchSucceeded
		? "provider"
		: modelsDevFetchSucceeded
			? "models.dev"
			: cacheContributed
				? "cache"
				: "bundled";
	return {
		models,
		stale: !resolutionAuthoritative,
		source,
		...(remoteUpdatedAt !== undefined
			? { updatedAt: remoteUpdatedAt }
			: cacheContributed && cache
				? { updatedAt: cache.updatedAt }
				: {}),
	};
}

/** Materialized discovery rows plus kind provenance captured before policy can supply a KDL kind. */
interface DiscoveredModelSet<TApi extends Api> {
	models: Model<TApi>[];
	explicitKindModels: ReadonlySet<Model<TApi>>;
}

async function fetchModelsDev<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): Promise<DiscoveredModelSet<TApi> | null> {
	if (!options.modelsDev) {
		return null;
	}

	try {
		const payload = await options.modelsDev.fetch();
		return buildDiscoveredModelSpecs<TApi>(options.modelsDev.map(payload, options.providerId));
	} catch {
		return null;
	}
}

async function fetchDynamicModels<TApi extends Api>(
	fetcher: () => Promise<readonly ModelSpec<TApi>[] | null>,
): Promise<DiscoveredModelSet<TApi> | null> {
	try {
		const models = await fetcher();
		if (models === null) {
			return null;
		}
		return buildDiscoveredModelSpecs<TApi>(models);
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

function mergeCatalogMetrics<TApi extends Api>(
	models: Model<TApi>[],
	catalogModels: readonly Model<TApi>[],
): Model<TApi>[] {
	if (models.length === 0 || catalogModels.length === 0) return models;
	return applyCatalogMetrics(models, new CatalogMetricsIndex(catalogModels));
}

function mergeDynamicModels<TApi extends Api>(
	baseModels: readonly Model<TApi>[],
	dynamicModels: readonly Model<TApi>[],
	explicitKindModels?: ReadonlySet<Model<TApi>>,
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
		// A policy-derived kind on a chat row is not permission to replace an
		// authored runner. Only a kind present before materialization can do so.
		if (modelKind(existingModel) !== "chat" && !explicitKindModels?.has(dynamicModel)) continue;
		merged.set(dynamicModel.id, mergeDynamicModel(existingModel, dynamicModel));
	}
	return Array.from(merged.values());
}

function retainModelIds<TApi extends Api>(
	models: readonly Model<TApi>[],
	retainedModels: readonly Model<TApi>[],
): Model<TApi>[] {
	if (models.length === 0) return [];
	const retainedIds = new Set(retainedModels.map(model => model.id));
	return models.filter(model => modelKind(model) !== "chat" || retainedIds.has(model.id));
}

const MODEL_CACHE_FINGERPRINT_VERSION = `merge-v5:${VERSION}`;

/**
 * Return the versioned content identity for a static provider slice. Callers
 * may mutate or freeze their arrays, so every call observes current content
 * and never attaches a stale sidecar fingerprint to caller-owned data.
 */
export function fingerprintStaticModels<TApi extends Api>(
	models: readonly (ModelSpec<TApi> | Model<TApi>)[],
	dynamicModelsAuthoritative = false,
): string {
	if (models.length === 0) return `${MODEL_CACHE_FINGERPRINT_VERSION}:empty`;
	if (dynamicModelsAuthoritative)
		return `${MODEL_CACHE_FINGERPRINT_VERSION}:authoritative:${fingerprintStaticModels(models)}`;
	return `${MODEL_CACHE_FINGERPRINT_VERSION}:${Bun.hash(JSON.stringify(models)).toString(36)}`;
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
	const timeBasedCost = dynamicModel.cost.timeBased ?? existingModel.cost.timeBased;
	const existingHeaders = existingModel.resolveHeaders ?? existingModel.headers;
	const dynamicHeaders = dynamicModel.resolveHeaders ?? dynamicModel.headers;
	let resolveHeaders = dynamicModel.resolveHeaders ?? existingModel.resolveHeaders;
	if (resolveHeaders && existingHeaders && dynamicHeaders && existingHeaders !== dynamicHeaders) {
		resolveHeaders = async signal => {
			const previous = typeof existingHeaders === "function" ? await existingHeaders(signal) : existingHeaders;
			const next = typeof dynamicHeaders === "function" ? await dynamicHeaders(signal) : dynamicHeaders;
			return { ...previous, ...next };
		};
	}
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
			...(timeBasedCost ? { timeBased: timeBasedCost } : {}),
		},
		contextWindow: preferDiscoveryLimit(dynamicModel.contextWindow, existingModel.contextWindow),
		maxTokens: preferDiscoveryLimit(dynamicModel.maxTokens, existingModel.maxTokens),
		headers: resolveHeaders
			? undefined
			: dynamicModel.headers
				? { ...existingModel.headers, ...dynamicModel.headers }
				: existingModel.headers,
		resolveHeaders,
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

function buildDiscoveredModelSpecs<TApi extends Api>(value: unknown): DiscoveredModelSet<TApi> {
	const models: Model<TApi>[] = [];
	const explicitKindModels = new Set<Model<TApi>>();
	if (!Array.isArray(value)) {
		return { models, explicitKindModels };
	}
	for (const item of value) {
		if (isModelLike(item)) {
			const model = buildModel(item as ModelSpec<TApi>);
			models.push(model);
			if (item.kind !== undefined) explicitKindModels.add(model);
		}
	}
	return { models, explicitKindModels };
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
	const cost = value as TokenCost & { longContext?: unknown; timeBased?: unknown };
	if (cost.timeBased !== undefined && !isTimeBasedCost(cost.timeBased)) return false;
	const longContext = cost.longContext;
	if (longContext === undefined) return true;
	if (!isTokenCost(longContext) || !isRecord(longContext)) return false;
	const threshold = longContext.inputThreshold;
	return typeof threshold === "number" && threshold > 0 && threshold < Infinity;
}
