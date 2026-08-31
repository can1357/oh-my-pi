/**
 * Model resolution, scoping, and initial selection.
 *
 * Layering:
 * - `matchModel` is the single matching engine. Order: exact `provider/id`
 *   reference (with variant-alias and OpenRouter routed/date fallbacks) →
 *   exact bare id → retired variant alias → provider-scoped fuzzy → substring
 *   with alias-vs-dated pick.
 * - `parseModelPatternWithContext`/`parseModelPattern` layer the selector
 *   grammar on top: trailing `:level` thinking suffixes (`splitThinkingSuffix`)
 *   and `@upstream` provider routing (`splitUpstreamRouting`).
 * - Everything else (`resolveModelFromString`, `resolveModelOverride*`,
 *   `resolveRoleSelection`, `resolveModelScope`, `resolveCliModel`,
 *   `findSmolModel`/`findSlowModel`) adapts inputs — roles, settings patterns,
 *   CLI flags, scope globs — onto that pipeline.
 */

import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Effort, KnownProvider, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveBareVariantSelector, resolveVariantSelector } from "@oh-my-pi/pi-catalog/compat/collapse";
import { collapseVariantId, stripThinkingVariantSuffix } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { modelMatchesHost } from "@oh-my-pi/pi-catalog/hosts";
import { buildModelProviderPriorityRank } from "@oh-my-pi/pi-catalog/identity";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { type GeneratedProvider, getBundledModels, modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { fuzzyMatch } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
} from "../thinking";
import { isAuthenticated, kNoAuth, type ModelRegistry } from "./model-registry";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	formatModelRoleAlias,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_IDS,
	type ModelRole,
} from "./model-roles";
import type { Settings } from "./settings";

function isKnownProvider(provider: string): provider is KnownProvider {
	return provider in DEFAULT_MODEL_PER_PROVIDER;
}

/**
 * Pick the first provider-default model in availability order.
 *
 * When `hasConcreteCredential` is supplied and at least one available model
 * belongs to a provider with a concrete credential, the candidate pool is
 * restricted to those providers first. This keeps a provider that is merely
 * *ambiently* available — an `amazon-bedrock`/`google-vertex` transport that
 * self-resolves credentials from a stray `~/.aws` profile or Application
 * Default Credentials — from winning the startup default over the provider the
 * user actually signed into (issue #9967). A provider that is the *only*
 * credentialed option is still selected.
 *
 * If multiple providers expose that same default id, rank only that shared-id
 * group by canonical provider priority so native/OAuth transports beat mirrors
 * without changing unrelated provider fallback precedence.
 */
export function pickDefaultAvailableModel(
	availableModels: Model<Api>[],
	hasConcreteCredential?: (provider: string) => boolean,
): Model<Api> | undefined {
	const models =
		hasConcreteCredential === undefined
			? availableModels
			: (() => {
					const concreteAuthByProvider = new Map<string, boolean>();
					const concrete = availableModels.filter(model => {
						const cached = concreteAuthByProvider.get(model.provider);
						if (cached !== undefined) return cached;
						const hasConcreteAuth = hasConcreteCredential(model.provider);
						concreteAuthByProvider.set(model.provider, hasConcreteAuth);
						return hasConcreteAuth;
					});
					return concrete.length > 0 ? concrete : availableModels;
				})();
	const firstDefault = models.find(
		model => isKnownProvider(model.provider) && DEFAULT_MODEL_PER_PROVIDER[model.provider] === model.id,
	);
	if (!firstDefault) return models[0];

	const providerPriority = buildModelProviderPriorityRank();
	const sharedDefaultMatches = models.filter(
		model =>
			model.id === firstDefault.id &&
			isKnownProvider(model.provider) &&
			DEFAULT_MODEL_PER_PROVIDER[model.provider] === model.id,
	);
	return [...sharedDefaultMatches].sort((a, b) => {
		const aRank = providerPriority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = providerPriority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		if (aRank !== bRank) return aRank - bRank;
		return models.indexOf(a) - models.indexOf(b);
	})[0];
}

export interface ScopedModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
}

interface ThinkingSuffixOptions {
	allowMaxSuffix?: boolean;
	allowAutoAlias?: boolean;
}

interface ModelStringParseOptions extends ThinkingSuffixOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}
// Suffix recognition for the model-pattern parser: `:max` is a real thinking
// level and `:auto` maps to the auto sentinel. Both are gated behind flags
// (and the literal-id / exact-match guards on the callers) because real model
// ids end in `:max` (e.g. `glm-4.7:max`) — an ungated split would silently
// reinterpret them as a thinking suffix.
const MAX_THINKING_SUFFIX_OPTIONS: ThinkingSuffixOptions = { allowMaxSuffix: true, allowAutoAlias: true };

function parseThinkingSuffix(value: string, options?: ThinkingSuffixOptions): ConfiguredThinkingLevel | undefined {
	const level = parseThinkingLevel(value);
	if (level === ThinkingLevel.Max) return options?.allowMaxSuffix === true ? level : undefined;
	if (level !== undefined) return level;
	if (options?.allowAutoAlias === true && value === AUTO_THINKING) return AUTO_THINKING;
	return undefined;
}

/**
 * Split a trailing `:<level>` thinking selector off a model pattern.
 *
 * `level` is set when the suffix parses as a concrete thinking level (or, when
 * the caller opts in via `allowMaxSuffix`/`allowAutoAlias`, the guarded `:max`
 * level / `:auto` sentinel); `base` then has the suffix stripped. Otherwise
 * `base` is the input.
 * `minColonIndex` requires the colon to appear strictly after that index —
 * role-alias callers pass the matched alias prefix length.
 */
function splitThinkingSuffix(
	pattern: string,
	minColonIndex = -1,
	options?: ThinkingSuffixOptions,
): { base: string; level?: ConfiguredThinkingLevel } {
	const colonIdx = pattern.lastIndexOf(":");
	if (colonIdx <= minColonIndex) return { base: pattern };
	const level = parseThinkingSuffix(pattern.slice(colonIdx + 1), options);
	return level ? { base: pattern.slice(0, colonIdx), level } : { base: pattern };
}

function matchingGlobModels(pattern: string, availableModels: readonly Model<Api>[]): Model<Api>[] {
	const glob = new Bun.Glob(pattern.toLowerCase());
	return availableModels.filter(model => {
		const fullId = `${model.provider}/${model.id}`;
		return glob.match(fullId.toLowerCase()) || glob.match(model.id.toLowerCase());
	});
}

function resolveGlobScopePattern(
	pattern: string,
	availableModels: readonly Model<Api>[],
): { models: Model<Api>[]; thinkingLevel?: ThinkingLevel; explicitThinkingLevel: boolean } {
	// Glob scopes describe which models are enabled, not per-role thinking.
	// Coerce the `auto` sentinel to a concrete-only view so scope callers stay
	// typed on `ThinkingLevel` and `enabledModels: [\"openai/*:auto\"]` doesn't
	// pin a stray per-model level.
	const strictSuffix = splitThinkingSuffix(pattern);
	if (strictSuffix.level !== undefined) {
		const thinkingLevel = concreteThinkingLevel(strictSuffix.level);
		return {
			models: matchingGlobModels(strictSuffix.base, availableModels),
			thinkingLevel,
			explicitThinkingLevel: thinkingLevel !== undefined,
		};
	}

	const maxSuffix = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (maxSuffix.level !== undefined) {
		const literalMatches = matchingGlobModels(pattern, availableModels);
		if (literalMatches.length > 0) {
			return { models: literalMatches, thinkingLevel: undefined, explicitThinkingLevel: false };
		}
		const thinkingLevel = concreteThinkingLevel(maxSuffix.level);
		return {
			models: matchingGlobModels(maxSuffix.base, availableModels),
			thinkingLevel,
			explicitThinkingLevel: thinkingLevel !== undefined,
		};
	}

	return {
		models: matchingGlobModels(pattern, availableModels),
		thinkingLevel: undefined,
		explicitThinkingLevel: false,
	};
}

/**
 * Parse a model string in "provider/modelId" format.
 * Returns undefined if the format is invalid.
 */
export function parseModelString(
	modelStr: string,
	options?: ModelStringParseOptions,
): { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const id = modelStr.slice(slashIdx + 1);
	const provider = modelStr.slice(0, slashIdx);
	// Strip strict thinking level suffixes first (e.g. "claude-sonnet-4-6:high" -> id "claude-sonnet-4-6", thinkingLevel "high").
	const strict = splitThinkingSuffix(id);
	if (strict.level) return { provider, id: strict.base, thinkingLevel: strict.level };
	// `max` is a real thinking level, but real model IDs can also end in
	// `:max`. Context-aware callers pass a literal lookup so those models win.
	const maxAlias = splitThinkingSuffix(id, -1, options);
	if (maxAlias.level) {
		return options?.isLiteralModelId?.(provider, id) === true
			? { provider, id }
			: { provider, id: maxAlias.base, thinkingLevel: maxAlias.level };
	}
	return { provider, id };
}

/**
 * Format a model as "provider/modelId" string.
 */
