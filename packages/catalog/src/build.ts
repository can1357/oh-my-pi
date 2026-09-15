/**
 * The single Model constructor. Resolution runs through the compat engine
 * (`compat/resolve`): identity classification, cascade-rule axes, host
 * detection, and spec overrides materialize exactly once per spec.
 *
 * Request handlers read fields — they never detect, parse ids, or allocate
 * compat per request.
 */

import { pricingPeerFor } from "./compat/behavior";
import { resolveModelPolicy } from "./compat/resolve";
import type { ModelIdentity } from "./compat/types";
import { resolveModelTokenizer } from "./model-tokenizer";
import PEER_COSTS from "./pricing-peer-costs.json" with { type: "json" };
import { materializeTimeBasedCost } from "./pricing";
import type { Api, Model, ModelCost, ModelSpec } from "./types";
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
	const serviceTierCost = objectPayload(catalog.serviceTierCost);
	if (serviceTierCost !== undefined) {
		const flex = numberField(serviceTierCost, "flex");
		const priorityTier = numberField(serviceTierCost, "priority");
		model.serviceTierCost = {
			...(flex !== undefined && { flex }),
			...(priorityTier !== undefined && { priority: priorityTier }),
		};
	}
	const priority = catalog.priority;
	if (typeof priority === "number") model.priority = priority;
	const applyPatchToolType = catalog.applyPatchToolType;
	if (applyPatchToolType === "freeform" || applyPatchToolType === "function") {
		model.applyPatchToolType = applyPatchToolType;
	}
	const editPromptVariant = catalog.editPromptVariant;
	if (editPromptVariant === "full" || editPromptVariant === "compact") {
		model.editPromptVariant = editPromptVariant;
	}
	const requiresCursorToolSchemaProjection = catalog.requiresCursorToolSchemaProjection;
	if (requiresCursorToolSchemaProjection === true) {
		model.requiresCursorToolSchemaProjection = true;
	} else {
		delete model.requiresCursorToolSchemaProjection;
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
	const contextPromotionTarget = catalog.contextPromotionTarget;
	if (typeof contextPromotionTarget === "string" && model.contextPromotionTarget === undefined) {
		model.contextPromotionTarget = contextPromotionTarget;
	}
}

/**
 * Applies reviewed catalog-data value corrections (`cost-patch`,
 * `limits-patch`, `long-context-cost`, `context-window-floor`,
 * `input-modalities`) onto an upstream-sourced spec. Applied by
 * `buildModel` to every upstream-sourced spec; user-authored overrides are
 * recomposed after building by the override applicators, so explicit user
 * limits and pricing still win.
 */
