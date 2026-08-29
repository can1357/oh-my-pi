import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, ApiKey, Model, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import type { ApiKeyResolverRegistry } from "../config/api-key-resolver";
import {
	getModelMatchPreferences,
	type ModelLookupRegistry,
	parseModelPattern,
	resolveModelRoleValue,
	resolveRoleSelection,
} from "../config/model-resolver";
import { MODEL_ROLE_IDS } from "../config/model-roles";
import { hasExplicitRoleServiceTier, resolveRoleServiceTier } from "../config/service-tier";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };

export interface ResolvedCommitModel {
	model: Model<Api>;
	/**
	 * Resolver for the model's bearer: re-resolves on 401 / usage-limit so the
	 * whole commit pipeline (analysis, map/reduce, changelog) inherits the
	 * central force-refresh + account-rotation policy.
	 */
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	/** Per-role processing tier from `modelRoleTiers` (undefined = omit). */
	serviceTier?: ServiceTier;
	/**
	 * True when `modelRoleTiers` carries an explicit entry for the resolved
	 * lane (including `"none"`), so consumers with an ambient tier should let
	 * `serviceTier === undefined` clear it rather than fall back.
	 */
	serviceTierExplicit?: boolean;
}

type CommitModelRegistry = ModelLookupRegistry &
	ApiKeyResolverRegistry & {
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	};

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	const resolved = override
		? resolveModelRoleValue(override, available, { settings, matchPreferences, modelRegistry })
		: resolveRoleSelection(["commit", "smol", ...MODEL_ROLE_IDS], settings, available, modelRegistry);
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return {
		model,
		apiKey: modelRegistry.resolver(model),
		thinkingLevel: resolved?.thinkingLevel,
		serviceTier: resolved && "serviceTier" in resolved ? resolved.serviceTier : undefined,
	};
}

export async function resolveSmolModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: ApiKey,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	// The smol tier applies to the whole smol lane — the role-selection match,
	// the MODEL_PRIO fallback, and the primary-model fallback — so a configured
	// `modelRoleTiers.smol` survives regardless of which candidate resolves.
	const roleTiers = typeof settings.getModelRoleTiers === "function" ? settings.getModelRoleTiers() : undefined;
	const smolServiceTier = resolveRoleServiceTier(roleTiers, "smol");
	const smolServiceTierExplicit = hasExplicitRoleServiceTier(roleTiers, "smol");
	const resolvedSmol = resolveRoleSelection(["smol"], settings, available, modelRegistry);
	if (resolvedSmol?.model) {
		const apiKey = await modelRegistry.getApiKey(resolvedSmol.model);
		if (apiKey) {
			return {
				model: resolvedSmol.model,
				apiKey: modelRegistry.resolver(resolvedSmol.model),
				thinkingLevel: resolvedSmol.thinkingLevel,
				serviceTier: smolServiceTier,
				serviceTierExplicit: smolServiceTierExplicit,
			};
		}
	}

	const matchPreferences = getModelMatchPreferences(settings);
	for (const pattern of MODEL_PRIO.smol) {
		const candidate = parseModelPattern(pattern, available, matchPreferences, { modelRegistry }).model;
		if (!candidate) continue;
		const apiKey = await modelRegistry.getApiKey(candidate);
		if (apiKey) {
			return {
				model: candidate,
				apiKey: modelRegistry.resolver(candidate),
				serviceTier: smolServiceTier,
				serviceTierExplicit: smolServiceTierExplicit,
			};
		}
	}

	return {
		model: fallbackModel,
		apiKey: fallbackApiKey,
		serviceTier: smolServiceTier,
		serviceTierExplicit: smolServiceTierExplicit,
	};
}
