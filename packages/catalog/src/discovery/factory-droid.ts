import { isRecord } from "@oh-my-pi/pi-utils";
import { ANTHROPIC_THINKING, type Effort, THINKING_EFFORTS } from "../effort";
import { getBundledModel } from "../models";
import type { FactoryDroidCredits, FetchImpl, ModelSpec, ThinkingConfig, ThinkingControlMode } from "../types";
import {
	FACTORY_DROID_CLIENT_VERSION,
	FACTORY_DROID_MODELS,
	type FactoryDroidModelInput,
	factoryDroidApiBaseUrl,
	factoryDroidWireBaseUrl,
	resolveFactoryDroidRotation,
} from "./factory-droid-models";

/**
 * Factory Droid (Droid Core + Standard Credits subscription) — direct HTTP
 * integration.
 *
 * The model registry is bundled statically (see `./factory-droid-models.ts`):
 * Factory has no model-listing endpoint, so first-party clients ship that
 * table and narrow it live with Statsig feature flags and the org model
 * policy. This module holds the discovery logic: policy parsing, availability
 * filtering, routing, and building model specs from the registry.
 */

/** User-facing effort rungs, derived from the shared thinking ladder. */
const SUPPORTED_EFFORTS = new Set<string>(THINKING_EFFORTS);

/** Region-aware discovery endpoints; EU accounts are gated and routed from the EU host. */
function featureFlagsUrl(region: string | undefined): string {
	return `${factoryDroidApiBaseUrl(region)}/api/feature-flags`;
}

function managedSettingsUrl(region: string | undefined): string {
	return `${factoryDroidApiBaseUrl(region)}/api/organization/managed-settings`;
}

/** Org policy subset from `/api/organization/managed-settings` that gates models. */
interface FactoryModelPolicy {
	allowAllFactoryModels?: boolean;
	allowedModelIds?: string[];
	blockedModelIds?: string[];
}

function readModelPolicy(body: unknown): FactoryModelPolicy | null {
	if (!isRecord(body) || !isRecord(body.settings)) return null;
	const policy = body.settings.modelPolicy;
	if (!isRecord(policy)) return null;
	const ids = (key: "allowedModelIds" | "blockedModelIds"): string[] | undefined => {
		const value = policy[key];
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
	};
	return {
		allowAllFactoryModels:
			typeof policy.allowAllFactoryModels === "boolean" ? policy.allowAllFactoryModels : undefined,
		allowedModelIds: ids("allowedModelIds"),
		blockedModelIds: ids("blockedModelIds"),
	};
}

/**
 * Live `provider_routing` dynamic config from the flags payload: per-model
 * upstream rotations that override the registry's static order.
 */
interface FactoryProviderRouting {
	models?: Record<string, readonly string[]>;
}

/** Reads `configs.provider_routing` from the feature-flags payload. */
function readProviderRouting(body: Record<string, unknown>): FactoryProviderRouting | null {
	const configs = body.configs;
	if (configs == null || typeof configs !== "object") return null;
	const routing = (configs as Record<string, unknown>).provider_routing;
	if (routing == null || typeof routing !== "object") return null;
	const models = (routing as Record<string, unknown>).models;
	if (models == null || typeof models !== "object" || Array.isArray(models)) return null;
	const parsed: Record<string, readonly string[]> = {};
	for (const [modelId, providers] of Object.entries(models as Record<string, unknown>)) {
		if (Array.isArray(providers) && providers.every(p => typeof p === "string")) parsed[modelId] = providers;
	}
	return { models: parsed };
}

/** Mirrors the client-side model gating: feature flags first, then org model policy. */
function isModelAvailable(
	model: FactoryDroidModelInput,
	flags: Record<string, unknown>,
	policy: FactoryModelPolicy | null,
	region: string | undefined,
): boolean {
	// Region gating (the CLI's `nJH`): a model with no upstream serving the
	// account's region is hidden outright — this is what removes Droid Core
	// (fireworks/baseten-only) and Gemini (google-only) for EU accounts.
	if (resolveFactoryDroidRotation(model, region).length === 0) return false;
	if (model.featureFlag !== undefined && flags[model.featureFlag] !== true) return false;
	if (model.deprecationFlag !== undefined && flags[model.deprecationFlag] === true) return false;
	if (policy?.blockedModelIds?.includes(model.id)) return false;
	if (
		policy?.allowAllFactoryModels === false &&
		policy.allowedModelIds &&
		!policy.allowedModelIds.includes(model.id)
	) {
		return false;
	}
	return true;
}

export interface FactoryDroidModelDiscoveryOptions {
	/** OMP-stored WorkOS access token (from `/login factory-droid`), when present. */
	apiKey?: string;
	/**
	 * Account residency region from the stored OAuth credential (`whoami` at
	 * login). `"eu"` switches discovery to the EU host, hides models with no
	 * EU-serving upstream, and resolves EU rotations. Absent ⇒ `"global"`.
	 */
	region?: string;
	fetch?: FetchImpl;
}

/**
 * Availability filter, not a catalog: Factory has no model-listing endpoint,
 * so the bundled registry is narrowed live with `GET /api/feature-flags`
 * (Statsig gates) and the org model policy in
 * `GET /api/organization/managed-settings`. Returns null when no credential
 * resolves or the flags fetch fails — callers keep the static list as an
 * offline snapshot. Policy-filter failures do not hide models
 * (self-hosted/legacy servers may lack it).
 */