export function applyCatalogCorrections(
	model: Pick<ModelSpec<Api>, "cost" | "contextWindow" | "maxTokens" | "input">,
	catalog: Record<string, unknown>,
): void {
	const longContext = objectPayload(catalog.longContext);
	if (longContext !== undefined) {
		const inputThreshold = numberField(longContext, "inputThreshold");
		const inclusive = Reflect.get(longContext, "inputThresholdInclusive") === true;
		const multiplier = numberField(longContext, "multiplier");
		const input = numberField(longContext, "input");
		const output = numberField(longContext, "output");
		const cacheRead = numberField(longContext, "cacheRead");
		const cacheWrite = numberField(longContext, "cacheWrite");
		const base = model.cost;
		const hasTokenPrice = base.input !== 0 || base.output !== 0 || base.cacheRead !== 0 || base.cacheWrite !== 0;
		if (inputThreshold !== undefined && multiplier !== undefined && hasTokenPrice) {
			// Multiplier form: tier rates derive from the row's live list price.
			model.cost = {
				...base,
				longContext: {
					inputThreshold,
					...(inclusive && { inputThresholdInclusive: true }),
					input: base.input * multiplier,
					output: base.output * multiplier,
					cacheRead: base.cacheRead * multiplier,
					cacheWrite: base.cacheWrite * multiplier,
				},
			};
		} else if (
			inputThreshold !== undefined &&
			input !== undefined &&
			output !== undefined &&
			cacheRead !== undefined &&
			cacheWrite !== undefined
		) {
			model.cost = { ...model.cost, longContext: { inputThreshold, input, output, cacheRead, cacheWrite } };
		}
	}
	const patch = objectPayload(catalog.costPatch);
	if (patch !== undefined) {
		model.cost = { ...model.cost };
		const input = numberField(patch, "input");
		if (input !== undefined) model.cost.input = input;
		const output = numberField(patch, "output");
		if (output !== undefined) model.cost.output = output;
		const cacheRead = numberField(patch, "cacheRead");
		if (cacheRead !== undefined) model.cost.cacheRead = cacheRead;
		const cacheWrite = numberField(patch, "cacheWrite");
		if (cacheWrite !== undefined) model.cost.cacheWrite = cacheWrite;
	}
	const fallback = objectPayload(catalog.costFallback);
	if (fallback !== undefined) {
		const base = model.cost;
		const hasTokenPrice = base.input !== 0 || base.output !== 0 || base.cacheRead !== 0 || base.cacheWrite !== 0;
		if (!hasTokenPrice) {
			// Upstream reported no token price (plan-included or promo-free
			// rows): seed the reviewed list price instead of overwriting real
			// discovery data the way `cost-patch` would.
			model.cost = { ...model.cost };
			const input = numberField(fallback, "input");
			if (input !== undefined) model.cost.input = input;
			const output = numberField(fallback, "output");
			if (output !== undefined) model.cost.output = output;
			const cacheRead = numberField(fallback, "cacheRead");
			if (cacheRead !== undefined) model.cost.cacheRead = cacheRead;
			const cacheWrite = numberField(fallback, "cacheWrite");
			if (cacheWrite !== undefined) model.cost.cacheWrite = cacheWrite;
			const effectiveRates = Reflect.get(fallback, "effectiveRates");
			if (effectiveRates !== undefined && model.cost.timeBased === undefined) {
				model.cost = {
					...model.cost,
					timeBased: materializeTimeBasedCost({ offPeakMultiplier: 1, peakWindows: {}, effectiveRates }),
				};
			}
		}
	}
	if (catalog.timeBased !== undefined) {
		model.cost = { ...model.cost, timeBased: materializeTimeBasedCost(catalog.timeBased) };
	}
	const limitsPatch = objectPayload(catalog.limitsPatch);
	if (limitsPatch !== undefined) {
		const contextWindow = numberField(limitsPatch, "contextWindow");
		if (contextWindow !== undefined) model.contextWindow = contextWindow;
		const maxTokens = numberField(limitsPatch, "maxTokens");
		if (maxTokens !== undefined) model.maxTokens = maxTokens;
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
 * Runtime mirror of the generator's `applyPricingPeerFallbacks`: when upstream
 * discovery reports no token price for a provider with a `pricing-peer` rule,
 * seed the first-party bundled list price. Credential-scoped providers
 * (kimi-code, xai-oauth, devin) only discover at runtime, so the gen-time pass
 * never sees their rows. Runs after `applyCatalogCorrections` so a reviewed
 * `cost-fallback` literal still wins over a peer mirror.
 */
function applyPricingPeerFallback(model: Model<Api>): void {
	const cost = model.cost;
	if (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0) {
		return;
	}
	const peer = pricingPeerFor(model.provider, model.id);
	if (!peer) {
		return;
	}
	for (const candidateId of peer.peerId !== model.id ? [peer.peerId, model.id] : [model.id]) {
		for (const provider of peer.peers) {
			// Mirror models.ts: the JSON import carries a literal type; index
			// through keyof and narrow the row to its cost shape.
			const providerCosts = PEER_COSTS[provider as keyof typeof PEER_COSTS] as Record<string, ModelCost> | undefined;
			const cost = providerCosts?.[candidateId];
			if (cost && (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0)) {
				model.cost = { ...cost };
				return;
			}
		}
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
 * Build one model from an authored spec. Bundled models.json rows are fully
 * materialized by the generator and consumed directly (see `models.ts`), so
 * this only runs for discovered/custom/override specs.
 */
export function buildModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
	const policy = resolveModelPolicy(spec);
	const supportsComputerUseConfig = explicitComputerUseConfig(spec);
	const model: Model<TApi> = {
		...spec,
		// An exact `thinking-efforts` rule upgrades a stale `reasoning: false`
		// discovery default (see `resolveThinkingPolicy`); materialize the
		// correction so transports and the picker see a reasoning-capable model.
		reasoning: spec.reasoning || policy.thinking !== undefined,
		name: cleanModelName(spec.name),
		identity: policy.identity,
		requiresGlyphTokenization: policy.identity.class === "anthropic",
		tokenizer: spec.tokenizer ?? resolveModelTokenizer(spec.requestModelId ?? spec.id),
		thinking: policy.thinking,
		supportsComputerUse: supportsOpenAIGAComputerUse(spec, policy.identity, supportsComputerUseConfig),
		supportsComputerUseConfig,
		compat: policy.compat,
		compatConfig: spec.compat,
	};
	applyCatalogAssignments(model, policy.catalog);
	applyCatalogCorrections(model, policy.catalog);
	applyPricingPeerFallback(model);
	return model;
}
