/**
 * The single Model constructor. Resolution runs through the compat engine
 * (`compat/resolve`): identity classification, cascade-rule axes, host
 * detection, and spec overrides materialize exactly once per spec.
 *
 * Request handlers read fields — they never detect, parse ids, or allocate
 * compat per request.
 */

import { resolveDiscoveryApi, resolveModelPolicy } from "./compat/resolve";
import type { ModelIdentity } from "./compat/types";
import { resolveModelTokenizer } from "./model-tokenizer";
import {
	applyDueDatedCostCard,
	type DatedCostCard,
	dueEffectiveRate,
	EARLIEST_EFFECTIVE_FROM,
	materializeTimeBasedCost,
	NO_RECURRING_TARIFF,
	parseDatedCostCards,
} from "./pricing";
import { type Api, type EffectiveTokenCost, MODEL_KINDS, type Model, type ModelCost, type ModelSpec } from "./types";
import { cleanModelName } from "./utils";

function numberField(source: object, key: string): number | undefined {
	const value: unknown = Reflect.get(source, key);
	return typeof value === "number" ? value : undefined;
}

/** Narrow an unknown compiled-axis payload to an object payload. */
function objectPayload(value: unknown): object | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** Narrow a compiled `input-modalities` axis value to the model input union. */
function isInputModalities(value: unknown): value is ("text" | "image")[] {
	return Array.isArray(value) && value.every(entry => entry === "text" || entry === "image");
}

/**
 * Applies resolved catalog-data axes onto the model: reviewed metadata
 * corrections (`cost-patch`, `limits-patch`, `long-context-cost`,
 * `context-window-floor`) overwrite upstream values; selection metadata
 * (`priority`, `apply-patch-tool-type`, `service-tier-cost`,
 * `requires-cursor-tool-schema-projection`, `requires-tool-result-image-hoisting`,
 * `supports-assistant-prefill`) is rule-owned; `context-promotion-target` fills
 * only when the spec left it unset.
 */
