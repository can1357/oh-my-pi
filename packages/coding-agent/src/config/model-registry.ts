import { execSync } from "node:child_process";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@pk-nerdsaver-ai/pi-ai/api-registry";
import type {
	Api,
	Context,
	Model,
	ModelSpec,
	RemoteCompactionConfig,
	SimpleStreamOptions,
	ThinkingConfig,
} from "@pk-nerdsaver-ai/pi-ai/types";
import type { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { isVertexExpressOpenAIUrl } from "@pk-nerdsaver-ai/pi-catalog/hosts";
import { readModelCache } from "@pk-nerdsaver-ai/pi-catalog/model-cache";
import {
	createModelManager,
	type ModelManagerOptions,
	type ModelRefreshStrategy,
} from "@pk-nerdsaver-ai/pi-catalog/model-manager";
import { getBundledModels, getBundledProviders } from "@pk-nerdsaver-ai/pi-catalog/models";
import {
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
} from "@pk-nerdsaver-ai/pi-catalog/provider-models";
import {
	collapseBuiltModelVariants,
	getVariantAliasSources,
	resolveVariantAlias,
} from "@pk-nerdsaver-ai/pi-catalog/variant-collapse";

const SPECIAL_MODEL_MANAGER_PROVIDER_IDS: readonly string[] = [
	"google-antigravity",
	"google-gemini-cli",
	"openai-codex",
];

const STARTUP_MODEL_CACHE_PROVIDER_IDS: readonly string[] = [
	...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
	...SPECIAL_MODEL_MANAGER_PROVIDER_IDS,
];

// Sentinels for local-only OAuth tokens — declared inline to avoid loading
// provider modules at startup. Must match packages/ai/src/registry/llama-cpp.ts,
// packages/ai/src/registry/lm-studio.ts, and packages/ai/src/registry/vllm.ts.
const LOCAL_PROVIDER_PLACEHOLDERS = new Set<string>(["llama-cpp-local", "lm-studio-local", "vllm-local"]);

import type { ApiKeyResolver, FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { registerOAuthProvider, unregisterOAuthProviders } from "@pk-nerdsaver-ai/pi-ai/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@pk-nerdsaver-ai/pi-ai/oauth/types";
import {
	buildCanonicalModelIndex,
	buildCanonicalModelOrder,
	buildModelProviderPriorityRank,
	type CanonicalModelIndex,
	type CanonicalModelRecord,
	type CanonicalModelVariant,
	type CanonicalVariantPreferences,
	formatCanonicalVariantSelector,
	getBundledCanonicalReferenceData,
	getBundledModelReferenceIndex,
	type ModelEquivalenceConfig,
	resolveCanonicalVariant,
	resolveModelReference,
} from "@pk-nerdsaver-ai/pi-catalog/identity";
import { isBunTestRuntime, isRecord, logger } from "@pk-nerdsaver-ai/pi-utils";
import { parseModelString, resolveProviderModelReference } from "../config/model-resolver";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import type { ConfigError, ConfigFile } from "./config-file";
import {
	DISCOVERY_DEFAULT_MAX_TOKENS,
	type DiscoveryContext,
	type DiscoveryProviderConfig,
	discoverLlamaCppModelContextWindow,
	discoverModelsByProviderType,
	getImplicitOllamaBaseUrl,
	getOllamaContextLengthOverride,
	normalizeLiteLLMDiscoveryBaseUrl,
} from "./model-discovery";
import { ModelsConfigFile, type ProviderValidationModel, validateProviderConfiguration } from "./models-config";
import type { ModelOverride, ModelsConfig, ProviderAuthMode } from "./models-config-schema";
import { settings } from "./settings";

export type { CanonicalModelIndex, CanonicalModelRecord, CanonicalModelVariant, ModelEquivalenceConfig };

export const kNoAuth = "N/A";

export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}

function isDiscoveryBearerApiKey(apiKey: string | undefined | null): apiKey is string {
	return isAuthenticated(apiKey) && !LOCAL_PROVIDER_PLACEHOLDERS.has(apiKey);
}

/** Provider override config (baseUrl, headers, apiKey, compat, transport) without custom models */
interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	authHeader?: boolean;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	transport?: Model<Api>["transport"];
}

/**
 * Merge a freshly discovered model with the matching bundled/configured entry
 * (or a runtime provider override when no bundled entry exists).
 *
 * `baseUrl` resolution priority:
 *   1. User-set `providerOverride.baseUrl` (explicit override in models.json)
 *   2. Discovered baseUrl (xiaomi `tp-` token-plan keys resolve to
 *      `token-plan-sgp.xiaomimimo.com` at discovery time)
 *   3. Existing bundled baseUrl (the host baked into `models.json`)
 *
 * `transport` resolution priority:
 *   1. `providerOverride.transport` (e.g. `pi-native` for auth-gateway users)
 *   2. `existing.transport` (carried over from boot-time override application)
 *   3. `model.transport` (rarely set — discovery defaults omit it)
 *
 * Without (1), the user's override would lose to discovery; without (2)
 * preferred over (3), the bundled `api.xiaomimimo.com` would shadow the
 * tp- token-plan host and produce 401s on the first stream call.
 * Without explicit transport propagation, an openrouter (or any) entry
 * marked `transport: pi-native` in models.yml silently reverts to the
 * default openai-completions transport after the background catalog
 * refresh — so the first `/model` switch after boot hits the raw OpenAI
 * chat-completions URL instead of the gateway's `/v1/pi/stream` (#2555).
 * See `xiaomi-tp-discovery-merge.test.ts` and the `refresh()` baseUrl-override
 * regression in `model-registry.test.ts`.
 */
export function mergeDiscoveredModel<TApi extends Api>(
	model: Model<TApi>,
	existing: Model<Api> | undefined,
	providerOverride?: Pick<ProviderOverride, "baseUrl" | "headers" | "remoteCompaction" | "transport">,
): Model<TApi> {
	if (existing) {
		const supportsTools = model.supportsTools ?? existing.supportsTools;
		return buildModel({
			...model,
			baseUrl: providerOverride?.baseUrl ?? model.baseUrl ?? existing.baseUrl,
			headers: existing.headers ? { ...existing.headers, ...model.headers } : model.headers,
			transport: providerOverride?.transport ?? existing.transport ?? model.transport,
			remoteCompaction: mergeProviderRemoteCompactionConfig(
				mergeRemoteCompactionConfig(existing.remoteCompaction, model.remoteCompaction),
				providerOverride?.remoteCompaction,
			),
			...(supportsTools !== undefined ? { supportsTools } : {}),
			compat: model.compatConfig,
		} as ModelSpec<TApi>);
	}
	if (providerOverride) {
		return buildModel({
			...model,
			baseUrl: providerOverride.baseUrl ?? model.baseUrl,
			headers: providerOverride.headers ? { ...model.headers, ...providerOverride.headers } : model.headers,
			...(providerOverride.transport !== undefined ? { transport: providerOverride.transport } : {}),
			remoteCompaction: mergeProviderRemoteCompactionConfig(
				model.remoteCompaction,
				providerOverride.remoteCompaction,
			),
			compat: model.compatConfig,
		} as ModelSpec<TApi>);
	}
	return model;
}

const AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS = new Set<string>(
	PROVIDER_DESCRIPTORS.filter(descriptor => descriptor.dynamicModelsAuthoritative).map(
		descriptor => descriptor.providerId,
	),
);

function isAuthoritativeProjectCatalogModel(model: Model<Api>): boolean {
	return (
		model.provider === "google-vertex" &&
		model.api === "openai-completions" &&
		isVertexExpressOpenAIUrl(model.baseUrl)
	);
}

function providersWithAuthoritativeProjectCatalog(models: readonly Model<Api>[]): Set<string> {
	const providers = new Set<string>();
	for (const model of models) {
		if (isAuthoritativeProjectCatalogModel(model)) {
			providers.add(model.provider);
		}
	}
	return providers;
}

function dropProviderModels(models: readonly Model<Api>[], providers: ReadonlySet<string>): Model<Api>[] {
	return models.filter(model => !providers.has(model.provider));
}

/**
 * Merge `incoming` entries into a copy of `base`, keyed by `provider`+`id`.
 * Matches are replaced with `combine(existing, entry)`; new entries are
 * appended as `combine(undefined, entry)`.
 */
function mergeByModelKey<T extends { provider: string; id: string }>(
	base: readonly Model<Api>[],
	incoming: readonly T[],
	combine: (existing: Model<Api> | undefined, entry: T) => Model<Api>,
): Model<Api>[] {
	const merged = [...base];
	const indexByKey = new Map<string, number>();
	for (let i = 0; i < merged.length; i += 1) {
		indexByKey.set(`${merged[i].provider}\u0000${merged[i].id}`, i);
	}
	for (const entry of incoming) {
		const key = `${entry.provider}\u0000${entry.id}`;
		const existingIndex = indexByKey.get(key);
		if (existingIndex !== undefined) {
			merged[existingIndex] = combine(merged[existingIndex], entry);
		} else {
			merged.push(combine(undefined, entry));
			indexByKey.set(key, merged.length - 1);
		}
	}
	return merged;
}

interface BuiltInDiscoveryResult {
	models: Model<Api>[];
	authoritativeProviders: Set<string>;
}

export type ProviderDiscoveryStatus = "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";

export interface ProviderDiscoveryState {
	provider: string;
	status: ProviderDiscoveryStatus;
	optional: boolean;
	stale: boolean;
	fetchedAt?: number;
	models: string[];
	error?: string;
}

export interface CanonicalModelQueryOptions {
	availableOnly?: boolean;
	candidates?: readonly Model<Api>[];
}

/** A canonical record (with query-filtered variants) plus the variant model selected for it. */
export interface CanonicalModelSelection {
	record: CanonicalModelRecord;
	model: Model<Api>;
}

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models?: CustomModelOverlay[];
	overrides?: Map<string, ProviderOverride>;
	modelOverrides?: Map<string, Map<string, ModelOverride>>;
	keylessProviders?: Set<string>;
	discoverableProviders?: DiscoveryProviderConfig[];
	configuredProviders?: Set<string>;
	equivalence?: ModelEquivalenceConfig;
	error?: ConfigError;
	found: boolean;
}

const commandValueCache = new Map<string, string>();

function isCommandConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith("!") === true;
}

function resolveCommandConfig(command: string): string | undefined {
	const cached = commandValueCache.get(command);
	if (cached !== undefined) return cached;
	try {
		const stdout = execSync(command, { encoding: "utf8", timeout: 10_000, windowsHide: true });
		const trimmed = stdout.trim();
		if (trimmed.length === 0) return undefined;
		commandValueCache.set(command, trimmed);
		return trimmed;
	} catch {
		return undefined;
	}
}

interface CommandApiKeyResolution {
	configured: boolean;
	value?: string;
}
/**
 * Resolve a models.yml secret/config value to an actual value.
 * `!cmd` runs a shell command and returns trimmed stdout, otherwise env vars are
 * checked first and the input falls back to a literal value.
 */
function resolveConfigValue(valueConfig: string): string | undefined {
	if (valueConfig.startsWith("!")) return resolveCommandConfig(valueConfig.slice(1).trim());
	const envValue = Bun.env[valueConfig];
	if (envValue) return envValue;
	return valueConfig;
}

function resolveConfigHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const next = resolveConfigValue(value);
		if (next) resolved[key] = next;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function extractGoogleOAuthToken(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { token?: unknown };
		if (Object.hasOwn(parsed, "token")) {
			if (typeof parsed.token !== "string") {
				return undefined;
			}
			const token = parsed.token.trim();
			return token.length > 0 ? token : undefined;
		}
	} catch {
		// OAuth values for Google providers are expected to be JSON, but custom setups may already provide raw token.
	}
	return value;
}

function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.getAll()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

function resolveOAuthAccountIdForAccessToken(
	authStorage: AuthStorage,
	provider: string,
	accessToken: string,
): string | undefined {
	const oauthCredentials = getOAuthCredentialsForProvider(authStorage, provider);
	const matchingCredential = oauthCredentials.find(credential => credential.access === accessToken);
	if (matchingCredential) {
		return matchingCredential.accountId;
	}
	if (oauthCredentials.length === 1) {
		return oauthCredentials[0].accountId;
	}
	return undefined;
}

function mergeCompat<TBase extends object, TOverride extends object>(
	baseCompat: TBase | null | undefined,
	overrideCompat: TOverride | null | undefined,
): (TBase & TOverride) | TBase | TOverride | undefined {
	if (!baseCompat) return overrideCompat ?? undefined;
	if (!overrideCompat) return baseCompat;

	const merged: Record<string, unknown> = { ...(baseCompat as Record<string, unknown>) };
	for (const [key, overrideValue] of Object.entries(overrideCompat)) {
		const baseValue = (baseCompat as Record<string, unknown>)[key];
		merged[key] =
			isRecord(baseValue) && isRecord(overrideValue) ? mergeCompat(baseValue, overrideValue) : overrideValue;
	}
	return merged as TBase & TOverride;
}