export async function fetchFactoryDroidModels(
	options: FactoryDroidModelDiscoveryOptions = {},
): Promise<ModelSpec<"factory-droid-agent">[] | null> {
	const token = options.apiKey?.trim();
	if (!token) return null;
	const fetchImpl = options.fetch ?? fetch;
	const headers = {
		Authorization: `Bearer ${token}`,
		"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
		"X-Factory-Client": "cli",
	};
	let flags: Record<string, unknown>;
	let policy: FactoryModelPolicy | null = null;
	let routing: FactoryProviderRouting | null = null;
	try {
		const [flagsResponse, settingsResponse] = await Promise.all([
			fetchImpl(featureFlagsUrl(options.region), { headers }),
			fetchImpl(managedSettingsUrl(options.region), { headers }).catch(() => null),
		]);
		if (!flagsResponse.ok) return null;
		const body: unknown = await flagsResponse.json();
		if (body == null || typeof body !== "object" || !("flags" in body)) return null;
		const raw = body.flags;
		if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
		flags = raw as Record<string, unknown>;
		if (settingsResponse?.ok) {
			policy = readModelPolicy(await settingsResponse.json());
		}
		routing = readProviderRouting(body as Record<string, unknown>);
	} catch {
		return null;
	}
	return FACTORY_DROID_MODELS.filter(model => isModelAvailable(model, flags, policy, options.region)).map(model =>
		buildFactoryDroidModel(
			model,
			resolveRotation(model, routing?.models?.[model.id], options.region),
			options.region,
		),
	);
}

/**
 * Rotation for one discovered model: the account region resolves the base
 * rotation (override or region-filtered), then a live `provider_routing`
 * entry narrows it. For the global region the routing entry applies verbatim
 * (existing behavior); for EU it is intersected with the region-resolved set
 * so a US-centric routing entry cannot resurrect a global-only upstream.
 */
function resolveRotation(
	input: FactoryDroidModelInput,
	routed: readonly string[] | undefined,
	region: string | undefined,
): readonly string[] | undefined {
	if (region !== "eu") return routed ?? undefined;
	const regionResolved = resolveFactoryDroidRotation(input, region);
	if (!routed) return regionResolved;
	const intersection = routed.filter(p => (regionResolved as readonly string[]).includes(p));
	return intersection.length > 0 ? intersection : regionResolved;
}

export function buildFactoryDroidModel(
	input: FactoryDroidModelInput,
	resolvedApiProviders?: readonly string[],
	region?: string,
): ModelSpec<"factory-droid-agent"> {
	const thinking = buildFactoryDroidThinking(input);
	// Runtime-unsafe lookup by design: a models.json regen can drop a referenced
	// id, and a missing reference must degrade to zero cost, not break discovery.
	const reference = input.priceRef ? getBundledModel(input.priceRef.provider, input.priceRef.modelId) : undefined;
	return {
		id: input.id,
		name: input.name,
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl: factoryDroidWireBaseUrl(input.wire, region),
		reasoning: thinking != null,
		input: input.noImageSupport ? ["text"] : ["text", "image"],
		cost: reference?.cost ? { ...reference.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		thinking,
		contextWindow: input.contextWindow,
		maxTokens: input.maxTokens,
		...(input.credits ? { factoryDroidCredits: projectFactoryDroidCredits(input.credits) } : {}),
		...(resolvedApiProviders?.length ? { factoryDroidApiProviders: [...resolvedApiProviders] } : {}),
	};
}

/**
 * Project the registry's relative credit multipliers into effective per-token
 * rates: `output` defaults to the input rate when the CLI table declares no
 * `outputTokenMultiplier`; `cacheRead` is reported only when separately metered.
 */
export function projectFactoryDroidCredits(
	credits: NonNullable<FactoryDroidModelInput["credits"]>,
): FactoryDroidCredits {
	// Rates are rendered and compared, never accumulated — round off float dust
	// (0.8 * 3 = 2.4000000000000004) at the projection boundary.
	const rate = (n: number): number => Math.round(n * 1e6) / 1e6;
	return {
		input: rate(credits.input),
		output: rate(credits.input * (credits.output ?? 1)),
		...(credits.cacheRead != null ? { cacheRead: rate(credits.input * credits.cacheRead) } : {}),
	};
}

/**
 * The thinking control mode rides the wire family, not the model: Anthropic
 * variants use per-model adaptive vs budget thinking, Gemini uses
 * thinkingLevel, and the completions/responses families take the generic
 * effort field.
 */
function buildFactoryDroidThinking(input: FactoryDroidModelInput): ThinkingConfig | undefined {
	const available = input.supportedReasoningEfforts ?? [];
	const efforts = available.filter((effort): effort is Effort => SUPPORTED_EFFORTS.has(effort));
	if (efforts.length === 0) return undefined;
	const supportsOff = available.includes("off") || available.includes("none");
	const mode: ThinkingControlMode =
		input.wire === "google-generate"
			? "google-level"
			: input.wire === "anthropic-messages"
				? input.thinkingStyle === "budget-interleaved"
					? "budget"
					: input.thinkingStyle === "budget-effort" || input.thinkingStyle === "budget-effort-beta"
						? "anthropic-budget-effort"
						: "anthropic-adaptive"
				: "effort";
	return {
		mode,
		efforts,
		...(mode === "anthropic-adaptive" && input.thinkingStyle === "adaptive-summarized"
			? { supportsDisplay: true }
			: {}),
		requiresEffort: !supportsOff,
		...(input.defaultReasoningEffort && SUPPORTED_EFFORTS.has(input.defaultReasoningEffort)
			? { defaultLevel: input.defaultReasoningEffort as Effort }
			: undefined),
		// Budget-based thinking (budget-interleaved, budget-effort, budget-effort-beta)
		// carries the standard OMP ladder so callers read the model, not a local table.
		...(mode === "budget" || mode === "anthropic-budget-effort" ? { effortBudgets: ANTHROPIC_THINKING } : {}),
	};
}