function applyCatalogAssignments<TApi extends Api>(model: Model<TApi>, catalog: Record<string, unknown>): void {
	const kind = MODEL_KINDS.find(value => value === catalog.kind);
	if (kind !== undefined) model.kind = kind;
	if (catalog.contextWindowAuthoritative === true) {
		model.contextWindowAuthoritative = true;
	} else {
		delete model.contextWindowAuthoritative;
	}
	if (catalog.longContextWindowUncapped === true) {
		model.longContextWindowUncapped = true;
	} else {
		delete model.longContextWindowUncapped;
	}
	const webSearch = catalog.webSearch;
	if (
		webSearch === "gemini" ||
		webSearch === "anthropic" ||
		webSearch === "codex" ||
		webSearch === "xai" ||
		webSearch === "openrouter" ||
		webSearch === "openai"
	) {
		model.webSearch = webSearch;
	}
	if (typeof catalog.webSearchModel === "string") model.webSearchModel = catalog.webSearchModel;
	if (catalog.hostedImage === true) model.hostedImage = true;
	else if (catalog.hostedImage === false) delete model.hostedImage;
	if (typeof catalog.imageModel === "string") model.imageModel = catalog.imageModel;
	else if (catalog.imageModel === false) delete model.imageModel;
	const serviceTierCost = objectPayload(catalog.serviceTierCost);
	if (serviceTierCost !== undefined) {
		const flex = numberField(serviceTierCost, "flex");
		const priorityTier = numberField(serviceTierCost, "priority");
		const ultrafast = numberField(serviceTierCost, "ultrafast");
		model.serviceTierCost = {
			...(flex !== undefined && { flex }),
			...(priorityTier !== undefined && { priority: priorityTier }),
			...(ultrafast !== undefined && { ultrafast }),
		};
	}
	const priority = catalog.priority;
	if (typeof priority === "number") model.priority = priority;
	const promptCache = objectPayload(catalog.promptCache);
	if (promptCache !== undefined) {
		const short = numberField(promptCache, "short");
		const long = numberField(promptCache, "long");
		model.promptCache = {
			...(short !== undefined && { short }),
			...(long !== undefined && { long }),
		};
	}
	const applyPatchToolType = catalog.applyPatchToolType;
	if (applyPatchToolType === "freeform" || applyPatchToolType === "function") {
		model.applyPatchToolType = applyPatchToolType;
	}
	const editPromptVariant = catalog.editPromptVariant;
	if (editPromptVariant === "full" || editPromptVariant === "compact") {
		model.editPromptVariant = editPromptVariant;
	}
	const pricingStatus = catalog.pricingStatus;
	if (
		pricingStatus === "free" ||
		pricingStatus === "included" ||
		pricingStatus === "variable" ||
		pricingStatus === "unknown"
	) {
		model.pricingStatus = pricingStatus;
	}
	const requiresCursorToolSchemaProjection = catalog.requiresCursorToolSchemaProjection;
	if (requiresCursorToolSchemaProjection === true) {
		model.requiresCursorToolSchemaProjection = true;
	} else {
		delete model.requiresCursorToolSchemaProjection;
	}
	if (catalog.toolSchemasInContext === false) {
		model.toolSchemasInContext = false;
	} else {
		delete model.toolSchemasInContext;
	}
	const requiresToolResultImageHoisting = catalog.requiresToolResultImageHoisting;
	if (requiresToolResultImageHoisting === true) {
		model.requiresToolResultImageHoisting = true;
	} else {
		delete model.requiresToolResultImageHoisting;
	}
	if (catalog.supportsAssistantPrefill === true) {
		model.supportsAssistantPrefill = true;
	} else {
		delete model.supportsAssistantPrefill;
	}
	// The same KDL output-cap contract gates host options and the Responses
	// transport. Materialize it because the transport consumes the model field.
	if (typeof catalog.omitMaxOutputTokens === "boolean" && model.omitMaxOutputTokens === undefined) {
		model.omitMaxOutputTokens = catalog.omitMaxOutputTokens;
	}
	const contextPromotionTarget = catalog.contextPromotionTarget;
	if (typeof contextPromotionTarget === "string" && model.contextPromotionTarget === undefined) {
		model.contextPromotionTarget = contextPromotionTarget;
	}
}

/** The parsed dated cards of a row's `cost-patch` and `cost-fallback`. */
interface DatedCostCards {
	patch: readonly DatedCostCard[];
	fallback: readonly DatedCostCard[];
}

/**
 * The row's corrected price card at `now`: `cost-patch`, then `cost-fallback`
 * (each with its dated card due at `now`), then the long-context tier and
 * cache-rate derivations, all from the upstream card.
 */
