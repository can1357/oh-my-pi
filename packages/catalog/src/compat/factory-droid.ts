/**
 * Factory Droid registry policy read from KDL: the roster seed and per-model
 * catalog axes in `rules/providers/factory-droid.kdl`, plus each model's wire
 * (`api-routes`) in `rules/runtime/behavior.kdl`. Discovery builds
 * account-scoped specs from it and the pi-ai provider re-reads it per request
 * to bind a model to the account serving it.
 */
import { isRecord, once } from "@oh-my-pi/pi-utils";
import type { Api, ModelSpec } from "../types";
import { FACTORY_DROID_WIRES, type FactoryDroidRegion, type FactoryDroidWire } from "../wire/factory-droid";
import { apiRouteFor } from "./behavior";
import { seedModels } from "./providers";
import { resolveCatalogAxes } from "./resolve";

const PROVIDER = "factory-droid";

/** Native token limits for one inference region. */
export interface FactoryDroidLimits {
	contextWindow: number | null;
	maxTokens: number | null;
}

/** Standard Credits rates: `input` is the per-token weight; `output` and `cacheRead` multiply it. */
export interface FactoryDroidCreditRates {
	input: number;
	output?: number;
	cacheRead?: number;
}

/** Account gates on one registry model (the `entitlement` axis). */
export interface FactoryDroidEntitlement {
	/** Feature flag that must be on for the account to see the model. */
	featureFlag?: string;
	/** Hard deprecation flag; when on, first-party clients hide the model. */
	deprecationFlag?: string;
	/** Hidden unless an org policy is known and does not require consent. */
	requiresExplicitOptIn: boolean;
	/** Base model this entry is the fast tier of; org policy can withdraw fast tiers as a class. */
	baseVariant?: string;
}

/** Registry facts for one Factory model. */
export interface FactoryDroidModelPolicy {
	wire: FactoryDroidWire;
	/** Registry upstream order; the first entry is the default `x-api-provider`. */
	rotation: readonly string[];
	/** Upstreams eligible per inference region; empty means the region does not serve the model. */
	regionUpstreams: Readonly<Record<FactoryDroidRegion, readonly string[]>>;
	/** Registry limits; EU entries override them where the region narrows the model. */
	limits: FactoryDroidLimits;
	euLimits: Partial<FactoryDroidLimits>;
	creditRates?: FactoryDroidCreditRates;
	/** Bundled catalog row whose list price the model shows. */
	listPriceFrom?: { provider: string; modelId: string };
	/** Provider family whose live routing defaults apply. */
	routingFamily?: string;
	/** Other ids organization policy may use for the model. */
	policyAliases: readonly string[];
	entitlement: FactoryDroidEntitlement;
	/** Native default with no caller effort is thinking off. */
	defaultReasoningOff: boolean;
}

/** One registry model: its roster row and resolved policy. */
export interface FactoryDroidRegistryModel {
	spec: ModelSpec<"factory-droid-agent">;
	policy: FactoryDroidModelPolicy;
}

function stringList(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" ? value : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function readPolicy(spec: ModelSpec<"factory-droid-agent">): FactoryDroidModelPolicy {
	const catalog = resolveCatalogAxes(spec);
	const routedApi = apiRouteFor(PROVIDER, spec.id)?.api;
	const euLimits = isRecord(catalog.regionLimitsEu) ? catalog.regionLimitsEu : {};
	const credits = isRecord(catalog.creditRates) ? catalog.creditRates : {};
	const entitlement = isRecord(catalog.entitlement) ? catalog.entitlement : {};
	const creditInput = numberField(credits, "input");
	const [priceProvider, priceModelId] = stringList(catalog.listPriceFrom) ?? [];
	const euContextWindow = numberField(euLimits, "contextWindow");
	const euMaxTokens = numberField(euLimits, "maxTokens");
	const creditOutput = numberField(credits, "output");
	const creditCacheRead = numberField(credits, "cacheRead");
	const featureFlag = stringField(entitlement, "featureFlag");
	const deprecationFlag = stringField(entitlement, "deprecationFlag");
	const baseVariant = stringField(entitlement, "baseVariant");
	return {
		wire: FACTORY_DROID_WIRES.find(wire => wire === routedApi) ?? "openai-completions",
		rotation: stringList(catalog.upstreamRotation) ?? [],
		regionUpstreams: {
			global: stringList(catalog.regionUpstreamsGlobal) ?? [],
			us: stringList(catalog.regionUpstreamsUs) ?? [],
			eu: stringList(catalog.regionUpstreamsEu) ?? [],
		},
		limits: { contextWindow: spec.contextWindow, maxTokens: spec.maxTokens },
		euLimits: {
			...(euContextWindow !== undefined && { contextWindow: euContextWindow }),
			...(euMaxTokens !== undefined && { maxTokens: euMaxTokens }),
		},
		...(creditInput !== undefined && {
			creditRates: {
				input: creditInput,
				...(creditOutput !== undefined && { output: creditOutput }),
				...(creditCacheRead !== undefined && { cacheRead: creditCacheRead }),
			},
		}),
		...(priceProvider !== undefined && {
			listPriceFrom: { provider: priceProvider, modelId: priceModelId ?? spec.id },
		}),
		...(typeof catalog.routingFamily === "string" && { routingFamily: catalog.routingFamily }),
		policyAliases: stringList(catalog.policyAliases) ?? [],
		entitlement: {
			...(featureFlag !== undefined && { featureFlag }),
			...(deprecationFlag !== undefined && { deprecationFlag }),
			requiresExplicitOptIn: entitlement.requiresExplicitOptIn === true,
			...(baseVariant !== undefined && { baseVariant }),
		},
		defaultReasoningOff: catalog.defaultReasoningOff === true,
	};
}

/** The registry roster in declaration order, each row with its resolved policy. */
export const factoryDroidRegistry = once((): readonly FactoryDroidRegistryModel[] =>
	seedModels<"factory-droid-agent">(PROVIDER).map(spec => ({ spec, policy: readPolicy(spec) })),
);

/** Registry policy for a model (by its request id); undefined for ids outside the registry. */
export function resolveFactoryDroidPolicy(
	model: Pick<ModelSpec<Api>, "id" | "requestModelId">,
): FactoryDroidModelPolicy | undefined {
	const id = model.requestModelId ?? model.id;
	return factoryDroidRegistry().find(entry => entry.spec.id === id)?.policy;
}

/**
 * Effective upstream rotation for an inference region: the registry order,
 * narrowed to the upstreams that region serves (or the model's own region
 * override). An empty result means the region cannot serve the model.
 */
export function resolveFactoryDroidRotation(
	policy: FactoryDroidModelPolicy,
	region: string | undefined,
): readonly string[] {
	const eligible = policy.regionUpstreams[region === "eu" || region === "us" ? region : "global"];
	return policy.rotation.filter(upstream => eligible.includes(upstream));
}

/** Native limits for an inference region; EU overrides fall back to the registry defaults. */
export function factoryDroidRegionalLimits(
	policy: FactoryDroidModelPolicy,
	region: string | undefined,
): FactoryDroidLimits {
	if (region !== "eu") return policy.limits;
	return {
		contextWindow: policy.euLimits.contextWindow ?? policy.limits.contextWindow,
		maxTokens: policy.euLimits.maxTokens ?? policy.limits.maxTokens,
	};
}