function mergeRemoteCompactionConfig(
	baseConfig: RemoteCompactionConfig<Api> | undefined,
	overrideConfig: RemoteCompactionConfig<Api> | undefined,
): RemoteCompactionConfig<Api> | undefined {
	if (!baseConfig) return overrideConfig;
	if (!overrideConfig) return baseConfig;
	return { ...baseConfig, ...overrideConfig };
}

function mergeProviderRemoteCompactionConfig(
	modelConfig: RemoteCompactionConfig<Api> | undefined,
	providerConfig: RemoteCompactionConfig<Api> | undefined,
): RemoteCompactionConfig<Api> | undefined {
	return mergeRemoteCompactionConfig(providerConfig, modelConfig);
}

/**
 * Project a built model back to spec shape for the model-manager/cache
 * boundary: sparse compat comes from `compatConfig`, never from the resolved
 * record.
 */
function toModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	return { ...model, compat: model.compatConfig } as ModelSpec<TApi>;
}

/**
 * The patchable subset of `Model` fields shared by `modelOverrides` entries,
 * custom model definitions, and parsed custom-model overlays. `undefined`
 * always means "leave the base value alone".
 */
interface ModelPatch {
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	supportsTools?: boolean;
	cost?: Partial<Model<Api>["cost"]>;
	contextWindow?: number;
	maxTokens?: number;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	contextPromotionTarget?: string;
	compactionModel?: string;
	remoteCompaction?: RemoteCompactionConfig<Api>;
	premiumMultiplier?: number;
}

/**
 * How a patch treats the base model's transport metadata (headers/compat):
 * - `merge`: fold the patch into the base's (modelOverrides semantics).
 * - `replace`: the patch owns transport wholesale — same-id custom definitions
 *   already folded provider-level headers/compat in during parsing, so bundled
 *   transport metadata must not be re-merged (see `#mergeCustomModels`).
 */
type ModelTransportPolicy = "merge" | "replace";

function applyModelPatch(base: Model<Api>, patch: ModelPatch, transport: ModelTransportPolicy): Model<Api> {
	const result = { ...base };
	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.thinking !== undefined) result.thinking = patch.thinking;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.supportsTools !== undefined) result.supportsTools = patch.supportsTools;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.omitMaxOutputTokens !== undefined) result.omitMaxOutputTokens = patch.omitMaxOutputTokens;
	if (patch.contextPromotionTarget !== undefined) result.contextPromotionTarget = patch.contextPromotionTarget;
	if (patch.compactionModel !== undefined) result.compactionModel = patch.compactionModel;
	if (patch.remoteCompaction !== undefined) {
		result.remoteCompaction = mergeRemoteCompactionConfig(base.remoteCompaction, patch.remoteCompaction);
	}
	if (patch.premiumMultiplier !== undefined) result.premiumMultiplier = patch.premiumMultiplier;
	if (patch.cost) {
		result.cost = {
			input: patch.cost.input ?? base.cost.input,
			output: patch.cost.output ?? base.cost.output,
			cacheRead: patch.cost.cacheRead ?? base.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? base.cost.cacheWrite,
		};
	}
	let compat: ModelSpec<Api>["compat"];
	if (transport === "merge") {
		if (patch.headers) {
			result.headers = { ...base.headers, ...patch.headers };
		}
		compat = mergeCompat(base.compatConfig, patch.compat);
	} else {
		result.headers = patch.headers;
		compat = patch.compat;
	}
	return buildModel({ ...result, compat } as ModelSpec<Api>);
}

function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	return applyModelPatch(model, override as ModelPatch, "merge");
}

interface CustomModelDefinitionLike extends ModelPatch {
	id: string;
	api?: Api;
	baseUrl?: string;
	cost?: Model<Api>["cost"];
}

interface CustomModelBuildOptions {
	useDefaults: boolean;
}

interface CustomModelOverlay extends ModelPatch {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	cost?: Model<Api>["cost"];
	isOAuth?: boolean;
}

function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	const resolvedModelHeaders = resolveConfigHeaders(modelHeaders);
	return mergeAuthHeader({ ...providerHeaders, ...resolvedModelHeaders }, authHeader, apiKeyConfig);
}

function mergeAuthHeader(
	headers: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	const nextHeaders = headers && Object.keys(headers).length > 0 ? { ...headers } : undefined;
	if (!authHeader || !apiKeyConfig) {
		return nextHeaders;
	}
	const resolvedKey = resolveConfigValue(apiKeyConfig);
	return resolvedKey ? { ...nextHeaders, Authorization: `Bearer ${resolvedKey}` } : nextHeaders;
}

/**
 * Decide whether a custom-yaml model should force OAuth-style request shaping.
 * - Explicit `auth: oauth` → force on.
 *   endpoints are typically Claude-Code-style proxies (e.g. CLIProxyAPI) that expect
 *   the cloaked request shape regardless of how the proxy itself is authenticated.
 * - Otherwise → unset.
 */
function resolveCustomModelIsOAuth(api: Api, providerAuth: ProviderAuthMode | undefined): boolean | undefined {
	if (providerAuth === "oauth") return true;
	if (providerAuth !== undefined) return undefined;
	if (api === "anthropic-messages") return true;
	return undefined;
}

function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: ModelSpec<Api>["compat"] | undefined,
	providerAuth: ProviderAuthMode | undefined,
	providerRemoteCompaction: RemoteCompactionConfig<Api> | undefined,
	modelDef: CustomModelDefinitionLike,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		name: modelDef.name,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking,
		input: modelDef.input,
		supportsTools: modelDef.supportsTools,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		omitMaxOutputTokens: modelDef.omitMaxOutputTokens,
		headers: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		contextPromotionTarget: modelDef.contextPromotionTarget,
		compactionModel: modelDef.compactionModel,
		remoteCompaction: mergeRemoteCompactionConfig(providerRemoteCompaction, modelDef.remoteCompaction),
		premiumMultiplier: modelDef.premiumMultiplier,
		isOAuth: resolveCustomModelIsOAuth(api, providerAuth),
	};
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.contextWindow !== undefined) {
		return model;
	}
	return { ...model, contextWindow: 1_000_000 };
}