function correctedCost(
	upstream: ModelCost,
	catalog: Record<string, unknown>,
	cards: DatedCostCards,
	now: number,
): ModelCost {
	let cost: ModelCost = { ...upstream };
	const upstreamCard =
		upstream.timeBased?.effectiveRates?.[0]?.effectiveFrom === EARLIEST_EFFECTIVE_FROM
			? dueEffectiveRate(upstream.timeBased, now)
			: undefined;
	if (upstreamCard !== undefined) {
		// A row rebuilt from an already built one (dynamic merges, overrides)
		// carries the dated schedule compiled below. Its leading card covers all
		// history, so the scalar legs only ever held the card due at the first
		// build; start from the card due now instead.
		const { effectiveFrom: _effectiveFrom, ...card } = upstreamCard;
		const { longContext: _longContext, ...base } = cost;
		cost = { ...base, ...card };
	}
	const patch = objectPayload(catalog.costPatch);
	if (patch !== undefined) {
		const input = numberField(patch, "input");
		if (input !== undefined) cost.input = input;
		const output = numberField(patch, "output");
		if (output !== undefined) cost.output = output;
		const cacheRead = numberField(patch, "cacheRead");
		if (cacheRead !== undefined) cost.cacheRead = cacheRead;
		const cacheWrite = numberField(patch, "cacheWrite");
		if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
		applyDueDatedCostCard(cost, cards.patch, now);
	}
	const fallback = objectPayload(catalog.costFallback);
	if (fallback !== undefined) {
		const hasTokenPrice = cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
		if (!hasTokenPrice) {
			// Upstream reported no token price (plan-included or promo-free
			// rows): seed the reviewed list price instead of overwriting real
			// discovery data the way `cost-patch` would.
			const input = numberField(fallback, "input");
			if (input !== undefined) cost.input = input;
			const output = numberField(fallback, "output");
			if (output !== undefined) cost.output = output;
			const cacheRead = numberField(fallback, "cacheRead");
			if (cacheRead !== undefined) cost.cacheRead = cacheRead;
			const cacheWrite = numberField(fallback, "cacheWrite");
			if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
			applyDueDatedCostCard(cost, cards.fallback, now);
		}
	}
	const longContext = objectPayload(catalog.longContext);
	if (longContext !== undefined) {
		const inputThreshold = numberField(longContext, "inputThreshold");
		const inclusive = Reflect.get(longContext, "inputThresholdInclusive") === true;
		const multiplier = numberField(longContext, "multiplier");
		const input = numberField(longContext, "input");
		const output = numberField(longContext, "output");
		const cacheRead = numberField(longContext, "cacheRead");
		const cacheWrite = numberField(longContext, "cacheWrite");
		const hasTokenPrice = cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
		if (inputThreshold !== undefined && multiplier !== undefined && hasTokenPrice) {
			// Multiplier form: tier rates derive from the row's final base card,
			// after `cost-patch`/`cost-fallback` corrected the live list price.
			cost = {
				...cost,
				longContext: {
					inputThreshold,
					...(inclusive && { inputThresholdInclusive: true }),
					input: cost.input * multiplier,
					output: cost.output * (numberField(longContext, "outputMultiplier") ?? multiplier),
					cacheRead: cost.cacheRead * multiplier,
					cacheWrite: cost.cacheWrite * multiplier,
				},
			};
		} else if (
			inputThreshold !== undefined &&
			input !== undefined &&
			output !== undefined &&
			cacheRead !== undefined &&
			cacheWrite !== undefined
		) {
			cost = { ...cost, longContext: { inputThreshold, input, output, cacheRead, cacheWrite } };
		}
	}
	if (catalog.cacheReadAtInputRate === true) {
		const { longContext } = cost;
		cost = {
			...cost,
			cacheRead: cost.input,
			...(longContext && { longContext: { ...longContext, cacheRead: longContext.input } }),
		};
	}
	const cacheWriteRate = catalog.cacheWriteRate;
	if (typeof cacheWriteRate === "number") {
		const { longContext } = cost;
		cost = {
			...cost,
			cacheWrite: cost.input * cacheWriteRate,
			...(longContext && { longContext: { ...longContext, cacheWrite: longContext.input * cacheWriteRate } }),
		};
	}
	return cost;
}

/**
 * Every price period the dated `cost-patch`/`cost-fallback` cards define, for
 * request-time selection (`calculateUsageCost`): a row built before a change
 * still bills requests after it at the new price, and a leading card keeps
 * earlier requests at the old one on rows built after it. Undefined when no
 * card changes the price (no cards, or a fallback the upstream price outranks).
 */