export function formatModelString(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function getSingleRoutingOnly(routing: unknown): string | undefined {
	if (!routing || typeof routing !== "object" || !("only" in routing) || !Array.isArray(routing.only)) {
		return undefined;
	}
	if (routing.only.length !== 1) return undefined;
	const upstream = routing.only[0];
	return typeof upstream === "string" && upstream ? upstream : undefined;
}

function getSingleUpstreamRoute(model: Model<Api>): string | undefined {
	const compat = model.compat;
	if (!compat || typeof compat !== "object") return undefined;
	if (modelMatchesHost(model, "vercelAIGateway") && "vercelGatewayRouting" in compat) {
		return getSingleRoutingOnly(compat.vercelGatewayRouting);
	}
	if (modelMatchesHost(model, "openrouter") && "openRouterRouting" in compat) {
		return getSingleRoutingOnly(compat.openRouterRouting);
	}
	return undefined;
}

export function formatModelStringWithRouting(model: Model<Api>): string {
	const selector = formatModelString(model);
	const upstream = getSingleUpstreamRoute(model);
	return upstream ? `${selector}@${upstream}` : selector;
}

export function formatModelSelectorValue(selector: string, thinkingLevel: ConfiguredThinkingLevel | undefined): string {
	return thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit ? `${selector}:${thinkingLevel}` : selector;
}

function getOpenRouterRouteSuffix(modelId: string): { baseId: string; suffix: string } | undefined {
	const colonIdx = modelId.lastIndexOf(":");
	if (colonIdx === -1) {
		return undefined;
	}

	const suffix = modelId.slice(colonIdx + 1).trim();
	// `max` is a thinking-level suffix, never an OpenRouter route suffix, so
	// `openrouter/<id>:max` falls through to the max-aware selector split instead of
	// being cloned into a literal `<id>:max` model id with the reasoning level lost.
	if (!suffix || parseThinkingSuffix(suffix, MAX_THINKING_SUFFIX_OPTIONS)) {
		return undefined;
	}

	return { baseId: modelId.slice(0, colonIdx), suffix };
}

function stripOpenRouterDateSuffix(modelId: string): string | undefined {
	const stripped = modelId.replace(/-\d{8}(?=$|:)/i, "");
	return stripped !== modelId ? stripped : undefined;
}

function getOpenRouterFallbackModelIds(modelId: string): string[] {
	const orderedCandidates: string[] = [];
	const queue = [modelId];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const candidate = queue.shift();
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		orderedCandidates.push(candidate);

		const routedSuffix = getOpenRouterRouteSuffix(candidate);
		if (routedSuffix) {
			queue.push(routedSuffix.baseId);
		}

		const strippedDate = stripOpenRouterDateSuffix(candidate);
		if (strippedDate) {
			queue.push(strippedDate);
		}
	}

	return orderedCandidates;
}

function cloneModelWithRequestedId(model: Model<Api>, requestedId: string): Model<Api> {
	return {
		...model,
		id: requestedId,
		...(model.name === model.id ? { name: requestedId } : {}),
	};
}

const AMAZON_BEDROCK_PROVIDER = "amazon-bedrock";
const BEDROCK_INFERENCE_PROFILE_ARN =
	/^arn:aws(?:-[a-z]+)*:bedrock:[a-z0-9-]+:[0-9]*:(?:application-inference-profile|inference-profile)\/[a-z0-9][a-z0-9._:-]*$/i;

function hasBedrockInferenceProfileThinkingSuffix(modelId: string): boolean {
	const { base, level } = splitThinkingSuffix(modelId);
	return level !== undefined && BEDROCK_INFERENCE_PROFILE_ARN.test(base.trim());
}

function resolveBedrockInferenceProfileModelId(
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const requestedId = modelId.trim();
	if (hasBedrockInferenceProfileThinkingSuffix(requestedId) || !BEDROCK_INFERENCE_PROFILE_ARN.test(requestedId)) {
		return undefined;
	}

	const template = availableModels.find(model => model.provider.toLowerCase() === AMAZON_BEDROCK_PROVIDER);
	if (!template) return undefined;

	return buildModel({
		id: requestedId,
		name: "Bedrock inference profile",
		api: "bedrock-converse-stream",
		provider: AMAZON_BEDROCK_PROVIDER,
		baseUrl: template.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...(template.headers ? { headers: template.headers } : {}),
		...(template.transport !== undefined ? { transport: template.transport } : {}),
		...(template.guardrailIdentifier !== undefined ? { guardrailIdentifier: template.guardrailIdentifier } : {}),
		...(template.guardrailVersion !== undefined ? { guardrailVersion: template.guardrailVersion } : {}),
		...(template.guardrailTrace !== undefined ? { guardrailTrace: template.guardrailTrace } : {}),
	});
}

function resolveBedrockInferenceProfileReference(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	if (provider.toLowerCase() !== AMAZON_BEDROCK_PROVIDER) return undefined;
	return resolveBedrockInferenceProfileModelId(modelId, availableModels);
}

const UPSTREAM_ROUTING_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Split a trailing `@<upstream>` provider-routing selector off a model pattern.
 *
 * `openrouter/z-ai/glm-4.7@cerebras` -> base `openrouter/z-ai/glm-4.7`, upstream
 * `cerebras`. A `:thinking` suffix after the slug is kept on the base
 * (`...@cerebras:high` -> base `...:high`). Returns undefined when there is no
 * `@` or the suffix is not a bare provider slug, so model ids that legitimately
 * contain `@` (`claude-opus-4-8@default`, `workers-ai/@cf/...`) are never split.
 */
export function splitUpstreamRouting(pattern: string): { base: string; upstream: string } | undefined {
	const at = pattern.lastIndexOf("@");
	if (at <= 0) return undefined;
	const rest = pattern.slice(at + 1);
	const colon = rest.indexOf(":");
	const upstream = colon === -1 ? rest : rest.slice(0, colon);
	if (!UPSTREAM_ROUTING_SLUG.test(upstream)) return undefined;
	const trailing = colon === -1 ? "" : rest.slice(colon);
	return { base: pattern.slice(0, at) + trailing, upstream };
}

/** OpenRouter and Vercel AI Gateway are the aggregators that honor per-request upstream routing. */
function supportsUpstreamRouting(model: Model<Api>): boolean {
	return modelMatchesHost(model, "openrouter") || modelMatchesHost(model, "vercelAIGateway");
}

/** Pin a resolved aggregator model to a single upstream provider via its compat routing block. */
function applyUpstreamRouting(model: Model<Api>, upstream: string): Model<Api> {
	const aggregatorModel = model as Model<"openai-completions">;
	const routing = { only: [upstream] };
	return buildModel({
		...model,
		compat: modelMatchesHost(model, "vercelAIGateway")
			? { ...aggregatorModel.compatConfig, vercelGatewayRouting: routing }
			: { ...aggregatorModel.compatConfig, openRouterRouting: routing },
	} as ModelSpec<Api>);
}

const kProviderModelIndex = Symbol("model-resolver.providerIndex");
type ModelsWithProviderIndex = readonly Model<Api>[] & {
	[kProviderModelIndex]?: Map<string, Model<Api> | null>;
};

function getProviderModelIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const tagged = availableModels as ModelsWithProviderIndex;
	const cached = tagged[kProviderModelIndex];
	if (cached) return cached;
	const index = new Map<string, Model<Api> | null>();
	for (const m of availableModels) {
		const key = `${m.provider.toLowerCase()}\u0000${m.id.toLowerCase()}`;
		if (index.has(key)) {
			index.set(key, null); // ambiguous sentinel; do not overwrite back
		} else {
			index.set(key, m);
		}
	}
	tagged[kProviderModelIndex] = index;
	return index;
}

const kProviderWireRouteIndex = Symbol("model-resolver.wireRouteIndex");
type ModelsWithWireRouteIndex = readonly Model<Api>[] & {
	[kProviderWireRouteIndex]?: Map<string, Model<Api> | null>;
};

/**
 * Reverse index over collapsed models' `thinking.effortRouting`:
 * `provider\0wireId` → the logical model that routes to it. Families collapsed
 * at discovery time (Devin's dynamic catalog) carry no hand-table alias, so
 * their raw upstream uids would otherwise be unselectable. Ambiguous wire ids
 * (two logical models routing to one uid) map to the `null` sentinel and
 * resolve to nothing, exactly like the exact-id index.
 */
function getProviderWireRouteIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const tagged = availableModels as ModelsWithWireRouteIndex;
	const cached = tagged[kProviderWireRouteIndex];
	if (cached) return cached;
	const index = new Map<string, Model<Api> | null>();
	for (const m of availableModels) {
		const routing = m.thinking?.effortRouting;
		if (routing === undefined) continue;
		const providerKey = m.provider.toLowerCase();
		for (const effort in routing) {
			const wireId = routing[effort as keyof typeof routing];
			if (wireId === undefined) continue;
			const key = `${providerKey}\u0000${wireId.toLowerCase()}`;
			const existing = index.get(key);
			if (existing === undefined) {
				index.set(key, m);
			} else if (existing !== null && existing !== m) {
				index.set(key, null); // ambiguous sentinel; do not overwrite back
			}
		}
	}
	tagged[kProviderWireRouteIndex] = index;
	return index;
}

export function resolveProviderModelReference(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const normalizedProvider = provider.trim().toLowerCase();
	const normalizedModelId = modelId.trim().toLowerCase();
	if (!normalizedProvider || !normalizedModelId) {
		return undefined;
	}

	const index = getProviderModelIndex(availableModels);
	const exact = index.get(`${normalizedProvider}\u0000${normalizedModelId}`);
	if (exact === null) {
		return undefined; // ambiguous
	}
	if (exact !== undefined) {
		return exact;
	}

	// Retired effort-tier variant ids resolve to their collapsed logical
	// model: hand-table aliases first, then the `X-thinking` → `X` grammar
	// for auto-derived pairs. Exact lookup above always wins while raw is live.
	const collapsedVariant = collapseVariantId(normalizedProvider, normalizedModelId);
	const variantAliasId =
		resolveVariantSelector(normalizedProvider, normalizedModelId) ??
		(collapsedVariant.thinkingVariant ? collapsedVariant.logicalId : undefined);
	if (variantAliasId) {
		const aliased = index.get(`${normalizedProvider}\u0000${variantAliasId.toLowerCase()}`);
		if (aliased) {
			return aliased;
		}
	}

	// Dynamically collapsed families have no hand-table alias: fall back to the
	// per-effort wire ids the live model routes to, so a raw upstream uid still
	// selects its logical model. The exact lookup above keeps a live raw model
	// winning over the collapsed carrier.
	const routed = getProviderWireRouteIndex(availableModels).get(`${normalizedProvider}\u0000${normalizedModelId}`);
	if (routed) {
		return routed;
	}

	const bedrockInferenceProfile = resolveBedrockInferenceProfileReference(provider, modelId, availableModels);
	if (bedrockInferenceProfile) {
		return bedrockInferenceProfile;
	}

	if (normalizedProvider !== "openrouter") {
		return undefined;
	}

	for (const fallbackId of getOpenRouterFallbackModelIds(modelId).slice(1)) {
		const fallback = index.get(`${normalizedProvider}\u0000${fallbackId.toLowerCase()}`);
		if (fallback === null) {
			return undefined;
		}
		if (fallback !== undefined) {
			return cloneModelWithRequestedId(fallback, modelId);
		}
	}

	return undefined;
}