function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const reference = options.useDefaults
		? resolveModelReference(resolvedModel.id, getBundledModelReferenceIndex())
		: undefined;
	const cost =
		resolvedModel.cost ??
		reference?.cost ??
		(options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input = resolvedModel.input ?? reference?.input ?? (options.useDefaults ? ["text"] : undefined);
	const supportsTools = resolvedModel.supportsTools ?? reference?.supportsTools;
	return buildModel({
		id: resolvedModel.id,
		name: resolvedModel.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		reasoning: resolvedModel.reasoning ?? reference?.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: resolvedModel.thinking ?? reference?.thinking,
		input: input as ("text" | "image")[],
		...(supportsTools !== undefined ? { supportsTools } : {}),
		cost,
		contextWindow: resolvedModel.contextWindow ?? reference?.contextWindow ?? (options.useDefaults ? 128000 : null),
		maxTokens: resolvedModel.maxTokens ?? reference?.maxTokens ?? (options.useDefaults ? 16384 : null),
		headers: resolvedModel.headers,
		omitMaxOutputTokens: resolvedModel.omitMaxOutputTokens ?? reference?.omitMaxOutputTokens,
		compat: mergeCompat(reference?.compatConfig, resolvedModel.compat),
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		compactionModel: resolvedModel.compactionModel,
		remoteCompaction: resolvedModel.remoteCompaction,
		premiumMultiplier: resolvedModel.premiumMultiplier,
		isOAuth: resolvedModel.isOAuth,
	} as ModelSpec<Api>);
}

function normalizeSuppressedSelector(
	selector: string,
	hasLiveModel?: (provider: string, id: string) => boolean,
): string {
	const trimmed = selector.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed, {
		allowMaxAlias: true,
		isLiteralModelId: (provider, id) => hasLiveModel?.(provider, id) === true,
	});
	if (!parsed) return trimmed;
	// Retired effort-tier variant ids normalize to their collapsed logical id
	// so persisted suppressions keyed by raw member ids still bind.
	const aliasId = resolveVariantAlias(parsed.provider, parsed.id);
	return `${parsed.provider}/${aliasId ?? parsed.id}`;
}

/**
 * Look up a model's override, falling back to entries keyed by retired
 * effort-tier variant ids (models.yml authored before collapsing). A raw key
 * only re-binds when no live model holds that id.
 */
function resolveModelOverrideWithAliases(
	overrides: Map<string, ModelOverride>,
	model: Model<Api>,
	hasLiveModel: (provider: string, id: string) => boolean,
): ModelOverride | undefined {
	const direct = overrides.get(model.id);
	if (direct) return direct;
	for (const rawId of getVariantAliasSources(model.provider, model.id)) {
		if (hasLiveModel(model.provider, rawId)) continue;
		const remapped = overrides.get(rawId);
		if (remapped) {
			logger.debug("model override re-keyed through variant alias", {
				provider: model.provider,
				from: rawId,
				to: model.id,
			});
			return remapped;
		}
	}
	return undefined;
}

function getDisabledProviderIdsFromSettings(): Set<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