function scheduledRates(
	upstream: ModelCost,
	catalog: Record<string, unknown>,
	cards: DatedCostCards,
): EffectiveTokenCost[] | undefined {
	const dates = [...cards.patch, ...cards.fallback].map(card => card.effectiveFrom).sort((a, b) => a - b);
	if (dates.length === 0) return undefined;
	const periods: EffectiveTokenCost[] = [];
	let previousPrice: string | undefined;
	for (const effectiveFrom of [EARLIEST_EFFECTIVE_FROM, ...dates]) {
		const { input, output, cacheRead, cacheWrite, longContext } = correctedCost(
			upstream,
			catalog,
			cards,
			effectiveFrom,
		);
		const price = { input, output, cacheRead, cacheWrite, ...(longContext && { longContext }) };
		const key = JSON.stringify(price);
		if (key === previousPrice) continue;
		previousPrice = key;
		periods.push({ effectiveFrom, ...price });
	}
	return periods.length > 1 ? periods : undefined;
}

/**
 * Applies reviewed catalog-data value corrections (`cost-patch`,
 * `cache-read-at-input-rate`, `cache-write-rate`, `limits-patch`,
 * `long-context-cost`, `context-window-floor`, `input-modalities`) onto an
 * upstream-sourced spec. Applied by
 * `buildModel` to every upstream-sourced spec; user-authored overrides are
 * recomposed after building by the override applicators, so explicit user
 * limits and pricing still win.
 */
export function applyCatalogCorrections(
	model: Pick<ModelSpec<Api>, "cost" | "contextWindow" | "maxTokens" | "input">,
	catalog: Record<string, unknown>,
): void {
	const upstream = model.cost;
	const cards: DatedCostCards = {
		patch: parseDatedCostCards(catalog.costPatch, "cost-patch"),
		fallback: parseDatedCostCards(catalog.costFallback, "cost-fallback"),
	};
	// The card due now is the row's displayed price; the dated schedule rides
	// along so rows reused past a change (bundles, caches, long sessions) still
	// bill each request at the card in force when it was made.
	model.cost = correctedCost(upstream, catalog, cards, Date.now());
	const recurring = catalog.timeBased === undefined ? undefined : materializeTimeBasedCost(catalog.timeBased);
	const dated = scheduledRates(upstream, catalog, cards);
	if (dated !== undefined) {
		if (recurring?.effectiveRates !== undefined) {
			throw new Error(
				"Dated cost-patch/cost-fallback effective-rates cannot combine with time-based-cost effective-rates",
			);
		}
		model.cost = { ...model.cost, timeBased: { ...(recurring ?? NO_RECURRING_TARIFF), effectiveRates: dated } };
	} else if (recurring !== undefined) {
		model.cost = { ...model.cost, timeBased: recurring };
	}
	const limitsPatch = objectPayload(catalog.limitsPatch);
	if (limitsPatch !== undefined) {
		const contextWindow = numberField(limitsPatch, "contextWindow");
		if (contextWindow !== undefined) model.contextWindow = contextWindow;
		const maxTokens = numberField(limitsPatch, "maxTokens");
		if (maxTokens !== undefined) model.maxTokens = maxTokens;
	}
	const maxTokensFallback = catalog.maxTokensFallback;
	if (typeof maxTokensFallback === "number" && model.maxTokens === null) {
		model.maxTokens = maxTokensFallback;
	}
	const maxTokensCeiling = catalog.maxTokensCeiling;
	if (typeof maxTokensCeiling === "number" && model.maxTokens !== null && model.maxTokens > maxTokensCeiling) {
		model.maxTokens = maxTokensCeiling;
	}
	const contextWindowFloor = catalog.contextWindowFloor;
	if (typeof contextWindowFloor === "number") {
		model.contextWindow = Math.max(model.contextWindow ?? 0, contextWindowFloor);
	}
	const inputModalities = catalog.inputModalities;
	if (isInputModalities(inputModalities)) {
		model.input = inputModalities;
	}
}

/**
 * Direct first-party OpenAI Responses endpoints (api.openai.com, Azure OpenAI
 * deployments). Gates GA computer-use detection; identity supplies the model
 * generation.
 */