export interface ModelMatchPreferences {
	/** Most-recently-used model keys (provider/modelId) to prefer when ambiguous. */
	usageOrder?: string[];
	/** Provider precedence used for ambiguous unqualified model patterns. */
	providerOrder?: readonly string[];
	/** Providers to deprioritize when no recent usage or provider priority is available. */
	deprioritizeProviders?: string[];
}

export type ModelLookupRegistry = Pick<ModelRegistry, "getAvailable">;
type CliModelRegistry = Pick<ModelRegistry, "getAll" | "getAvailable">;
type InitialModelRegistry = Pick<ModelRegistry, "getAvailable" | "find" | "hasConcreteAuth">;
type RestorableModelRegistry = Pick<ModelRegistry, "getAvailable" | "find" | "getApiKey" | "hasConcreteAuth">;

interface ModelPreferenceContext {
	modelUsageRank: Map<string, number>;
	providerUsageRank: Map<string, number>;
	providerPriorityRank: Map<string, number>;
	deprioritizedProviders: Set<string>;
	modelOrder: Map<string, number>;
}

function buildPreferenceContext(
	availableModels: Model<Api>[],
	preferences: ModelMatchPreferences | undefined,
): ModelPreferenceContext {
	const modelUsageRank = new Map<string, number>();
	const providerUsageRank = new Map<string, number>();
	const usageOrder = preferences?.usageOrder ?? [];
	for (let i = 0; i < usageOrder.length; i += 1) {
		const key = usageOrder[i];
		if (!modelUsageRank.has(key)) {
			modelUsageRank.set(key, i);
		}
		const parsed = parseModelString(key);
		if (parsed && !providerUsageRank.has(parsed.provider)) {
			providerUsageRank.set(parsed.provider, i);
		}
	}
	const providerPriorityRank = buildModelProviderPriorityRank(preferences?.providerOrder);
	const deprioritizedProviders = new Set(preferences?.deprioritizeProviders ?? []);
	const modelOrder = new Map<string, number>();
	for (let i = 0; i < availableModels.length; i += 1) {
		modelOrder.set(formatModelString(availableModels[i]), i);
	}

	return { modelUsageRank, providerUsageRank, providerPriorityRank, deprioritizedProviders, modelOrder };
}

export function getModelMatchPreferences(
	settings?: Partial<Pick<Settings, "get" | "getStorage">>,
): ModelMatchPreferences {
	return {
		usageOrder: settings?.getStorage?.()?.getModelUsageOrder(),
		providerOrder: settings?.get?.("modelProviderOrder"),
	};
}

function mergeModelMatchPreferences(
	settings: Settings | undefined,
	preferences: ModelMatchPreferences | undefined,
): ModelMatchPreferences {
	const settingsPreferences = getModelMatchPreferences(settings);
	return {
		usageOrder: preferences?.usageOrder ?? settingsPreferences.usageOrder,
		providerOrder: preferences?.providerOrder ?? settingsPreferences.providerOrder,
		deprioritizeProviders: preferences?.deprioritizeProviders,
	};
}

function pickPreferredModel(candidates: Model<Api>[], context: ModelPreferenceContext): Model<Api> {
	if (candidates.length <= 1) return candidates[0];
	return [...candidates].sort((a, b) => {
		const aKey = formatModelString(a);
		const bKey = formatModelString(b);
		const aUsage = context.modelUsageRank.get(aKey);
		const bUsage = context.modelUsageRank.get(bKey);
		if (aUsage !== undefined || bUsage !== undefined) {
			return (aUsage ?? Number.POSITIVE_INFINITY) - (bUsage ?? Number.POSITIVE_INFINITY);
		}

		const aProviderPriority = context.providerPriorityRank.get(a.provider.toLowerCase());
		const bProviderPriority = context.providerPriorityRank.get(b.provider.toLowerCase());
		if (aProviderPriority !== undefined || bProviderPriority !== undefined) {
			return (aProviderPriority ?? Number.POSITIVE_INFINITY) - (bProviderPriority ?? Number.POSITIVE_INFINITY);
		}

		const aProviderUsage = context.providerUsageRank.get(a.provider);
		const bProviderUsage = context.providerUsageRank.get(b.provider);
		if (aProviderUsage !== undefined || bProviderUsage !== undefined) {
			return (aProviderUsage ?? Number.POSITIVE_INFINITY) - (bProviderUsage ?? Number.POSITIVE_INFINITY);
		}

		const aDeprioritized = context.deprioritizedProviders.has(a.provider);
		const bDeprioritized = context.deprioritizedProviders.has(b.provider);
		if (aDeprioritized !== bDeprioritized) {
			return aDeprioritized ? 1 : -1;
		}

		const aOrder = context.modelOrder.get(aKey) ?? 0;
		const bOrder = context.modelOrder.get(bKey) ?? 0;
		return aOrder - bOrder;
	})[0];
}

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
	// Check if ID ends with -latest
	if (id.endsWith("-latest")) return true;

	// Check if ID ends with a date pattern (-YYYYMMDD)
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

function includeSyntheticAllowedModels(available: Model<Api>[], allowedModels: Iterable<Model<Api>>): Model<Api>[] {
	const allowedByKey = new Map<string, Model<Api>>();
	for (const model of allowedModels) {
		const key = formatModelString(model);
		if (!allowedByKey.has(key)) {
			allowedByKey.set(key, model);
		}
	}
	if (allowedByKey.size === 0) return [];

	const result: Model<Api>[] = [];
	for (const model of available) {
		if (allowedByKey.delete(formatModelString(model))) {
			result.push(model);
		}
	}

	result.push(...allowedByKey.values());
	return result;
}

/**
 * Provider-lock a raw-id cross match.
 *
 * A slash-prefixed selector like `anthropic/claude-opus-5` is ambiguous: it is
 * both the `anthropic` provider's canonical selector and — verbatim — an
 * OpenRouter aggregator model id. When the named provider genuinely carries
 * that model id in the bundled catalog but the model is missing from the
 * candidate set (provider disabled, no credentials, or filtered out), letting
 * the raw-id fallback re-bind the request onto a different provider's
 * same-named model is a silent, expensive surprise — typically the aggregator's
 * copy (OpenRouter bills published per-token Claude prices). Such a reference
 * is provider-locked: it must fail rather than shadow.
 *
 * The lock only applies when the named provider carries the exact id in the
 * bundled catalog. An aggregator raw id the named provider does NOT carry
 * (e.g. `openai/gpt-4o:extended` — `openai` bundles `gpt-4o`, not the
 * `:extended` variant) is legitimately an aggregator id and keeps resolving
 * through the raw-id fallback, so bare aggregator selectors keep working.
 */
function isProviderLockedCrossMatch(pattern: string, matchedModel: Model<Api>): boolean {
	const slashIdx = pattern.indexOf("/");
	if (slashIdx <= 0) {
		return false;
	}
	const provider = pattern.slice(0, slashIdx).toLowerCase();
	const modelId = pattern.slice(slashIdx + 1).toLowerCase();
	if (matchedModel.provider.toLowerCase() === provider) {
		return false;
	}
	// Case-insensitive on both halves: the surrounding matcher lowercases the
	// selector before comparing ids, so the lock must not evaporate on case
	// variance (catalog provider keys are lowercase; model ids may not be).
	return getBundledModels(provider as GeneratedProvider).some(m => m.id.toLowerCase() === modelId);
}

/**
 * Find an exact explicit provider/model match.
 */
function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			return resolveProviderModelReference(provider, modelId, availableModels);
		}
	}
	return undefined;
}
/**
 * The single model-matching engine. Tries, in order:
 * 1. exact `provider/id` reference (variant-alias and OpenRouter routed/date
 *    fallbacks included),
 * 2. exact bare id (preference-ranked),
 * 3. retired effort-tier variant alias (collapsed catalog entries),
 * 4. provider-scoped fuzzy match,
 * 5. substring match with the alias-vs-dated pick.
 * Returns the matched model or undefined if no match found.
 *
 * `exactOnly` stops after the exact phases (1-3), skipping the fuzzy/substring
 * fallbacks (4-5). Callers use it to resolve the full selector exactly before
 * a trailing `:<level>` thinking suffix is split off, so the suffix can never
 * be fuzzily absorbed into a longer sibling id (e.g. `kimi-for-coding:high`
 * must not match `kimi-for-coding-highspeed`).
 */