function getConfiguredProviderOrderFromSettings(): string[] {
	try {
		return settings.get("modelProviderOrder");
	} catch {
		return [];
	}
}

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	#models: Model<Api>[] = [];
	#canonicalIndex: CanonicalModelIndex = { records: [], byId: new Map(), bySelector: new Map() };
	#canonicalIndexDirty: boolean = true;
	#customProviderApiKeys: Map<string, string> = new Map();
	#keylessProviders: Set<string> = new Set();
	#discoverableProviders: DiscoveryProviderConfig[] = [];
	#customModelOverlays: CustomModelOverlay[] = [];
	#providerOverrides: Map<string, ProviderOverride> = new Map();
	#modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	#equivalenceConfig: ModelEquivalenceConfig | undefined;
	#configError: ConfigError | undefined = undefined;
	#modelsConfigFile: ConfigFile<ModelsConfig>;
	#lastStaticLoadMtime: number | null = null;
	#registeredProviderSources: Set<string> = new Set();
	#providerDiscoveryStates: Map<string, ProviderDiscoveryState> = new Map();
	#cacheDbPath?: string;
	#suppressedSelectors: Map<string, number> = new Map();
	#backgroundRefresh?: Promise<void>;
	#lastDiscoveryWarnings: Map<string, string> = new Map();
	// Runtime extension model overlays — persist across refresh() cycles so that
	// models registered by extensions survive the model selector's offline reload.
	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();
	// Runtime model managers registered by extensions via fetchDynamicModels.
	// Keyed by provider name; use the same SQLite cache path as builtins.
	#runtimeModelManagers: Map<string, { options: ModelManagerOptions<Api>; sourceId: string }> = new Map();
	#rebuildPending: boolean = false;
	#rebuildSuspended: number = 0;
	#fetch: FetchImpl;

	#resolveCommandBackedApiKey(provider: string): CommandApiKeyResolution {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		if (!isCommandConfigValue(keyConfig)) return { configured: false };
		const value = resolveConfigValue(keyConfig);
		if (value) {
			this.authStorage.setConfigApiKey(provider, value);
			return { configured: true, value };
		}
		this.authStorage.removeConfigApiKey(provider);
		return { configured: true };
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
	 * Sync constructor — eagerly loads bundled + cached models so tests and
	 * synchronous callers see a fully-populated registry immediately. Production
	 * boot paths SHOULD prefer {@link ModelRegistry.create} so the YAML/JSONC
	 * migration step lands off the event loop's hot path before the first
	 * `tryLoad()` runs.
	 */
	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
		options?: { fetch?: FetchImpl },
	) {
		this.#fetch =
			options?.fetch ??
			(isBunTestRuntime()
				? () => Promise.reject(new Error("network disabled in model-registry runtime test"))
				: fetch);
		this.#modelsConfigFile = ModelsConfigFile.relocate(modelsPath);
		this.#cacheDbPath = modelsPath ? path.join(path.dirname(modelsPath), "models.db") : undefined;
		// Set up fallback resolver for custom provider API keys
		this.authStorage.setFallbackResolver(provider => {
			const keyConfig = this.#customProviderApiKeys.get(provider);
			if (!keyConfig) return undefined;
			return resolveConfigValue(keyConfig);
		});
		// Load models synchronously in constructor.
		this.#loadModels();
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	async refresh(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		this.#suspendRebuild();
		try {
			this.#reloadStaticModels();
			this.#suppressedSelectors.clear();
			await this.#refreshRuntimeDiscoveries(strategy);
		} finally {
			this.#resumeRebuild();
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
			});
		this.#backgroundRefresh = refreshPromise;
	}

	async refreshProvider(providerId: string, strategy: ModelRefreshStrategy = "online"): Promise<void> {
		this.#suspendRebuild();
		try {
			this.#reloadStaticModels();
			for (const selector of this.#suppressedSelectors.keys()) {
				if (selector.startsWith(`${providerId}/`)) {
					this.#suppressedSelectors.delete(selector);
				}
			}
			await this.#refreshRuntimeDiscoveries(strategy, new Set([providerId]));
		} finally {
			this.#resumeRebuild();
		}
	}

	/**
	 * Refresh dynamic metadata that can appear only after a local model loads.
	 */
	async refreshSelectedModelMetadata(model: Model<Api>): Promise<Model<Api>> {
		const isLlamaCppDiscovery = this.#discoverableProviders.some(
			providerConfig => providerConfig.provider === model.provider && providerConfig.discovery.type === "llama.cpp",
		);
		if (!isLlamaCppDiscovery) {
			return model;
		}
		const contextWindow = await discoverLlamaCppModelContextWindow(model, this.#nonResolvingDiscoveryContext());
		if (contextWindow === undefined) {
			return this.find(model.provider, model.id) ?? model;
		}
		const current = this.find(model.provider, model.id) ?? model;
		const override = this.#resolveLiveModelOverride(current);
		const customModel = this.#resolveLiveCustomModelOverlay(current);
		const patch: ModelPatch = {};
		if (
			override?.contextWindow === undefined &&
			customModel?.contextWindow === undefined &&
			current.contextWindow !== contextWindow
		) {
			patch.contextWindow = contextWindow;
		}
		const maxTokens = Math.min(contextWindow, DISCOVERY_DEFAULT_MAX_TOKENS);
		if (
			override?.maxTokens === undefined &&
			customModel?.maxTokens === undefined &&
			current.maxTokens !== maxTokens
		) {
			patch.maxTokens = maxTokens;
		}
		if (patch.contextWindow === undefined && patch.maxTokens === undefined) {
			return current;
		}
		const patched = applyModelPatch(current, patch, "merge");
		this.#models = this.#models.map(candidate =>
			candidate.provider === current.provider && candidate.id === current.id ? patched : candidate,
		);
		this.#rebuildCanonicalIndex();
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
		this.#suspendRebuild();
		try {
			await this.#refreshRuntimeDiscoveries(strategy, new Set(this.#runtimeModelManagers.keys()));
		} finally {
			this.#resumeRebuild();
		}
	}

	#reloadStaticModels(): void {
		const currentMtime = this.#modelsConfigFile.getMtimeMs();
		if (currentMtime !== null && currentMtime === this.#lastStaticLoadMtime) {
			// models.json unchanged since last load; reload + canonical rebuild would be redundant.
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
		this.#equivalenceConfig = undefined;
		this.#configError = undefined;
		this.#providerDiscoveryStates.clear();
		this.#loadModels();
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): ConfigError | undefined {
		return this.#configError;
	}

	#loadModels() {
		// Load custom models from models.json first (to know which providers to override)
		const {
			models: customModels = [],
			overrides = new Map(),
			modelOverrides = new Map(),
			keylessProviders = new Set(),
			discoverableProviders = [],
			configuredProviders = new Set(),
			equivalence,
			error: configError,
		} = this.#loadCustomModels();
		this.#configError = configError;
		this.#keylessProviders = keylessProviders;
		this.#discoverableProviders = discoverableProviders;
		this.#customModelOverlays = customModels;
		this.#providerOverrides = overrides;
		this.#modelOverrides = modelOverrides;
		this.#equivalenceConfig = equivalence;

		this.#addImplicitDiscoverableProviders(configuredProviders);
		let builtInModels = this.#applyHardcodedModelPolicies(this.#loadBuiltInModels(overrides));
		const cachedStandardResult = this.#loadCachedStandardProviderModels();
		const cachedStandardModels = this.#applyHardcodedModelPolicies(cachedStandardResult.models);
		const cachedDiscoveries = this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels());
		// Only drop bundled fallback models when the cached project-catalog row is
		// itself fresh AND authoritative. A stale or non-authoritative snapshot
		// (e.g. after ADC discovery failure rewrote the row with authoritative=0)
		// must not strip bundled Vertex Gemini entries — that would leave only the
		// stale project-scoped rows in API-key-only environments.
		const cachedAuthoritativeProviders = new Set<string>();
		for (const provider of providersWithAuthoritativeProjectCatalog(cachedStandardModels)) {
			if (cachedStandardResult.authoritativeFreshProviders.has(provider)) {
				cachedAuthoritativeProviders.add(provider);
			}
		}
		for (const provider of cachedStandardResult.authoritativeFreshProviders) {
			if (AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS.has(provider)) {
				cachedAuthoritativeProviders.add(provider);
			}
		}
		if (cachedAuthoritativeProviders.size > 0) {
			builtInModels = dropProviderModels(builtInModels, cachedAuthoritativeProviders);
		}
		const resolvedDefaults = this.#mergeResolvedModels(
			this.#mergeResolvedModels(builtInModels, cachedStandardModels),
			cachedDiscoveries,
		);
		const withConfigModels = this.#mergeCustomModels(resolvedDefaults, this.#customModelOverlays);
		// Merge runtime extension models so they survive refresh() cycles
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		// Custom/config providers bypass the model-manager merge point —
		// collapse effort-tier variants here so X/X-thinking twins fold.
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltModelVariants(combined), this.#modelOverrides);
		this.#models = this.#applyRuntimeProviderOverrides(withModelOverrides);
		this.#rebuildCanonicalIndex();
		this.#lastStaticLoadMtime = this.#modelsConfigFile.getMtimeMs();
	}

	/** Load built-in models, applying provider-level overrides only.
	 *  Per-model overrides are applied later by #applyModelOverrides. */
	#loadBuiltInModels(overrides: Map<string, ProviderOverride>): Model<Api>[] {
		return getBundledProviders().flatMap(provider => {
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			const providerOverride = overrides.get(provider);

			return models.map(m => {
				if (!providerOverride) return m;
				const withTransportOverride = this.#applyProviderTransportOverride(m, providerOverride);
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

	#resolveStartupModelCacheProviderId(providerId: string): string {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
		if (!descriptor) {
			return providerId;
		}
		const baseUrl =
			this.#runtimeProviderOverrides.get(providerId)?.baseUrl ??
			this.#providerOverrides.get(providerId)?.baseUrl ??
			this.getProviderBaseUrl(providerId);
		return descriptor.createModelManagerOptions({ baseUrl, fetch: this.#fetch }).cacheProviderId ?? providerId;
	}

	#loadCachedStandardProviderModels(): { models: Model<Api>[]; authoritativeFreshProviders: Set<string> } {
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(provider => provider.provider));
		const cachedModels: Model<Api>[] = [];
		const authoritativeFreshProviders = new Set<string>();
		for (const providerId of STARTUP_MODEL_CACHE_PROVIDER_IDS) {
			if (configuredDiscoveryProviders.has(providerId)) {
				continue;
			}
			const cacheProviderId = this.#resolveStartupModelCacheProviderId(providerId);
			const cache = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			if (!cache) {
				continue;
			}
			if (cache.fresh && cache.authoritative) {
				authoritativeFreshProviders.add(providerId);
			}
			const models = cache.models.map(model =>
				model.provider === providerId ? model : { ...model, provider: providerId },
			);
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
			cachedModels.push(...this.#applyProviderModelOverrides(providerId, withCompat));
		}
		return { models: cachedModels, authoritativeFreshProviders };
	}

	#loadCachedDiscoverableModels(): Model<Api>[] {
		const cachedModels: Model<Api>[] = [];
		for (const providerConfig of this.#discoverableProviders) {
			const cache = readModelCache<Api>(
				this.#configuredDiscoveryCacheProviderId(providerConfig),
				24 * 60 * 60 * 1000,
				Date.now,
				this.#cacheDbPath,
			);
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
			const models = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(
						providerConfig.compat,
						cache.models.map(model => buildModel(model)),
					),
				),
			);
			cachedModels.push(...models);
			this.#providerDiscoveryStates.set(providerConfig.provider, {
				provider: providerConfig.provider,
				status: "cached",
				optional: providerConfig.optional ?? false,
				stale: providerConfig.discovery.type === "llama.cpp" || !cache.fresh || !cache.authoritative || configStale,
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
		const disabledProviders = getDisabledProviderIdsFromSettings();
		if (!configuredProviders.has("ollama") && !disabledProviders.has("ollama")) {
			this.#discoverableProviders.push({
				provider: "ollama",
				api: "openai-responses",
				baseUrl: getImplicitOllamaBaseUrl(),
				discovery: { type: "ollama" },
				optional: true,
			});
			this.#keylessProviders.add("ollama");
		}
		if (!configuredProviders.has("llama.cpp") && !disabledProviders.has("llama.cpp")) {
			this.#discoverableProviders.push({
				provider: "llama.cpp",
				api: "openai-responses",
				baseUrl: Bun.env.LLAMA_CPP_BASE_URL || "http://127.0.0.1:8080",
				discovery: { type: "llama.cpp" },
				optional: true,
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
				optional: true,
			});
			this.#keylessProviders.add("lm-studio");
		}
	}

	#loadCustomModels(): CustomModelsResult {
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
			// Always set overrides when baseUrl/headers/apiKey/authHeader/compat/disableStrictTools/transport are present
			if (
				providerConfig.baseUrl ||
				resolvedProviderHeaders ||
				providerConfig.apiKey ||
				providerConfig.authHeader !== undefined ||
				providerConfig.compat ||
				providerConfig.disableStrictTools ||
				providerConfig.remoteCompaction ||
				providerConfig.transport
			) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				overrides.set(providerName, {
					baseUrl:
						providerConfig.discovery?.type === "litellm"
							? normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl)
							: providerConfig.baseUrl,
					headers: resolvedProviderHeaders,
					apiKey: providerConfig.apiKey,
					authHeader: providerConfig.authHeader,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					remoteCompaction: providerConfig.remoteCompaction,
					transport: providerConfig.transport,
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

			// Parse per-model overrides
			if (providerConfig.modelOverrides) {
				const perModel = new Map<string, ModelOverride>();
				for (const [modelId, override] of Object.entries(providerConfig.modelOverrides)) {
					perModel.set(
						modelId,
						override.headers ? { ...override, headers: resolveConfigHeaders(override.headers) } : override,
					);
				}
				allModelOverrides.set(providerName, perModel);
			}
		}

		return {
			models: this.#parseModels(value),
			overrides,
			modelOverrides: allModelOverrides,
			keylessProviders,
			discoverableProviders,
			configuredProviders,
			equivalence: value.equivalence,
			found: true,
		};
	}

	async #refreshRuntimeDiscoveries(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<void> {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const selectedDiscoverableProviders = (
			providerFilter
				? this.#discoverableProviders.filter(provider => providerFilter.has(provider.provider))
				: this.#discoverableProviders
		).filter(provider => !disabledProviders.has(provider.provider));
		const configuredDiscoveriesPromise =
			selectedDiscoverableProviders.length === 0
				? Promise.resolve<Model<Api>[]>([])
				: Promise.all(
						selectedDiscoverableProviders.map(provider => this.#discoverProviderModels(provider, strategy)),
					).then(results => results.flat());
		const [configuredDiscovered, builtInDiscovery] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter),
		]);
		const discovered = [...configuredDiscovered, ...builtInDiscovery.models];
		if (discovered.length === 0 && builtInDiscovery.authoritativeProviders.size === 0) {
			return;
		}
		const discoveredModels = this.#applyHardcodedModelPolicies(
			discovered.map(model =>
				mergeDiscoveredModel(
					model,
					this.find(model.provider, model.id),
					this.#providerOverrides.get(model.provider),
				),
			),
		);
		const authoritativeProviders = providersWithAuthoritativeProjectCatalog(discoveredModels);
		for (const provider of builtInDiscovery.authoritativeProviders) {
			authoritativeProviders.add(provider);
		}
		const baseModels =
			authoritativeProviders.size > 0 ? dropProviderModels(this.#models, authoritativeProviders) : this.#models;
		const resolved = this.#mergeResolvedModels(baseModels, discoveredModels);
		const withConfigModels = this.#mergeCustomModels(resolved, this.#customModelOverlays);
		// Merge runtime extension models so they survive online discovery completion
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltModelVariants(combined), this.#modelOverrides);
		this.#models = this.#applyRuntimeProviderOverrides(withModelOverrides);
		this.#rebuildCanonicalIndex();
	}

	#configuredDiscoveryCacheProviderId(providerConfig: DiscoveryProviderConfig): string {
		if (providerConfig.discovery.type === "openai-models-list") {
			return `${providerConfig.provider}:openai-models-list-context-v2`;
		}
		if (providerConfig.discovery.type === "litellm") {
			return `${providerConfig.provider}:litellm-rich-v1`;
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
		const managerOptions = (await this.#collectBuiltInModelManagerOptions()).filter(opts => {
			if (configuredDiscoveryProviders.has(opts.providerId)) {
				return false;
			}
			return providerFilter ? providerFilter.has(opts.providerId) : true;
		});
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

	async #collectBuiltInModelManagerOptions(): Promise<ModelManagerOptions<Api>[]> {
		const specialProviderDescriptors: Array<{
			providerId: string;
			resolveKey: (value: string | undefined) => string | undefined;
			createOptions: (key: string) => ModelManagerOptions<Api>;
		}> = [
			{
				providerId: "google-antigravity",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleAntigravityModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-antigravity"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "google-gemini-cli",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleGeminiCliModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-gemini-cli"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "openai-codex",
				resolveKey: value => value,
				createOptions: accessToken => {
					const accountId = resolveOAuthAccountIdForAccessToken(this.authStorage, "openai-codex", accessToken);
					return openaiCodexModelManagerOptions({
						accessToken,
						accountId,
					});
				},
			},
		];
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const standardProviderDescriptors = PROVIDER_DESCRIPTORS.filter(
			descriptor => !disabledProviders.has(descriptor.providerId),
		);
		const enabledSpecialProviderDescriptors = specialProviderDescriptors.filter(
			descriptor => !disabledProviders.has(descriptor.providerId),
		);
		// Use peekApiKey to avoid OAuth token refresh during discovery.
		// The token is only needed if the dynamic fetch fires (cache miss),
		// and failures there are handled gracefully.
		const peekKey = (descriptor: { providerId: string }) => this.#peekApiKeyForProvider(descriptor.providerId);
		const [standardProviderKeys, specialKeys] = await Promise.all([
			Promise.all(standardProviderDescriptors.map(peekKey)),
			Promise.all(enabledSpecialProviderDescriptors.map(peekKey)),
		]);
		const options: ModelManagerOptions<Api>[] = [];
		for (let i = 0; i < standardProviderDescriptors.length; i++) {
			const descriptor = standardProviderDescriptors[i];
			const apiKey = standardProviderKeys[i];
			const hasExplicitVllmConfig =
				descriptor.providerId === "vllm" &&
				(this.#runtimeProviderOverrides.has(descriptor.providerId) ||
					this.#providerOverrides.has(descriptor.providerId) ||
					this.#keylessProviders.has(descriptor.providerId));
			if (isAuthenticated(apiKey) || descriptor.allowUnauthenticated || hasExplicitVllmConfig) {
				const discoveryBaseUrl =
					this.#runtimeProviderOverrides.get(descriptor.providerId)?.baseUrl ??
					this.#providerOverrides.get(descriptor.providerId)?.baseUrl ??
					this.getProviderBaseUrl(descriptor.providerId);
				options.push(
					descriptor.createModelManagerOptions({
						apiKey: isDiscoveryBearerApiKey(apiKey) ? apiKey : undefined,
						baseUrl: discoveryBaseUrl,
						fetch: this.#fetch,
					}),
				);
			}
		}

		for (let i = 0; i < enabledSpecialProviderDescriptors.length; i++) {
			const descriptor = enabledSpecialProviderDescriptors[i];
			const key = descriptor.resolveKey(specialKeys[i]);
			if (!isAuthenticated(key)) {
				continue;
			}
			options.push(descriptor.createOptions(key));
		}
		// Append runtime model managers registered by extensions via fetchDynamicModels.
		for (const { options: managerOpts } of this.#runtimeModelManagers.values()) {
			options.push(managerOpts);
		}
		return options;
	}

	async #discoverWithModelManager(
		options: ModelManagerOptions<Api>,
		strategy: ModelRefreshStrategy,
	): Promise<BuiltInDiscoveryResult> {
		try {
			const manager = createModelManager({ ...options, cacheDbPath: this.#cacheDbPath });
			const result = await manager.refresh(strategy);
			const models = result.models.map(model =>
				model.provider === options.providerId ? model : { ...model, provider: options.providerId },
			);
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

	#mergeProviderOverride(baseOverride: ProviderOverride | undefined, override: ProviderOverride): ProviderOverride {
		return {
			baseUrl: override.baseUrl ?? baseOverride?.baseUrl,
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			authHeader: override.authHeader ?? baseOverride?.authHeader,
			headers: override.headers ? { ...(baseOverride?.headers ?? {}), ...override.headers } : baseOverride?.headers,
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
		const headers = mergeAuthHeader(
			override.headers ? { ...entry.headers, ...override.headers } : entry.headers,
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
	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			return this.#applyProviderTransportOverride(model, override);
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
		return models.map(model => {
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

	#rebuildCanonicalIndex(): void {
		if (this.#rebuildSuspended > 0) {
			this.#rebuildPending = true;
			return;
		}
		// Defer the catalog-wide index build to first read. Boot model
		// resolution reads it only when enabledModels or a default-role pattern
		// is configured; the empty interactive launch never reads it pre-paint,
		// so the ~200ms build over the full catalog moves off the first-paint
		// critical path.
		this.#canonicalIndexDirty = true;
		this.#rebuildPending = false;
	}

	#ensureCanonicalIndex(): CanonicalModelIndex {
		if (this.#canonicalIndexDirty) {
			this.#canonicalIndex = logger.time("buildCanonicalModelIndex", () =>
				buildCanonicalModelIndex(this.#models, getBundledCanonicalReferenceData(), this.#equivalenceConfig),
			);
			this.#canonicalIndexDirty = false;
		}
		return this.#canonicalIndex;
	}

	#suspendRebuild(): void {
		this.#rebuildSuspended += 1;
	}

	#resumeRebuild(): void {
		if (this.#rebuildSuspended > 0) {
			this.#rebuildSuspended -= 1;
		}
		if (this.#rebuildSuspended === 0 && this.#rebuildPending) {
			this.#rebuildPending = false;
			this.#canonicalIndexDirty = true;
		}
	}

	#parseModels(config: ModelsConfig): CustomModelOverlay[] {
		const models: CustomModelOverlay[] = [];
		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models
			const resolvedProviderHeaders = resolveConfigHeaders(providerConfig.headers);
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
					resolvedProviderHeaders,
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

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.#models;
	}

	/**
	 * Availability predicate with per-provider memoization. Auth lookups
	 * (`authStorage.hasAuth`) and the disabled-provider set are resolved once
	 * per provider instead of once per model, which matters when filtering the
	 * full bundled catalog (thousands of models, ~50 providers).
	 */
	#createAvailabilityCheck(): (model: Model<Api>) => boolean {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const byProvider = new Map<string, boolean>();
		return model => {
			let available = byProvider.get(model.provider);
			if (available === undefined) {
				available =
					!disabledProviders.has(model.provider) &&
					(this.#keylessProviders.has(model.provider) || this.authStorage.hasAuth(model.provider));
				byProvider.set(model.provider, available);
			}
			return available;
		};
	}

	/**
	 * Build the shared per-query filter state for canonical model queries.
	 * Hoisted out of the per-record loop: building the candidate-selector set
	 * and availability memo once per query instead of once per record is what
	 * keeps `getCanonicalModelSelections` linear instead of O(records × candidates).
	 */
	#canonicalQueryFilters(options: CanonicalModelQueryOptions | undefined): {
		candidateKeys: Set<string> | undefined;
		isAvailable: ((model: Model<Api>) => boolean) | undefined;
	} {
		return {
			candidateKeys: options?.candidates
				? new Set(options.candidates.map(candidate => formatCanonicalVariantSelector(candidate)))
				: undefined,
			isAvailable: options?.availableOnly ? this.#createAvailabilityCheck() : undefined,
		};
	}

	#filterCanonicalVariants(
		record: CanonicalModelRecord,
		candidateKeys: ReadonlySet<string> | undefined,
		isAvailable: ((model: Model<Api>) => boolean) | undefined,
	): CanonicalModelVariant[] {
		return record.variants.filter(variant => {
			if (candidateKeys && !candidateKeys.has(variant.selector)) {
				return false;
			}
			if (isAvailable && !isAvailable(variant.model)) {
				return false;
			}
			return true;
		});
	}

	#variantPreferences(candidates: readonly Model<Api>[]): CanonicalVariantPreferences {
		return {
			modelOrder: buildCanonicalModelOrder(candidates),
			providerRank: buildModelProviderPriorityRank(getConfiguredProviderOrderFromSettings()),
		};
	}

	getCanonicalModels(options?: CanonicalModelQueryOptions): CanonicalModelRecord[] {
		const { candidateKeys, isAvailable } = this.#canonicalQueryFilters(options);
		const records: CanonicalModelRecord[] = [];
		for (const record of this.#ensureCanonicalIndex().records) {
			const variants = this.#filterCanonicalVariants(record, candidateKeys, isAvailable);
			if (variants.length === 0) {
				continue;
			}
			records.push({
				id: record.id,
				name: record.name,
				variants,
			});
		}
		return records;
	}

	/**
	 * One-pass equivalent of `getCanonicalModels` + `resolveCanonicalModel` per
	 * record. The per-query state (candidate-selector set, availability memo,
	 * provider rank, candidate order) is built once, so the whole catalog
	 * resolves in O(records + candidates) instead of O(records × candidates).
	 * This is the path the model selector hydrates from synchronously on open.
	 */
	getCanonicalModelSelections(options?: CanonicalModelQueryOptions): CanonicalModelSelection[] {
		const { candidateKeys, isAvailable } = this.#canonicalQueryFilters(options);
		const candidates = options?.candidates ?? (options?.availableOnly ? this.getAvailable() : this.getAll());
		const preferences = this.#variantPreferences(candidates);
		const selections: CanonicalModelSelection[] = [];
		for (const record of this.#ensureCanonicalIndex().records) {
			const variants = this.#filterCanonicalVariants(record, candidateKeys, isAvailable);
			if (variants.length === 0) {
				continue;
			}
			const resolved = resolveCanonicalVariant(variants, preferences);
			if (!resolved) {
				continue;
			}
			selections.push({
				record: { id: record.id, name: record.name, variants },
				model: resolved.model,
			});
		}
		return selections;
	}

	getCanonicalVariants(canonicalId: string, options?: CanonicalModelQueryOptions): CanonicalModelVariant[] {
		const record = this.#ensureCanonicalIndex().byId.get(canonicalId.trim().toLowerCase());
		if (!record) {
			return [];
		}
		const { candidateKeys, isAvailable } = this.#canonicalQueryFilters(options);
		return this.#filterCanonicalVariants(record, candidateKeys, isAvailable);
	}

	resolveCanonicalModel(canonicalId: string, options?: CanonicalModelQueryOptions): Model<Api> | undefined {
		const variants = this.getCanonicalVariants(canonicalId, options);
		if (variants.length === 0) {
			return undefined;
		}
		const candidates = options?.candidates ?? (options?.availableOnly ? this.getAvailable() : this.getAll());
		return resolveCanonicalVariant(variants, this.#variantPreferences(candidates))?.model;
	}

	getCanonicalId(model: Model<Api>): string | undefined {
		return this.#ensureCanonicalIndex().bySelector.get(formatCanonicalVariantSelector(model).toLowerCase());
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.#models.filter(this.#createAvailabilityCheck());
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
	 * tokens are NOT refreshed (`authStorage.hasAuth`). This is what keeps the
	 * model-switch pre-flight off the event loop's hot path; the real key
	 * (command execution + OAuth refresh) is resolved lazily per request via
	 * {@link ModelRegistry.resolver}.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		const keyConfig = this.#customProviderApiKeys.get(model.provider);
		return (
			isCommandConfigValue(keyConfig) ||
			this.#keylessProviders.has(model.provider) ||
			this.authStorage.hasAuth(model.provider)
		);
	}

	getDiscoverableProviders(): string[] {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		return this.#discoverableProviders
			.filter(provider => !disabledProviders.has(provider.provider))
			.map(provider => provider.provider);
	}

	getProviderDiscoveryState(provider: string): ProviderDiscoveryState | undefined {
		return this.#providerDiscoveryStates.get(provider);
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return resolveProviderModelReference(provider, modelId, this.#models);
	}

	/**
	 * Get the base URL associated with a provider, if any model defines one.
	 */
	getProviderBaseUrl(provider: string): string | undefined {
		return this.#models.find(m => m.provider === provider && m.baseUrl)?.baseUrl;
	}

	/**
	 * Get API key for a model.
	 */
	async getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined> {
		const commandKey = this.#resolveCommandBackedApiKey(model.provider);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(model.provider) && !this.authStorage.hasAuth(model.provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(model.provider, sessionId, { baseUrl: model.baseUrl, modelId: model.id });
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
		const commandKey = this.#resolveCommandBackedApiKey(provider);
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
		this.authStorage.removeConfigApiKey(providerName);
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
		this.#rebuildCanonicalIndex();
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

			// Also update #models immediately for the current cycle
			const nextModels = this.#models.filter(m => m.provider !== providerName);
			for (const overlay of newOverlays) {
				nextModels.push(finalizeCustomModel(overlay, { useDefaults: true }));
			}
			const runtimeTransportOverride = this.#runtimeProviderOverrides.get(providerName);
			const withRuntimeTransportOverride = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyProviderTransportOverride(model, runtimeTransportOverride);
					})
				: nextModels;

			if (config.oauth?.modifyModels) {
				const credential = this.authStorage.getOAuthCredential(providerName);
				if (credential) {
					this.#models = config.oauth.modifyModels(withRuntimeTransportOverride, credential);
					this.#rebuildCanonicalIndex();
					return;
				}
			}

			this.#models = withRuntimeTransportOverride;
			this.#rebuildCanonicalIndex();
			return;
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
					const modelDefs = await fetcher(resolvedKey);
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
			this.#models = this.#models.map(m => {
				if (m.provider !== providerName) return m;
				return this.#applyProviderTransportOverride(m, transportOverride);
			});
			this.#rebuildCanonicalIndex();
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
		headers?: Record<string, string>;
		compat?: ModelSpec<Api>["compat"];
		contextPromotionTarget?: string;
		compactionModel?: string;
		remoteCompaction?: RemoteCompactionConfig<Api>;
		premiumMultiplier?: number;
	}>;
}