function isDirectOpenAIResponsesEndpoint(spec: ModelSpec<Api>): boolean {
	if (spec.api === "openai-responses") {
		if (spec.provider !== "openai") return false;
		if (!spec.baseUrl) return true;
		try {
			const url = new URL(spec.baseUrl);
			return url.protocol === "https:" && url.hostname === "api.openai.com";
		} catch {
			return false;
		}
	}
	if (spec.api !== "azure-openai-responses" || (spec.provider !== "azure" && spec.provider !== "azure-openai")) {
		return false;
	}
	if (!spec.baseUrl) return true;
	try {
		const url = new URL(spec.baseUrl);
		return (
			url.protocol === "https:" &&
			(url.hostname.endsWith(".openai.azure.com") || url.hostname === "models.inference.ai.azure.com")
		);
	} catch {
		return false;
	}
}

function explicitComputerUseConfig(spec: ModelSpec<Api>): boolean | undefined {
	if (!("supportsComputerUseConfig" in spec)) return spec.supportsComputerUse;
	const value: unknown = Reflect.get(spec, "supportsComputerUseConfig");
	return typeof value === "boolean" ? value : undefined;
}

function revisionAtLeast(identity: ModelIdentity, major: number, minor: number): boolean {
	if (identity.revision === undefined) return false;
	const [revMajor = 0, revMinor = 0] = identity.revision.split(".").map(Number);
	return revMajor > major || (revMajor === major && revMinor >= minor);
}

function supportsOpenAIGAComputerUse(
	spec: ModelSpec<Api>,
	identity: ModelIdentity,
	explicitSupport: boolean | undefined,
): boolean {
	if (explicitSupport !== undefined) return explicitSupport;
	if (!isDirectOpenAIResponsesEndpoint(spec)) return false;
	const wireIdentity =
		spec.requestModelId === undefined ? identity : resolveModelPolicy({ ...spec, id: spec.requestModelId }).identity;
	return wireIdentity.class === "openai" && revisionAtLeast(wireIdentity, 5, 4);
}

/**
 * Build a discovered model using the backend's catalog-selected request API.
 * The credential-bearing provider id remains unchanged while `providerType`
 * persists the backend policy identity across cache and config round trips.
 */
export function buildDiscoveredModel(spec: ModelSpec<Api>, providerType: string): Model<Api> {
	const api = resolveDiscoveryApi(spec, providerType);
	return buildModel({ ...spec, api, providerType });
}

/**
 * Build one model from an authored spec. Bundled models.json rows are fully
 * materialized by the generator and consumed directly (see `models.ts`), so
 * this only runs for discovered/custom/override specs.
 */
export function buildModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
	const policy = resolveModelPolicy(spec);
	const supportsComputerUseConfig = explicitComputerUseConfig(spec);
	const model: Model<TApi> = {
		...spec,
		// A reviewed `thinking-upgrade-neutral` policy can repair a stale
		// `reasoning: false` discovery default, and an unclassified neutral spec
		// gets an unverified ladder (see `resolveThinkingPolicy`); materialize
		// either for transports and the picker.
		reasoning: spec.reasoning || policy.thinking !== undefined,
		name: cleanModelName(spec.name),
		identity: policy.identity,
		requiresGlyphTokenization: policy.identity.class === "anthropic",
		tokenizer: spec.tokenizer ?? resolveModelTokenizer(spec.requestModelId ?? spec.id, spec.provider),
		thinking: policy.thinking,
		supportsComputerUse: supportsOpenAIGAComputerUse(spec, policy.identity, supportsComputerUseConfig),
		supportsComputerUseConfig,
		compat: policy.compat,
		compatConfig: spec.compat,
	};
	applyCatalogAssignments(model, policy.catalog);
	applyCatalogCorrections(model, policy.catalog);
	// Configured kinds and lifetimes replace catalog values rather than merging with them.
	if (spec.kindConfig !== undefined) model.kind = spec.kindConfig;
	if (spec.promptCacheConfig !== undefined) model.promptCache = { ...spec.promptCacheConfig };
	return model;
}