function matchModel(
	modelPattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: { exactOnly?: boolean },
): Model<Api> | undefined {
	const exactRefMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactRefMatch) {
		return exactRefMatch;
	}

	// Exact ID match (case-insensitive) — this must happen before provider-scoped
	// fuzzy matching so raw IDs that contain slashes (for example OpenRouter model
	// IDs like "openai/gpt-4o:extended") still resolve as IDs instead of being
	// misread as a provider-qualified selector. A provider-qualified pattern
	// whose named provider carries the id stays locked to that provider when its
	// only exact-id matches live on a different provider (isProviderLockedCrossMatch).
	const lowerPattern = modelPattern.toLowerCase();
	const exactMatches = availableModels.filter(m => m.id.toLowerCase() === lowerPattern);
	if (exactMatches.length > 0) {
		const unlockedMatches = exactMatches.filter(m => !isProviderLockedCrossMatch(modelPattern, m));
		if (unlockedMatches.length > 0) {
			return pickPreferredModel(unlockedMatches, context);
		}
		return undefined;
	}

	const bedrockInferenceProfile = resolveBedrockInferenceProfileModelId(modelPattern, availableModels);
	if (bedrockInferenceProfile) {
		return bedrockInferenceProfile;
	}

	// Retired effort-tier variant ids (bare, no provider prefix) resolve to
	// their collapsed logical model; models from the providers whose table
	// declared the alias win ties. Auto-derived `X-thinking` pairs resolve
	// through the grammar fallback.
	const bareAlias = resolveBareVariantSelector(modelPattern);
	const bareAliasTargetId = bareAlias?.id ?? stripThinkingVariantSuffix(modelPattern);
	if (bareAliasTargetId) {
		const lowerAliasTarget = bareAliasTargetId.toLowerCase();
		const aliasMatches = availableModels.filter(m => m.id.toLowerCase() === lowerAliasTarget);
		if (aliasMatches.length > 0) {
			const preferred = bareAlias ? aliasMatches.filter(m => bareAlias.providers.includes(m.provider)) : [];
			return pickPreferredModel(preferred.length > 0 ? preferred : aliasMatches, context);
		}
	}

	// Exact phases exhausted. Fuzzy/substring fallbacks (below) subsequence-match
	// the whole pattern and would let a trailing `:<level>` thinking suffix bleed
	// into a longer sibling id; callers that still hold an unstripped suffix ask
	// for exact-only so the suffix is split off before any fuzzy attempt.
	if (options?.exactOnly) {
		return undefined;
	}
	// Check for provider/modelId format — fuzzy match within provider only.
	const slashIndex = modelPattern.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelPattern.substring(0, slashIndex);
		const modelId = modelPattern.substring(slashIndex + 1);
		const lowerProvider = provider.toLowerCase();
		const providerModels = availableModels.filter(m => m.provider.toLowerCase() === lowerProvider);
		if (providerModels.length === 0) {
			// The prefix is not a known provider in this candidate set, so treat the
			// slash as part of the raw model ID and continue with generic matching.
		} else {
			// Let the routing fallback apply `@upstream` before fuzzy matching can consume the
			// slug — but only for aggregator providers (OpenRouter / Vercel Gateway). Other
			// providers have ids that legitimately end in `@` (Vertex `claude-opus-4-8@default`),
			// and the fallback never routes them, so they must keep fuzzy matching.
			if (splitUpstreamRouting(modelId) && providerModels.some(supportsUpstreamRouting)) {
				return undefined;
			}
			const scored = providerModels
				.map(model => ({ model, match: fuzzyMatch(modelId, model.id) }))
				.filter(entry => entry.match.matches);
			if (scored.length === 0) {
				return undefined;
			}

			scored.sort((a, b) => {
				if (a.match.score !== b.match.score) return a.match.score - b.match.score;
				const aKey = formatModelString(a.model);
				const bKey = formatModelString(b.model);
				const aUsage = context.modelUsageRank.get(aKey) ?? Number.POSITIVE_INFINITY;
				const bUsage = context.modelUsageRank.get(bKey) ?? Number.POSITIVE_INFINITY;
				if (aUsage !== bUsage) return aUsage - bUsage;

				const aProviderUsage = context.providerUsageRank.get(a.model.provider) ?? Number.POSITIVE_INFINITY;
				const bProviderUsage = context.providerUsageRank.get(b.model.provider) ?? Number.POSITIVE_INFINITY;
				if (aProviderUsage !== bProviderUsage) return aProviderUsage - bProviderUsage;

				const aOrder = context.modelOrder.get(aKey) ?? 0;
				const bOrder = context.modelOrder.get(bKey) ?? 0;
				return aOrder - bOrder;
			});
			return scored[0]?.model;
		}
	}

	// No exact match - fall back to partial matching
	const matches = availableModels.filter(
		m => m.id.toLowerCase().includes(lowerPattern) || m.name?.toLowerCase().includes(lowerPattern),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// Separate into aliases and dated versions
	const aliases = matches.filter(m => isAlias(m.id));
	const datedVersions = matches.filter(m => !isAlias(m.id));

	if (aliases.length > 0) {
		return pickPreferredModel(aliases, context);
	}
	if (datedVersions.length === 0) return undefined;

	if (datedVersions.length === 1) {
		return datedVersions[0];
	}

	const sortedById = [...datedVersions].sort((a, b) => b.id.localeCompare(a.id));
	const topId = sortedById[0]?.id;
	if (!topId) return undefined;
	const topCandidates = sortedById.filter(model => model.id === topId);
	return pickPreferredModel(topCandidates, context);
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** Thinking level if explicitly specified in pattern, undefined otherwise */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Upstream provider slug from an `@upstream` routing selector, if present. */
	upstream?: string;
	warning: string | undefined;
	explicitThinkingLevel: boolean;
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, return it with undefined thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix
 *
 * @internal Exported for testing
 */
function parseModelPatternWithContext(
	pattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	// Exact match on the full pattern first (no fuzzy): a literal id that
	const exactMatch = matchModel(pattern, availableModels, context, { exactOnly: true });
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	// Prefer a fuzzy match whose actual id ends in the suffix, preserving
	// shorthand selectors for literal tier models such as `router:low`. Other
	// fuzzy results (e.g. `kimi-for-coding-highspeed`) cannot absorb the suffix.
	const { base, level } = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (level) {
		const literalSuffixMatch = matchModel(pattern, availableModels, context);
		if (literalSuffixMatch?.id.toLowerCase().endsWith(`:${level}`)) {
			return {
				model: literalSuffixMatch,
				thinkingLevel: undefined,
				warning: undefined,
				explicitThinkingLevel: false,
			};
		}

		// Strip a valid thinking suffix and recurse before accepting any other
		// fuzzy match, so `:<level>` cannot be absorbed into a longer sibling
		// id (e.g. `kimi-for-coding:high` must not match
		// `kimi-for-coding-highspeed`). `max` is accepted only after the exact
		// match above failed, so literal model IDs ending in `:max` keep winning.
		const result = parseModelPatternWithContext(base, availableModels, context, options);
		if (result.model) {
			// Only use this thinking level if no warning from inner recursion
			const explicitThinkingLevel = !result.warning;
			return {
				model: result.model,
				thinkingLevel: explicitThinkingLevel ? level : undefined,
				warning: result.warning,
				explicitThinkingLevel,
			};
		}
		return result;
	}

	// No valid thinking suffix: fall back to fuzzy/substring matching on the
	// whole pattern.
	const fallbackMatch = matchModel(pattern, availableModels, context);
	if (fallbackMatch) {
		return { model: fallbackMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// No colons, pattern simply doesn't match any model
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}
	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	const allowFallback = options?.allowInvalidThinkingSelectorFallback ?? true;
	if (!allowFallback) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	// Invalid suffix - recurse on prefix and warn
	const result = parseModelPatternWithContext(prefix, availableModels, context, options);
	if (result.model) {
		return {
			model: result.model,
			thinkingLevel: undefined,
			warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			explicitThinkingLevel: false,
		};
	}
	return result;
}

/** Match a single pattern with a pre-built preference context (direct match plus
 *  the `@upstream` routing fallback), so role resolution can reuse one context
 *  across every fallback pattern instead of rebuilding it per pattern. */
function matchPatternWithContext(
	pattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	const direct = parseModelPatternWithContext(pattern, availableModels, context, options);
	if (direct.model) return direct;

	// No direct match: a trailing `@upstream` may be a provider-routing selector.
	// Only honor it when the base resolves to an aggregator model (OpenRouter /
	// Vercel Gateway); otherwise `@` stays part of the id and `direct` stands.
	const routing = splitUpstreamRouting(pattern);
	if (routing) {
		const routed = parseModelPatternWithContext(routing.base, availableModels, context, options);
		if (routed.model && supportsUpstreamRouting(routed.model)) {
			return { ...routed, model: applyUpstreamRouting(routed.model, routing.upstream), upstream: routing.upstream };
		}
	}
	return direct;
}

export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	preferences?: ModelMatchPreferences,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	return matchPatternWithContext(
		pattern,
		availableModels,
		buildPreferenceContext(availableModels, preferences),
		options,
	);
}

const DEFAULT_MODEL_ROLE = "default";
const MODEL_ROLE_ALIAS_PREFIXES = [MODEL_ROLE_ALIAS_PREFIX, LEGACY_MODEL_ROLE_ALIAS_PREFIX];

export interface ModelRoleLookup {
	getModelRole(role: ModelRole | string): string | undefined;
}

function isModelRole(role: string): role is ModelRole {
	return (MODEL_ROLE_IDS as string[]).includes(role);
}

/**
 * Minimum colon index for splitting a `:<level>` suffix off a role alias, or
 * `undefined` when `value` is not role-alias shaped. Doubles as the slice
 * offset of the role name for prefixed aliases (`@role`, `pi/role`); the bare
 * `*` default alias returns 0 because its colon sits immediately after the
 * one-character token (`*:xhigh`).
 */
function modelRoleAliasPrefixLength(value: string): number | undefined {
	if (value === DEFAULT_MODEL_ROLE_ALIAS || value.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`)) return 0;
	return MODEL_ROLE_ALIAS_PREFIXES.find(prefix => value.startsWith(prefix))?.length;
}

function getModelRoleAlias(value: string, settings?: ModelRoleLookup): string | undefined {
	const normalized = value.trim();
	const prefixLength = modelRoleAliasPrefixLength(normalized);
	if (prefixLength === undefined) return undefined;

	const candidate = normalized === DEFAULT_MODEL_ROLE_ALIAS ? DEFAULT_MODEL_ROLE : normalized.slice(prefixLength);
	if (isModelRole(candidate) || settings?.getModelRole(candidate) !== undefined) return candidate;
	return undefined;
}

/** Normalize comma-separated or array model selectors into an ordered pattern list. */
export function normalizeModelPatternList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const patterns = Array.isArray(value) ? value.flatMap(pattern => pattern.split(",")) : value.split(",");
	return patterns.map(pattern => pattern.trim()).filter(Boolean);
}

/**
 * Extract the first explicit model-role alias from a raw model selection.
 *
 * This intentionally runs before role expansion so callers can retain the
 * source identity (`@smol`, `pi/slow`, or `*`) even when it resolves to a
 * concrete provider/model or inherited fallback. Bare role names and explicit
 * provider/model selectors are not role aliases.
 */
export function resolveExplicitModelRole(
	value: string | string[] | undefined,
	settings?: ModelRoleLookup,
): string | undefined {
	for (const pattern of normalizeModelPatternList(value)) {
		const prefixLength = modelRoleAliasPrefixLength(pattern);
		if (prefixLength === undefined) continue;
		const { base } = splitThinkingSuffix(pattern, prefixLength, MAX_THINKING_SUFFIX_OPTIONS);
		const role = getModelRoleAlias(base, settings);
		if (role) return role;
	}
	return undefined;
}

function isSessionInheritedAgentPattern(value: string): boolean {
	return (
		value === DEFAULT_MODEL_ROLE ||
		value === formatModelRoleAlias(DEFAULT_MODEL_ROLE) ||
		value === DEFAULT_MODEL_ROLE_ALIAS ||
		value === `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}${DEFAULT_MODEL_ROLE}` ||
		value === formatModelRoleAlias("task") ||
		value === `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}task`
	);
}

function shouldInheritDefaultBeforePriority(role: ModelRole): boolean {
	return role === "smol" || role === "slow" || role === "designer";
}

/**
 * Roles that have no priority.json chain of their own reuse another role's
 * list. The advisor — a second-opinion reviewer — defaults to the `slow`
 * reasoning chain, but (unlike the `slow` role, see
 * {@link shouldInheritDefaultBeforePriority}) never inherits the primary's
 * model, so it stays a distinct strong model out of the box. The `tiny` role —
 * the override for online title/memory/classifier tasks — reuses the `smol`
 * fast chain so an unset tiny role auto-resolves to the same fast model smol
 * would pick.
 */
const ROLE_PRIORITY_ALIAS: Partial<Record<ModelRole, keyof typeof MODEL_PRIO>> = {
	advisor: "slow",
	tiny: "smol",
};

/** Built-in priority patterns for a role, following {@link ROLE_PRIORITY_ALIAS}. */
function rolePriorityDefaults(role: ModelRole): string[] {
	const key = ROLE_PRIORITY_ALIAS[role] ?? (role as keyof typeof MODEL_PRIO);
	return normalizeModelPatternList(MODEL_PRIO[key]);
}

function resolveDefaultInheritedPatterns(
	role: ModelRole,
	configuredDefault: string | undefined,
	roleDefaults: string[],
	settings: ModelRoleLookup | undefined,
	visited: Set<string>,
): string[] {
	if (!shouldInheritDefaultBeforePriority(role) || !configuredDefault) return [];

	const resolved: string[] = [];
	for (const pattern of normalizeModelPatternList(configuredDefault)) {
		const { base: aliasCandidate, level: thinkingLevel } = splitThinkingSuffix(
			pattern,
			modelRoleAliasPrefixLength(pattern) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length,
			MAX_THINKING_SUFFIX_OPTIONS,
		);
		const aliasRole = getModelRoleAlias(aliasCandidate, settings);
		if (aliasRole === role) {
			// Self-alias (e.g. modelRoles.default = "@smol") would loop back to the
			resolved.push(
				...(thinkingLevel
					? roleDefaults.map(defaultPattern => `${defaultPattern}:${thinkingLevel}`)
					: roleDefaults),
			);
			continue;
		}
		if (aliasRole && !visited.has(aliasRole)) {
			// Cross-role alias (e.g. modelRoles.default = "@slow"): resolve the
			// concrete model patterns instead of another role alias.
			const recursed = resolveConfiguredRolePattern(pattern, settings, new Set(visited));
			if (recursed && recursed.length > 0) {
				resolved.push(...recursed);
				continue;
			}
		}
		resolved.push(pattern);
	}
	return resolved;
}

function resolveConfiguredRolePattern(
	value: string,
	settings?: ModelRoleLookup,
	visited: Set<string> = new Set(),
): string[] | undefined {
	const normalized = value.trim();
	if (!normalized) return undefined;

	const { base: aliasCandidate, level: thinkingLevel } = splitThinkingSuffix(
		normalized,
		modelRoleAliasPrefixLength(normalized) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length,
		MAX_THINKING_SUFFIX_OPTIONS,
	);
	const role = getModelRoleAlias(aliasCandidate, settings);
	if (!role) return [normalized];
	if (visited.has(role)) return undefined;
	visited.add(role);

	const configured = settings?.getModelRole(role)?.trim();
	const configuredDefault = settings?.getModelRole(DEFAULT_MODEL_ROLE)?.trim();
	const roleDefaults = isModelRole(role) ? rolePriorityDefaults(role) : [];
	const resolved = configured
		? normalizeModelPatternList(configured)
		: isModelRole(role)
			? resolveDefaultInheritedPatterns(role, configuredDefault, roleDefaults, settings, visited)
			: roleDefaults;
	if (resolved.length === 0) {
		resolved.push(...roleDefaults);
	}
	if (resolved.length === 0) {
		return undefined;
	}

	return thinkingLevel ? resolved.map(pattern => `${pattern}:${thinkingLevel}`) : resolved;
}

/**
 * Expand a role alias like "@smol" to the configured model string.
 */
export function expandRoleAlias(value: string, settings?: ModelRoleLookup): string {
	const normalized = value.trim();
	if (normalized === DEFAULT_MODEL_ROLE) {
		return settings?.getModelRole("default") ?? value;
	}

	const resolved = resolveConfiguredRolePattern(value, settings)?.[0];
	return resolved ?? value;
}

export function resolveConfiguredModelPatterns(
	value: string | string[] | undefined,
	settings?: ModelRoleLookup,
): string[] {
	const patterns = normalizeModelPatternList(value);
	return patterns.flatMap(pattern => {
		const resolved = resolveConfiguredRolePattern(pattern, settings);
		return resolved ?? [];
	});
}
export interface AgentModelPatternResolutionOptions {
	/** Highest-priority request selector, when supplied by a caller. */
	requestModel?: string | string[];
	settingsOverride?: string | string[];
	agentModel?: string | string[];
	settings?: Settings;
	activeModelPattern?: string;
	fallbackModelPattern?: string;
}

interface EffectiveAgentModelSelection {
	source?: string | string[];
	patterns: string[];
}

function resolveEffectiveAgentModelSelection(
	options: AgentModelPatternResolutionOptions,
): EffectiveAgentModelSelection {
	const { requestModel, settingsOverride, agentModel, settings, activeModelPattern, fallbackModelPattern } = options;

	const requestPatterns = resolveConfiguredModelPatterns(requestModel, settings);
	if (requestPatterns.length > 0) {
		return { source: requestModel, patterns: requestPatterns };
	}

	const overridePatterns = resolveConfiguredModelPatterns(settingsOverride, settings);
	if (overridePatterns.length > 0) {
		return { source: settingsOverride, patterns: overridePatterns };
	}

	const normalizedAgentPatterns = normalizeModelPatternList(agentModel);
	const configuredAgentPatterns = resolveConfiguredModelPatterns(agentModel, settings);
	const singleAgentPattern = normalizedAgentPatterns.length === 1 ? normalizedAgentPatterns[0] : undefined;
	const agentInheritsSessionModel = singleAgentPattern ? isSessionInheritedAgentPattern(singleAgentPattern) : false;
	if (configuredAgentPatterns.length > 0) {
		if (
			singleAgentPattern === formatModelRoleAlias("task") ||
			singleAgentPattern === `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}task`
		) {
			return { source: agentModel, patterns: configuredAgentPatterns };
		}
		if (!agentInheritsSessionModel) return { source: agentModel, patterns: configuredAgentPatterns };
	}

	const fallback =
		activeModelPattern?.trim() || fallbackModelPattern?.trim() || settings?.getModelRole("default")?.trim() || "";
	return { patterns: resolveConfiguredModelPatterns(fallback, settings) };
}

/** Effective agent model patterns paired with the pre-expansion role alias behind them. */
export interface AgentModelSelection {
	/** Expanded model patterns to spawn with. */
	patterns: string[];
	/** Role alias the patterns came from (`@task` -> `task`), when the source named one. */
	role: string | undefined;
}

/**
 * Resolve an agent's model patterns together with the role identity they were
 * expanded from. Spawn paths MUST take both from this single call: the child's
 * inherited retry-fallback chain is keyed off the role, which the expansion
 * discards, and deriving the two halves separately is how they drift apart.
 */
export function resolveAgentModelSelection(options: AgentModelPatternResolutionOptions): AgentModelSelection {
	const { source, patterns } = resolveEffectiveAgentModelSelection(options);
	return { patterns, role: resolveExplicitModelRole(source, options.settings) };
}

/** Effective agent model patterns alone, for callers with no interest in role identity. */
export function resolveAgentModelPatterns(options: AgentModelPatternResolutionOptions): string[] {
	return resolveEffectiveAgentModelSelection(options).patterns;
}

/** Default prewalk hand-off target when no explicit target is configured. */
export const DEFAULT_PREWALK_TARGET = "@smol";

export interface AgentPrewalkResolutionOptions {
	/** `task.agentPrewalk` settings value for this agent: `"on"`, `"off"`, or a model pattern. */
	settingsOverride?: string;
	/** Agent definition `prewalk` frontmatter: `true` = default target, string = custom target pattern. */
	agentPrewalk?: boolean | string;
}

/**
 * Effective prewalk target pattern for a subagent, or `undefined` when prewalk
 * is disabled. The settings override decides enablement first ("off" wins,
 * "on" enables with the agent's own target or {@link DEFAULT_PREWALK_TARGET},
 * any other value is a custom target pattern); otherwise the agent
 * definition's `prewalk` field applies. Role aliases in the returned pattern
 * are expanded later by {@link resolveModelOverride}.
 */
export function resolveAgentPrewalkPattern(options: AgentPrewalkResolutionOptions): string | undefined {
	const agentPattern =
		typeof options.agentPrewalk === "string" && options.agentPrewalk.trim() ? options.agentPrewalk.trim() : undefined;
	const override = options.settingsOverride?.trim();
	if (override) {
		const lowered = override.toLowerCase();
		if (lowered === "off" || lowered === "false") return undefined;
		if (lowered === "on" || lowered === "true") return agentPattern ?? DEFAULT_PREWALK_TARGET;
		return override;
	}
	if (options.agentPrewalk === true) return DEFAULT_PREWALK_TARGET;
	return agentPattern;
}

export interface AgentAdvisorResolutionOptions {
	/** `task.agentAdvisor` settings value for this agent: `"on"`, `"off"`, or a model pattern. */
	settingsOverride?: string;
	/** Agent definition `advisor` frontmatter: `true` = default advisor-role model, string = custom model pattern. */
	agentAdvisor?: boolean | string;
}

/** Effective advisor for one spawned agent: absent `model` resolves through the `advisor` role. */
export interface AgentAdvisorSelection {
	model?: string;
}

/**
 * Effective advisor selection for a subagent, or `undefined` when the agent
 * runs unadvised. The settings override decides enablement first ("off" wins,
 * "on" enables with the agent's own model pattern or the `advisor` role, any
 * other value is a custom model pattern); otherwise the agent definition's
 * `advisor` field applies. A returned pattern lands on the spawned session's
 * `modelRoles.advisor`, so role aliases and `:level` suffixes resolve there.
 */
export function resolveAgentAdvisorSelection(
	options: AgentAdvisorResolutionOptions,
): AgentAdvisorSelection | undefined {
	const agentPattern =
		typeof options.agentAdvisor === "string" && options.agentAdvisor.trim() ? options.agentAdvisor.trim() : undefined;
	const override = options.settingsOverride?.trim();
	if (override) {
		const lowered = override.toLowerCase();
		if (lowered === "off" || lowered === "false") return undefined;
		if (lowered === "on" || lowered === "true") return { model: agentPattern };
		return { model: override };
	}
	if (options.agentAdvisor === true) return {};
	return agentPattern ? { model: agentPattern } : undefined;
}

/**
 * Resolve a model role value into a concrete model and thinking metadata.
 */
export interface ResolvedModelRoleValue {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** matchedPatternIndex identifies the first configured pattern that matched an available model. */
	matchedPatternIndex?: number;
	explicitThinkingLevel: boolean;
	warning: string | undefined;
}

export function resolveModelRoleValue(
	roleValue: string | undefined,
	availableModels: Model<Api>[],
	options?: { settings?: Settings; roleLookup?: ModelRoleLookup; matchPreferences?: ModelMatchPreferences },
): ResolvedModelRoleValue {
	if (!roleValue) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	const normalized = roleValue.trim();
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	const effectivePatterns = resolveConfiguredModelPatterns(normalized, options?.roleLookup ?? options?.settings);
	if (!effectivePatterns || effectivePatterns.length === 0) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	let warning: string | undefined;
	const matchPreferences = mergeModelMatchPreferences(options?.settings, options?.matchPreferences);
	// Build the O(n) preference context (model-order map over all available
	// models) once and reuse it across every fallback pattern instead of
	// rebuilding it per pattern inside parseModelPattern.
	const preferenceContext = buildPreferenceContext(availableModels, matchPreferences);
	for (const [patternIndex, effectivePattern] of effectivePatterns.entries()) {
		const resolved = matchPatternWithContext(effectivePattern, availableModels, preferenceContext);
		if (resolved.model) {
			return {
				model: resolved.model,
				matchedPatternIndex: patternIndex,
				thinkingLevel: resolved.explicitThinkingLevel
					? resolved.thinkingLevel === AUTO_THINKING
						? AUTO_THINKING
						: (resolveThinkingLevelForModel(resolved.model, resolved.thinkingLevel) ?? resolved.thinkingLevel)
					: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
				warning: resolved.warning,
			};
		}
		if (!warning && resolved.warning) {
			warning = resolved.warning;
		}
	}

	return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning };
}

interface ExplicitThinkingSelectorOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}

function isLiteralModelSelector(value: string, options?: ExplicitThinkingSelectorOptions): boolean {
	const parsed = parseModelString(value);
	return parsed !== undefined && options?.isLiteralModelId?.(parsed.provider, parsed.id) === true;
}

export function extractExplicitThinkingSelector(
	value: string | undefined,
	settings?: Settings,
	options?: ExplicitThinkingSelectorOptions,
): ConfiguredThinkingLevel | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) return undefined;

	const visited = new Set<string>();
	let current = normalized;
	while (!visited.has(current)) {
		visited.add(current);
		const rolePrefixLength = modelRoleAliasPrefixLength(current) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length;
		const strictSelector = splitThinkingSuffix(current, rolePrefixLength).level;
		if (strictSelector) {
			return strictSelector;
		}
		const maxSelector = splitThinkingSuffix(current, rolePrefixLength, MAX_THINKING_SUFFIX_OPTIONS).level;
		if (
			maxSelector &&
			(modelRoleAliasPrefixLength(current) !== undefined || !isLiteralModelSelector(current, options))
		) {
			return maxSelector;
		}
		const expanded = expandRoleAlias(current, settings).trim();
		if (!expanded || expanded === current) break;
		if (expanded === DEFAULT_MODEL_ROLE) return undefined;
		current = expanded;
	}

	return undefined;
}

/**
 * Resolve a model identifier or pattern to a Model instance.
 */
export function resolveModelFromString(
	value: string,
	available: Model<Api>[],
	matchPreferences?: ModelMatchPreferences,
): Model<Api> | undefined {
	const exact = available.find(model => `${model.provider}/${model.id}` === value);
	if (exact) return exact;
	const parsed = parseModelString(value, {
		...MAX_THINKING_SUFFIX_OPTIONS,
		isLiteralModelId: (provider, id) => available.some(model => model.provider === provider && model.id === id),
	});
	if (parsed) {
		const parsedExact = available.find(model => model.provider === parsed.provider && model.id === parsed.id);
		if (parsedExact) return parsedExact;
	}
	return parseModelPattern(value, available, matchPreferences).model;
}

/**
 * Resolve a model from configured roles, honoring order and overrides.
 */
export function resolveModelFromSettings(options: {
	settings: Settings;
	availableModels: Model<Api>[];
	matchPreferences?: ModelMatchPreferences;
	roleOrder?: readonly ModelRole[];
}): Model<Api> | undefined {
	const { settings, availableModels, matchPreferences, roleOrder } = options;
	const roles = roleOrder ?? MODEL_ROLE_IDS;
	let sawConfiguredProviderQualifiedRole = false;
	for (const role of roles) {
		const configured = settings.getModelRole(role);
		if (!configured) continue;
		const expanded = expandRoleAlias(configured, settings).trim();
		if (expanded.includes("/")) {
			sawConfiguredProviderQualifiedRole = true;
		}
		const resolved = resolveModelFromString(expanded, availableModels, matchPreferences);
		if (resolved) return resolved;
	}
	return sawConfiguredProviderQualifiedRole ? undefined : availableModels[0];
}

/**
 * Resolve a list of override patterns to the first matching model.
 */
export function resolveModelOverride(
	modelPatterns: string[],
	modelRegistry: ModelLookupRegistry,
	settings?: Settings,
): { model?: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel; explicitThinkingLevel: boolean; warning?: string } {
	if (modelPatterns.length === 0) return { explicitThinkingLevel: false };
	const availableModels = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	let warning: string | undefined;
	for (const pattern of modelPatterns) {
		const {
			model,
			thinkingLevel,
			explicitThinkingLevel,
			warning: patternWarning,
		} = resolveModelRoleValue(pattern, availableModels, {
			settings,
			matchPreferences,
		});
		if (model) {
			return { model, thinkingLevel, explicitThinkingLevel, warning: patternWarning };
		}
		if (!warning && patternWarning) warning = patternWarning;
	}
	return { explicitThinkingLevel: false, warning };
}

/**
 * Resolve a list of override patterns to the first matching model, with an
 * auth-aware fallback to the parent session's active model.
 *
 * If the resolved subagent model has no working credentials (provider has no
 * usable auth), and the parent's active model resolves with working auth,
 * use the parent's model instead. This prevents subagent dispatch from
 * silently routing to a provider the user can't actually call (e.g.
 * `modelRoles.task` pointing at an unqualified id whose only available
 * provider variant has no configured credentials — see #985).
 *
 * `sessionId` is forwarded to `getApiKey` so that session-sticky OAuth
 * credentials resolve correctly during the pre-flight auth check. Without it,
 * providers with multiple OAuth accounts may return `undefined` even though
 * the credential is usable once the subagent session starts — see #5325.
 *
 * Keyless-by-design providers (llama.cpp, ollama, lm-studio) advertise the
 * `kNoAuth` sentinel from `getApiKey` to signal that they do not require
 * credentials. Those are treated as authenticated here so an explicitly
 * configured local model is never silently rerouted to the parent's remote
 * provider (see #1008).
 *
 * If neither the subagent nor the parent has working auth, returns the
 * primary resolution unchanged so the existing error path still surfaces
 * a meaningful failure downstream.
 */
export async function resolveModelOverrideWithAuthFallback(
	modelPatterns: string[],
	parentActiveModelPattern: string | undefined,
	modelRegistry: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey">,
	settings?: Settings,
	sessionId?: string,
): Promise<{
	model?: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	authFallbackUsed: boolean;
	warning?: string;
}> {
	const primary = resolveModelOverride(modelPatterns, modelRegistry, settings);
	if (!primary.model || !parentActiveModelPattern) {
		return { ...primary, authFallbackUsed: false };
	}

	const primaryKey = await modelRegistry.getApiKey(primary.model, sessionId);
	if (primaryKey === kNoAuth || isAuthenticated(primaryKey)) {
		return { ...primary, authFallbackUsed: false };
	}

	const fallback = resolveModelOverride([parentActiveModelPattern], modelRegistry, settings);
	if (!fallback.model) {
		return { ...primary, authFallbackUsed: false };
	}
	if (modelsAreEqual(fallback.model, primary.model)) {
		return { ...primary, authFallbackUsed: false };
	}
	const fallbackKey = await modelRegistry.getApiKey(fallback.model, sessionId);
	if (!isAuthenticated(fallbackKey)) {
		return { ...primary, authFallbackUsed: false };
	}

	return { ...fallback, authFallbackUsed: true, warning: primary.warning ?? fallback.warning };
}

/**
 * Resolve a list of role patterns to the first matching model.
 */
export function resolveRoleSelection(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const matchPreferences = getModelMatchPreferences(settings);
	for (const role of roles) {
		const resolved = resolveModelRoleValue(settings.getModelRole(role), availableModels, {
			settings,
			matchPreferences,
		});
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
		}
	}
	return undefined;
}

/**
 * Resolve the model for the `advisor` role. A configured `modelRoles.advisor`
 * wins outright (a bad override surfaces as no model rather than silently
 * running something else); when unset it falls back to the `slow` priority
 * chain via {@link ROLE_PRIORITY_ALIAS} — a strong reasoning model that, unlike
 * the `slow` role itself, never inherits the primary's model. Returns undefined
 * only when no candidate in the resolved chain is available.
 */
export function resolveAdvisorRoleSelection(
	settings: Settings,
	availableModels: Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const resolved = resolveModelRoleValue(formatModelRoleAlias("advisor"), availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	return resolved.model ? { model: resolved.model, thinkingLevel: resolved.thinkingLevel } : undefined;
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export async function resolveModelScope(
	patterns: string[],
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	preferences?: ModelMatchPreferences,
	settings?: Settings,
): Promise<ScopedModel[]> {
	const availableModels = modelRegistry.getAvailable();
	const context = buildPreferenceContext(availableModels, preferences);
	const scopedModels: ScopedModel[] = [];
	const addScopedModel = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined, explicit: boolean) => {
		if (scopedModels.some(sm => modelsAreEqual(sm.model, model))) return;
		scopedModels.push({
			model,
			thinkingLevel: explicit
				? (resolveThinkingLevelForModel(model, thinkingLevel) ?? thinkingLevel)
				: thinkingLevel,
			explicitThinkingLevel: explicit,
		});
	};

	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract optional thinking level suffix (e.g., "provider/*:high") only
			// after literal `:max` globs had a chance to match real model IDs.
			const {
				models: matchingModels,
				thinkingLevel,
				explicitThinkingLevel,
			} = resolveGlobScopePattern(pattern, availableModels);

			if (matchingModels.length === 0) {
				logger.warn(`No models match pattern "${pattern}"`);
				continue;
			}

			for (const model of matchingModels) {
				addScopedModel(model, thinkingLevel, explicitThinkingLevel);
			}
			continue;
		}

		// Role aliases (`@smol`, `pi/slow`) resolve to the role's single concrete
		// model — not its whole fallback chain — so a role contributes one scope
		// entry exactly like `--model` would pick. (Bare `*` stays a match-all
		// glob above; scope semantics, not the default-role alias.)
		if (settings && modelRoleAliasPrefixLength(pattern) !== undefined) {
			const resolved = resolveModelRoleValue(pattern, availableModels, { settings, matchPreferences: preferences });
			if (resolved.warning) logger.warn(resolved.warning);
			if (!resolved.model) {
				logger.warn(`No models match pattern "${pattern}"`);
				continue;
			}
			if (resolved.thinkingLevel === AUTO_THINKING) {
				addScopedModel(resolved.model, undefined, false);
			} else {
				addScopedModel(resolved.model, resolved.thinkingLevel, resolved.explicitThinkingLevel);
			}
			continue;
		}

		const { model, thinkingLevel, warning, explicitThinkingLevel } = parseModelPatternWithContext(
			pattern,
			availableModels,
			context,
		);

		if (warning) {
			logger.warn(warning);
		}

		if (!model) {
			logger.warn(`No models match pattern "${pattern}"`);
			continue;
		}

		// Scoped models (Ctrl+P cycling) carry concrete per-model overrides;
		// `auto` lives on the session, so drop the sentinel here.
		if (thinkingLevel === AUTO_THINKING) {
			addScopedModel(model, undefined, false);
		} else {
			addScopedModel(model, thinkingLevel, explicitThinkingLevel);
		}
	}

	return scopedModels;
}

/**
 * Resolve the set of models a session is allowed to use, given the active
 * settings. Starts from `modelRegistry.getAvailable()` (so disabled providers
 * and providers without credentials are already filtered out) and, when
 * `enabledModels` is configured for the current path scope, further restricts
 * the result to models matching those patterns.
 *
 * Returns the unfiltered available list when `enabledModels` is empty.
 * Returns an empty list when `enabledModels` is configured but no model matches
 * any pattern — callers MUST treat this as "no usable model" rather than
 * falling back to the global default (see issue #1022).
 */
export async function resolveAllowedModels(
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	settings: Settings | undefined,
	preferences?: ModelMatchPreferences,
): Promise<Model<Api>[]> {
	const available = modelRegistry.getAvailable();
	const patterns = settings?.get("enabledModels");
	if (!patterns || patterns.length === 0) {
		return available;
	}
	const scoped = await resolveModelScope(patterns, modelRegistry, preferences, settings);
	if (scoped.length === 0) {
		return [];
	}
	return includeSyntheticAllowedModels(
		available,
		scoped.map(entry => entry.model),
	);
}

/**
 * Synchronous subset of {@link resolveAllowedModels} for contexts where async is unavailable
 * (e.g. `getAvailableModels()` which is called from the ACP model-list advertisement, RPC
 * `get_available_models`, and the `/model` slash command). Uses the same effective
 * `enabledModels` scope semantics as startup resolution:
 *
 * - Glob selectors match `provider/modelId` and bare model id
 * - Exact `provider/modelId`, bare ids, provider-scoped fuzzy, and substring selectors
 *   resolve through the shared model-pattern matcher
 * - Optional `:thinkingLevel` suffixes are stripped only when valid
 *
 * When no pattern resolves to any model (misconfiguration / typo) an empty list is returned,
 * consistent with the empty-list contract of {@link resolveAllowedModels}. Callers that render
 * a UI picker should treat an empty list as "hide the picker entry", matching how the SDK
 * surfaces the same misconfiguration during session initialization.
 */
export function filterAvailableModelsByEnabledPatterns(
	available: Model<Api>[],
	patterns: readonly string[],
	settings?: Settings,
): Model<Api>[] {
	if (patterns.length === 0) return available;

	const context = buildPreferenceContext(available, undefined);
	const allowedModels: Model<Api>[] = [];
	const addAllowed = (model: Model<Api>) => {
		allowedModels.push(model);
	};

	for (const pattern of patterns) {
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			for (const model of resolveGlobScopePattern(pattern, available).models) {
				addAllowed(model);
			}
			continue;
		}

		// Mirror resolveModelScope: role aliases resolve to the role's model.
		if (settings && modelRoleAliasPrefixLength(pattern) !== undefined) {
			const { model } = resolveModelRoleValue(pattern, available, { settings });
			if (model) addAllowed(model);
			continue;
		}

		const { model } = parseModelPatternWithContext(pattern, available, context);
		if (model) {
			addAllowed(model);
		}
	}

	return includeSyntheticAllowedModels(available, allowedModels);
}
function findExactCliModel(
	selector: string,
	allModels: Model<Api>[],
	availableModels: Model<Api>[],
	options?: { catalogFallback?: boolean },
): Model<Api> | undefined {
	// Explicit provider/id references stay authoritative against the full catalog.
	const referenced = findExactModelReferenceMatch(selector, allModels);
	if (referenced) return referenced;

	// Flat-id (or full-selector-string) matches prefer authenticated providers,
	// then fall back to catalog order. This covers aggregator-style flat ids
	// that merely look provider-qualified (e.g. "openai/gpt-oss-120b" hosted on
	// OpenRouter), where the provider/id decomposition above found nothing. A
	// provider-qualified selector whose named provider carries the id must not
	// re-bind onto another provider's same-named flat id
	// (isProviderLockedCrossMatch); it stays provider-locked and fails instead.
	const lower = selector.toLowerCase();
	const isFlatMatch = (model: Model<Api>) =>
		model.id.toLowerCase() === lower || formatModelString(model).toLowerCase() === lower;
	const preferred = availableModels.find(m => isFlatMatch(m) && !isProviderLockedCrossMatch(selector, m));
	if (preferred) return preferred;
	// The unauthenticated catalog fallback is a weak match: a bare id like
	// `default` collides with the bundled `cursor/default` model, which must not
	// shadow a configured `modelRoles.default` role the user can actually run.
	// Callers resolving a possible role name pass `catalogFallback: false` so the
	// role gets a chance first; the deferred fuzzy fallback below still recovers
	// the catalog id when no role matches.
	if (options?.catalogFallback === false) return undefined;
	return availableModels === allModels
		? undefined
		: allModels.find(m => isFlatMatch(m) && !isProviderLockedCrossMatch(selector, m));
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	/** configuredPatterns contains the role's ordered primary candidates. */
	configuredPatterns?: string[];
	/** configuredRole identifies the role expanded into configuredPatterns. */
	configuredRole?: string;
	/** configuredPatternIndex identifies the configured role pattern that matched an available model. */
	configuredPatternIndex?: number;
	selector?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	warning: string | undefined;
	error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 *
 * Explicit `provider/id` references and authenticated bare ids take precedence
 * over configured role names, which in turn take precedence over an
 * unauthenticated catalog-only id (so a bundled `cursor/default` never shadows a
 * configured `modelRoles.default`).
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: CliModelRegistry;
	/** Authenticated models to prefer for unqualified selectors; defaults to the registry's authenticated set. */
	availableModels?: Model<Api>[];
	settings?: Settings;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry, settings, preferences, availableModels: preferredModels } = options;

	if (!cliModel) {
		return { model: undefined, selector: undefined, warning: undefined, error: undefined };
	}

	const allModels = modelRegistry.getAll();
	if (allModels.length === 0) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const availableModels = preferredModels ?? modelRegistry.getAvailable();
	const providerMap = new Map<string, string>();
	for (const model of allModels) {
		providerMap.set(model.provider.toLowerCase(), model.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Run "omp models" to see available providers/models.`,
		};
	}

	const trimmedModel = cliModel.trim();
	if (!provider) {
		const exact = findExactCliModel(trimmedModel, allModels, availableModels, { catalogFallback: false });
		if (exact) {
			return {
				model: exact,
				selector: formatModelString(exact),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
		const { base: exactBase, level: exactThinkingLevel } = splitThinkingSuffix(
			trimmedModel,
			-1,
			MAX_THINKING_SUFFIX_OPTIONS,
		);
		if (exactThinkingLevel) {
			const exactSuffixed = findExactCliModel(exactBase, allModels, availableModels, { catalogFallback: false });
			if (exactSuffixed) {
				return {
					model: exactSuffixed,
					selector: formatModelString(exactSuffixed),
					warning: undefined,
					thinkingLevel: exactThinkingLevel,
					error: undefined,
				};
			}
		}
	}
	let configuredPatterns: string[] | undefined;
	if (!cliProvider) {
		const { base: bareRoleName, level: bareRoleThinkingLevel } = splitThinkingSuffix(
			trimmedModel,
			-1,
			MAX_THINKING_SUFFIX_OPTIONS,
		);
		const roleSelector =
			modelRoleAliasPrefixLength(trimmedModel) !== undefined
				? trimmedModel
				: settings?.getModelRole(bareRoleName) !== undefined
					? `${formatModelRoleAlias(bareRoleName)}${bareRoleThinkingLevel ? `:${bareRoleThinkingLevel}` : ""}`
					: undefined;
		if (roleSelector) {
			const { base: roleAlias } = splitThinkingSuffix(
				roleSelector,
				modelRoleAliasPrefixLength(roleSelector) ?? -1,
				MAX_THINKING_SUFFIX_OPTIONS,
			);
			const configuredRole = getModelRoleAlias(roleAlias, settings);
			configuredPatterns = resolveConfiguredModelPatterns([roleSelector], settings);
			const availableResolved = resolveModelRoleValue(roleSelector, availableModels, {
				settings,
				matchPreferences: preferences,
			});
			const resolved = availableResolved.model
				? availableResolved
				: resolveModelRoleValue(roleSelector, allModels, {
						settings,
						matchPreferences: preferences,
					});
			if (resolved.model) {
				return {
					model: resolved.model,
					selector: formatModelString(resolved.model),
					configuredRole,
					configuredPatterns,
					configuredPatternIndex: resolved.matchedPatternIndex,
					thinkingLevel: resolved.thinkingLevel,
					warning: resolved.warning,
					error: undefined,
				};
			}
			if (configuredPatterns && configuredPatterns.length > 0) {
				return {
					model: undefined,
					configuredPatterns,
					configuredRole,
					selector: undefined,
					thinkingLevel: undefined,
					warning: resolved.warning,
					error: `Model "${trimmedModel}" not found. Run "omp models" to see available models.`,
				};
			}
		}
	}

	let pattern = trimmedModel;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
			}
		}
	} else {
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	if (provider) {
		const exactProviderMatch = resolveProviderModelReference(provider, pattern, allModels);
		if (exactProviderMatch) {
			return {
				model: exactProviderMatch,
				selector: formatModelString(exactProviderMatch),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
	}

	const candidates = provider ? allModels.filter(model => model.provider === provider) : availableModels;
	let parsed = parseModelPattern(pattern, candidates, preferences, {
		allowInvalidThinkingSelectorFallback: false,
	});
	if (!parsed.model && !provider) {
		parsed = parseModelPattern(pattern, allModels, preferences, {
			allowInvalidThinkingSelectorFallback: false,
		});
	}
	const { model, thinkingLevel, warning, upstream } = parsed;

	if (!model) {
		const display = provider ? `${provider}/${pattern}` : cliModel;
		return {
			model: undefined,
			configuredPatterns,
			selector: undefined,
			thinkingLevel: undefined,
			warning,
			error: `Model "${display}" not found. Run "omp models" to see available models.`,
		};
	}

	let selector = provider ? formatModelString(model) : undefined;
	if (selector !== undefined && upstream) {
		selector = `${selector}@${upstream}`;
	}

	return {
		model,
		selector,
		thinkingLevel,
		warning,
		error: undefined,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. CLI args (provider + model)
 * 2. First model from scoped models (if not continuing/resuming)
 * 3. Restored from session (if continuing/resuming)
 * 4. Saved default from settings
 * 5. First available model with valid API key
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingSelector?: Effort;
	modelRegistry: InitialModelRegistry;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingSelector,
		modelRegistry,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: Effort | undefined;

	// 1. CLI args take priority
	if (cliProvider && cliModel) {
		const found = modelRegistry.find(cliProvider, cliModel);
		if (!found) {
			console.error(chalk.red(`Model ${cliProvider}/${cliModel} not found`));
			process.exit(1);
		}
		return { model: found, thinkingLevel: undefined, fallbackMessage: undefined };
	}

	// 2. Use first model from scoped models (skip if continuing/resuming)
	if (scopedModels.length > 0 && !isContinuing) {
		const scoped = scopedModels[0];
		const scopedThinkingSelector =
			scoped.thinkingLevel === ThinkingLevel.Inherit
				? defaultThinkingSelector
				: (scoped.thinkingLevel ?? defaultThinkingSelector);
		return {
			model: scoped.model,
			thinkingLevel:
				scopedThinkingSelector === ThinkingLevel.Off
					? ThinkingLevel.Off
					: clampThinkingLevelForModel(scoped.model, scopedThinkingSelector),
			fallbackMessage: undefined,
		};
	}

	// 3. Try saved default from settings
	if (defaultProvider && defaultModelId) {
		const found = modelRegistry.find(defaultProvider, defaultModelId);
		if (found) {
			model = found;
			thinkingLevel = clampThinkingLevelForModel(found, defaultThinkingSelector);
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. Try first available model with valid API key
	const availableModels = modelRegistry.getAvailable();

	const fallback = pickDefaultAvailableModel(availableModels, provider => modelRegistry.hasConcreteAuth(provider));
	if (fallback) {
		return { model: fallback, thinkingLevel: undefined, fallbackMessage: undefined };
	}

	// 5. No model found
	return { model: undefined, thinkingLevel: undefined, fallbackMessage: undefined };
}

/**
 * Restore model from session, with fallback to available models
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRegistry: RestorableModelRegistry,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRegistry.find(savedProvider, savedModelId);

	// Check if restored model exists and has a valid API key
	const hasApiKey = restoredModel ? !!(await modelRegistry.getApiKey(restoredModel)) : false;

	if (restoredModel && hasApiKey) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// Model not found or no API key - fall back
	const reason = !restoredModel ? "model no longer exists" : "no API key available";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// If we already have a model, use it as fallback
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// Try to find any available model
	const availableModels = modelRegistry.getAvailable();

	const fallbackModel = pickDefaultAvailableModel(availableModels, provider =>
		modelRegistry.hasConcreteAuth(provider),
	);
	if (fallbackModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// No models available
	return { model: undefined, fallbackMessage: undefined };
}

/**
 * Find a smol/fast model using the priority chain.
 * Tries exact matches first, then fuzzy matches.
 *
 * @param modelRegistry The model registry to search
 * @param savedModel Optional saved model string from settings (provider/modelId)
 * @returns The best available smol model, or undefined if none found
 */
export async function findSmolModel(
	modelRegistry: ModelLookupRegistry,
	savedModel?: string,
): Promise<Model<Api> | undefined> {
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) return undefined;

	// 1. Try saved model from settings
	if (savedModel) {
		const match = resolveModelFromString(savedModel, availableModels, undefined);
		if (match) return match;
	}

	// 2. Try priority chain
	for (const pattern of MODEL_PRIO.smol) {
		// Try exact match with provider prefix
		const providerMatch = availableModels.find(m => `${m.provider}/${m.id}`.toLowerCase() === pattern);
		if (providerMatch) return providerMatch;

		// Try exact match first
		const exactMatch = parseModelPattern(pattern, availableModels, undefined).model;
		if (exactMatch) return exactMatch;

		// Try fuzzy match (substring)
		const fuzzyMatch = availableModels.find(m => m.id.toLowerCase().includes(pattern));
		if (fuzzyMatch) return fuzzyMatch;
	}

	// 3. Fallback to first available (same as default)
	return availableModels[0];
}

/**
 * Find a slow/comprehensive model using the priority chain.
 * Prioritizes reasoning and codex models for thorough analysis.
 *
 * @param modelRegistry The model registry to search
 * @param savedModel Optional saved model string from settings (provider/modelId)
 * @returns The best available slow model, or undefined if none found
 */
export async function findSlowModel(
	modelRegistry: ModelLookupRegistry,
	savedModel?: string,
): Promise<Model<Api> | undefined> {
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) return undefined;

	// 1. Try saved model from settings
	if (savedModel) {
		const match = resolveModelFromString(savedModel, availableModels, undefined);
		if (match) return match;
	}

	// 2. Try priority chain
	for (const pattern of MODEL_PRIO.slow) {
		// Try exact match first
		const exactMatch = parseModelPattern(pattern, availableModels, undefined).model;
		if (exactMatch) return exactMatch;

		// Try fuzzy match (substring)
		const fuzzyMatch = availableModels.find(m => m.id.toLowerCase().includes(pattern.toLowerCase()));
		if (fuzzyMatch) return fuzzyMatch;
	}

	// 3. Fallback to first available (same as default)
	return availableModels[0];
}
