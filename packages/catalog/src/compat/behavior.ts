/**
 * Typed accessors over the compiled runtime-behavior vocabulary
 * (`rules/runtime/behavior.kdl`): provider/model heuristics that run before
 * or outside exact bundled-model lookup — responses routing, API routing,
 * quota tiers, plan requirements, model limits, roster exclusions, hosted
 * defaults, and pricing peers.
 */
import { globMatch } from "./cascade";
import rules from "./rules.json";
import type { CompiledMatchList } from "./types";

const behavior = rules.behavior;

function matchesList(match: CompiledMatchList, model: string, modelLower: string): boolean {
	if (match.exact?.some(candidate => candidate === model)) return true;
	if (match.prefix?.some(prefix => model.startsWith(prefix))) return true;
	if (match.substring?.some(sub => model.includes(sub))) return true;
	if (match.token !== undefined) {
		const parts = modelLower.split(/[^a-z0-9]+/);
		if (match.token.some(token => parts.includes(token))) return true;
	}
	if (match.glob?.some(pattern => globMatch(pattern, modelLower))) return true;
	return false;
}

/**
 * Conservative heuristic for a normalized, lowercase discovered model id with
 * no exact bundled record: whether it likely rides the OpenAI Responses API.
 */
export function isLikelyOpenAIResponsesId(model: string): boolean {
	const rule = behavior.openaiResponsesHeuristic;
	if (!rule) return false;
	if (rule.excludePrefixes.some(prefix => model.startsWith(prefix))) return false;
	if (rule.excludeSubstrings.some(sub => model.includes(sub))) return false;
	return rule.includePrefixes.some(prefix => model.startsWith(prefix));
}

/**
 * Additional catalog-declared operations for a discovered provider/model pair
 * (e.g. `generate_image`), augmenting provider discovery metadata.
 */
export function modelOperationOverrides(provider: string, model: string): readonly string[] {
	const lower = model.toLowerCase();
	const out: string[] = [];
	for (const rule of behavior.modelOperations) {
		if (rule.provider !== provider || !matchesList(rule.models, lower, lower)) continue;
		for (const operation of rule.operations) {
			if (!out.includes(operation)) out.push(operation);
		}
	}
	return out;
}

/**
 * Splits a Cursor effort-suffixed OpenAI sibling id into its base id and
 * declared effort tier. The family gate requires the declared marker
 * (`gpt-`) followed immediately by an ASCII digit; matching stays
 * case-sensitive to preserve Cursor wire-id behavior.
 */
export function cursorEffortSuffix(model: string): { base: string; tier: string } | undefined {
	const rule = behavior.cursorEffort;
	if (!rule) return undefined;
	for (const tier of rule.tiers) {
		if (!model.endsWith(tier)) continue;
		const prefix = model.slice(0, model.length - tier.length);
		if (!prefix.endsWith("-")) continue;
		const base = prefix.slice(0, -1);
		let family = false;
		let index = base.indexOf(rule.familyMarker);
		while (index !== -1) {
			const next = base.charCodeAt(index + rule.familyMarker.length);
			if (next >= 48 && next <= 57) {
				family = true;
				break;
			}
			index = base.indexOf(rule.familyMarker, index + 1);
		}
		if (!family) return undefined;
		return { base, tier };
	}
	return undefined;
}

/** Fixed Cursor `requestedModel` parameters declared for an exact wire model. */
export function cursorModelParameters(model: string): readonly { id: string; value: string }[] {
	return behavior.cursorParameters.filter(parameter => parameter.model === model);
}

/**
 * The catalog-declared quota scope or display tier for a provider model id.
 * Exact authored memberships win; provider-authored substring fallbacks
 * preserve quota semantics for newly discovered ids.
 */
