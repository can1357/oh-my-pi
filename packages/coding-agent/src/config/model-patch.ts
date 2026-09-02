import type { Api, Model, ModelSpec, RemoteCompactionConfig, ThinkingConfig } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isVertexExpressOpenAIUrl } from "@oh-my-pi/pi-catalog/hosts";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { isRecord } from "@oh-my-pi/pi-utils";
import { createLiveConfigHeaders } from "./model-config-values";
import type { ModelOverride } from "./models-config-schema";
/** Provider override config (baseUrl, headers, apiKey, compat, transport) without custom models */
export interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	authHeader?: boolean;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	transport?: Model<Api>["transport"];
	guardrailIdentifier?: Model<Api>["guardrailIdentifier"];
	guardrailVersion?: Model<Api>["guardrailVersion"];
	guardrailTrace?: Model<Api>["guardrailTrace"];
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
 *
 * Merged headers are wrapped in `createLiveConfigHeaders` so `!command`
 * values keep resolving per request on the inference path, matching the
 * `modelOverrides`/`applyModelPatch` behavior — otherwise a discovery
 * provider would send the raw `!command` literal upstream (#10457).
 * See `xiaomi-tp-discovery-merge.test.ts` and the `refresh()` baseUrl-override
 * regression in `model-registry.test.ts`.
 */
export function mergeDiscoveredModel<TApi extends Api>(
	model: Model<TApi>,
	existing: Model<Api> | undefined,
	providerOverride?: Pick<ProviderOverride, "baseUrl" | "compat" | "headers" | "remoteCompaction" | "transport">,
): Model<TApi> {
	if (existing) {
		const supportsTools = model.supportsTools ?? existing.supportsTools;
		return buildModel({
			...toModelSpec(model),
			baseUrl: providerOverride?.baseUrl ?? model.baseUrl ?? existing.baseUrl,
			// providerOverride.headers (raw `!command`) must be the last live
			// source: `model.headers` is a discovery-time resolved snapshot, so
			// without this a rotated credential (401 → cache invalidation) would
			// stay shadowed by the stale snapshot on the inference path (#10458).
			headers: createLiveConfigHeaders([existing.headers, model.headers, providerOverride?.headers]),
			transport: providerOverride?.transport ?? existing.transport ?? model.transport,
			remoteCompaction: mergeProviderRemoteCompactionConfig(
				mergeRemoteCompactionConfig(existing.remoteCompaction, model.remoteCompaction),
				providerOverride?.remoteCompaction,
			),
			...(supportsTools !== undefined ? { supportsTools } : {}),
			compat: mergeCompat(model.compatConfig, providerOverride?.compat),
		} as ModelSpec<TApi>);
	}
	if (providerOverride) {
		return buildModel({
			...toModelSpec(model),
			baseUrl: providerOverride.baseUrl ?? model.baseUrl,
			headers: createLiveConfigHeaders([model.headers, providerOverride.headers]),
			...(providerOverride.transport !== undefined ? { transport: providerOverride.transport } : {}),
			remoteCompaction: mergeProviderRemoteCompactionConfig(
				model.remoteCompaction,
				providerOverride.remoteCompaction,
			),
			compat: mergeCompat(model.compatConfig, providerOverride.compat),
		} as ModelSpec<TApi>);
	}
	return model;
}

export const AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS = new Set<string>(
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

export function providersWithAuthoritativeProjectCatalog(models: readonly Model<Api>[]): Set<string> {
	const providers = new Set<string>();
	for (const model of models) {
		if (isAuthoritativeProjectCatalogModel(model)) {
			providers.add(model.provider);
		}
	}
	return providers;
}

export function dropProviderModels(models: readonly Model<Api>[], providers: ReadonlySet<string>): Model<Api>[] {
	return models.filter(model => !providers.has(model.provider));
}

/**
 * Merge `incoming` entries into a copy of `base`, keyed by `provider`+`id`.
 * Matches are replaced with `combine(existing, entry)`; new entries are
 * appended as `combine(undefined, entry)`.
 */
export function mergeByModelKey<T extends { provider: string; id: string }>(
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
export function mergeCompat<TBase extends object, TOverride extends object>(
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

export function mergeRemoteCompactionConfig(
	baseConfig: RemoteCompactionConfig<Api> | undefined,
	overrideConfig: RemoteCompactionConfig<Api> | undefined,
): RemoteCompactionConfig<Api> | undefined {
	if (!baseConfig) return overrideConfig;
	if (!overrideConfig) return baseConfig;
	return { ...baseConfig, ...overrideConfig };
}

export function mergeProviderRemoteCompactionConfig(
	modelConfig: RemoteCompactionConfig<Api> | undefined,
	providerConfig: RemoteCompactionConfig<Api> | undefined,
): RemoteCompactionConfig<Api> | undefined {
	return mergeRemoteCompactionConfig(providerConfig, modelConfig);
}

/**
 * The patchable subset of `Model` fields shared by `modelOverrides` entries,
 * custom model definitions, and parsed custom-model overlays. `undefined`
 * always means "leave the base value alone".
 */
export interface ModelPatch {
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	imageInputDecoder?: Model<Api>["imageInputDecoder"];
	tokenizer?: Model<Api>["tokenizer"];
	supportsTools?: boolean;
	cost?: Partial<Model<Api>["cost"]>;
	contextWindow?: number;
	maxTokens?: number;
	omitMaxOutputTokens?: boolean;
	/** Whether Codex requests should prefer WebSocket transport. */
	preferWebsockets?: boolean;
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
export function applyModelPatch(base: Model<Api>, patch: ModelPatch, transport: ModelTransportPolicy): Model<Api> {
	const result = { ...base };
	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.thinking !== undefined) result.thinking = patch.thinking;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.tokenizer !== undefined) result.tokenizer = patch.tokenizer;
	if (patch.imageInputDecoder !== undefined) result.imageInputDecoder = patch.imageInputDecoder;
	if (patch.supportsTools !== undefined) result.supportsTools = patch.supportsTools;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.omitMaxOutputTokens !== undefined) result.omitMaxOutputTokens = patch.omitMaxOutputTokens;
	if (patch.preferWebsockets !== undefined) result.preferWebsockets = patch.preferWebsockets;
	if (patch.contextPromotionTarget !== undefined) result.contextPromotionTarget = patch.contextPromotionTarget;
	if (patch.compactionModel !== undefined) result.compactionModel = patch.compactionModel;
	if (patch.remoteCompaction !== undefined) {
		result.remoteCompaction = mergeRemoteCompactionConfig(base.remoteCompaction, patch.remoteCompaction);
	}
	if (patch.premiumMultiplier !== undefined) result.premiumMultiplier = patch.premiumMultiplier;
	if (patch.cost) {
		const longContext = patch.cost.longContext ?? base.cost.longContext;
		result.cost = {
			input: patch.cost.input ?? base.cost.input,
			output: patch.cost.output ?? base.cost.output,
			cacheRead: patch.cost.cacheRead ?? base.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? base.cost.cacheWrite,
			...(longContext ? { longContext } : {}),
		};
	}
	let compat: ModelSpec<Api>["compat"];
	if (transport === "merge") {
		if (patch.headers) {
			// Route merged headers through the live proxy so command-backed (`!cmd`)
			// override values stay re-resolvable — a 401 refresh invalidates their
			// cache and the next request re-runs the command (#9760).
			result.headers = createLiveConfigHeaders([base.headers, patch.headers]);
		}
		compat = mergeCompat(base.compatConfig, patch.compat);
	} else {
		result.headers = patch.headers;
		compat = patch.compat;
	}
	const built = buildModel({ ...toModelSpec(result), compat } as ModelSpec<Api>);
	if (patch.thinking !== undefined && built.thinking !== undefined) {
		// Config-authored capability metadata owns the explicit surface; build
		// first so non-reasoning and wire-disabled models still suppress it.
		built.thinking = patch.thinking;
	}
	// Explicitly patched value fields outrank the engine's reviewed catalog
	// corrections (`limits-patch`/`context-window-floor`/`cost-patch`/
	// `input-modalities`): rebuild first for compat/identity, then re-assert
	// the user-authored values.
	if (patch.contextWindow !== undefined) built.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) built.maxTokens = patch.maxTokens;
	if (patch.input !== undefined) built.input = patch.input;
	if (patch.cost) {
		built.cost = { ...result.cost };
	}
	return built;
}

export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	return applyModelPatch(model, override as ModelPatch, "merge");
}