export function quotaTierFor(provider: string, model: string): string | undefined {
	const rule = behavior.quotaTiers.find(candidate => candidate.provider === provider);
	if (!rule) return undefined;
	for (const tier of rule.tiers) {
		if (tier.models.includes(model)) return tier.label;
	}
	for (const fallback of rule.fallbacks) {
		if (model.includes(fallback.substring)) return fallback.label;
	}
	return undefined;
}

/** Whether a provider has catalog-authored model quota scopes. */
export function hasQuotaTierPolicy(provider: string): boolean {
	return behavior.quotaTiers.some(rule => rule.provider === provider);
}

/** The provider-default wire model for a model-less hosted operation. */
export function hostedDefaultModel(provider: string): string | undefined {
	return behavior.hostedDefaults.find(entry => entry.provider === provider)?.model;
}

/** One resolved API route for a provider model id. */
export interface ApiRouteMatch {
	/** Transport API the id rides. */
	api: string;
	/** Wire id after prefix stripping, when the route declares `strip-prefix`. */
	requestModelId?: string;
}

/**
 * Resolves the declared API route for a provider model id. Routes match in
 * declaration order; a `strip-prefix` route with a prefix matcher strips the
 * matched prefix off the wire id. Falls back to the node's `default` API.
 */
export function apiRouteFor(provider: string, model: string): ApiRouteMatch | undefined {
	const table = behavior.apiRoutes.find(candidate => candidate.provider === provider);
	if (!table) return undefined;
	const lower = model.toLowerCase();
	for (const route of table.routes) {
		if (!matchesList(route.match, model, lower)) continue;
		const out: ApiRouteMatch = { api: route.api };
		if (route.stripPrefix) {
			const prefix = route.match.prefix?.find(candidate => model.startsWith(candidate));
			if (prefix) out.requestModelId = model.slice(prefix.length);
		}
		return out;
	}
	return table.default !== undefined ? { api: table.default } : undefined;
}

/** Exact model ids named by a provider's api-routes rules (cache-migration drop lists). */
export function apiRouteExactModelIds(provider: string): string[] {
	const table = behavior.apiRoutes.find(candidate => candidate.provider === provider);
	if (!table) return [];
	const ids: string[] = [];
	for (const route of table.routes) {
		for (const id of route.match.exact ?? []) {
			if (!ids.includes(id)) ids.push(id);
		}
	}
	return ids;
}

/** Declared context-window / max-token pins for a provider model id. */
export function modelLimitsFor(provider: string, model: string): { context?: number; maxTokens?: number } | undefined {
	for (const table of behavior.modelLimits) {
		if (table.provider !== provider) continue;
		const limit = table.limits.find(entry => entry.model === model);
		if (limit) {
			const out: { context?: number; maxTokens?: number } = {};
			if (limit.context !== undefined) out.context = limit.context;
			if (limit.maxTokens !== undefined) out.maxTokens = limit.maxTokens;
			return out;
		}
	}
	return undefined;
}

/** Whether a provider roster entry is a declared non-chat/unsupported SKU. */
export function isExcludedModel(provider: string, model: string): boolean {
	const lower = model.toLowerCase();
	return behavior.excludeModels.some(rule => rule.provider === provider && matchesList(rule.match, lower, lower));
}

/** The declared subscription tier required to use a provider model id, if any. */
export function planRequirementFor(provider: string, model: string): string | undefined {
	const rule = behavior.planRequirements.find(candidate => candidate.provider === provider);
	if (!rule) return undefined;
	const lower = model.toLowerCase();
	for (const tier of rule.tiers) {
		if (matchesList(tier.match, model, lower)) return tier.tier;
	}
	return undefined;
}

/** Cross-provider pricing-peer resolution for one provider model id. */
export function pricingPeerFor(
	provider: string,
	model: string,
): { peers: readonly string[]; peerId: string } | undefined {
	const rule = behavior.pricingPeers.find(candidate => candidate.provider === provider);
	if (!rule) return undefined;
	const alias = rule.aliases.find(candidate => candidate.model === model);
	return { peers: rule.peers, peerId: alias?.peerId ?? model };
}
