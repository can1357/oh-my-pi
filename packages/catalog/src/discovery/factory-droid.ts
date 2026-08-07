import { isRecord } from "@oh-my-pi/pi-utils";
import { Effort } from "../effort";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { resolveFactoryDroidAuth } from "./factory-droid-auth";

/**
 * Factory Droid (Droid Core subscription) — direct HTTP integration.
 *
 * The subscription data plane is an OpenAI-compatible proxy at
 * `https://api.factory.ai/api/llm/o/v1` (Anthropic-format models ride
 * `/api/llm/a`, not covered here). There is no model-listing endpoint: the
 * Droid CLI ships its registry inside the binary, so we ship the same list
 * statically. Entries below mirror the CLI registry (context windows, output
 * caps, reasoning ladders, upstream routing hints) as of droid 0.189.0.
 */
export const FACTORY_DROID_BASE_URL = "https://api.factory.ai/api/llm/o/v1";

/**
 * Upstream router the proxy dispatches to for each model. Sent as the
 * required `x-api-provider` request header; values are the first entry of the
 * CLI registry's `apiProviders` rotation list.
 */
export type FactoryDroidUpstream = "fireworks" | "baseten";

export interface FactoryDroidModelInput {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	upstream: FactoryDroidUpstream;
	/** Droid reasoning ladder; "off"/"none" entries mean thinking can be disabled. */
	supportedReasoningEfforts?: readonly string[];
	defaultReasoningEffort?: string;
	noImageSupport?: boolean;
	/**
	 * Statsig gate (from `GET /api/feature-flags`) that must be on for the
	 * account to see this model. Absent ⇒ always available.
	 */
	featureFlag?: string;
}

const SUPPORTED_EFFORTS = new Set<string>([
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
]);

/**
 * Droid Core models served through the OpenAI-compatible proxy path
 * (`generic-chat-completion-api` in the CLI registry). Deprecated registry
 * entries (glm-4.7, glm-5, glm-5.1, kimi-k2.5) and Anthropic-format MiniMax
 * models are intentionally excluded.
 */
export const FACTORY_DROID_MODELS: readonly FactoryDroidModelInput[] = [
	{
		id: "kimi-k3",
		name: "Kimi K3 (Droid Core)",
		contextWindow: 262_144,
		maxTokens: 65_536,
		upstream: "fireworks",
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "kimi_k3",
	},
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6 (Droid Core)",
		contextWindow: 262_144,
		maxTokens: 65_536,
		upstream: "fireworks",
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
	},
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code (Droid Core)",
		contextWindow: 262_144,
		maxTokens: 65_536,
		upstream: "fireworks",
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "kimi_k2_7_code",
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro (Droid Core)",
		contextWindow: 1_040_000,
		maxTokens: 65_536,
		upstream: "fireworks",
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		noImageSupport: true,
	},
	{
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash (Droid Core)",
		contextWindow: 1_040_000,
		maxTokens: 131_072,
		upstream: "fireworks",
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		noImageSupport: true,
		featureFlag: "deepseek_v4_flash_0731",
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2 (Droid Core)",
		contextWindow: 1_040_000,
		maxTokens: 131_072,
		upstream: "fireworks",
		supportedReasoningEfforts: ["off", "high", "max"],
		defaultReasoningEffort: "high",
		noImageSupport: true,
		featureFlag: "glm_5_2",
	},
	{
		id: "glm-5.2-fast",
		name: "GLM-5.2 Fast (Droid Core)",
		contextWindow: 524_288,
		maxTokens: 131_072,
		upstream: "fireworks",
		supportedReasoningEfforts: ["off", "high", "max"],
		defaultReasoningEffort: "high",
		noImageSupport: true,
		featureFlag: "glm_5_2_fast",
	},
	{
		id: "glm-4.6",
		name: "GLM-4.6 (Droid Core)",
		contextWindow: 200_000,
		maxTokens: 128_000,
		upstream: "baseten",
		noImageSupport: true,
	},
	{
		id: "nemotron-3-ultra",
		name: "Nemotron 3 Ultra (Droid Core)",
		contextWindow: 202_000,
		maxTokens: 65_536,
		upstream: "baseten",
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		noImageSupport: true,
		featureFlag: "nemotron_3_ultra",
	},
];

/** Model id → upstream router for the proxy's required `x-api-provider` header. */
export const FACTORY_DROID_UPSTREAMS: Readonly<Record<string, FactoryDroidUpstream>> = Object.fromEntries(
	FACTORY_DROID_MODELS.map(model => [model.id, model.upstream]),
);

const FACTORY_FEATURE_FLAGS_URL = "https://api.factory.ai/api/feature-flags";
const FACTORY_MANAGED_SETTINGS_URL = "https://api.factory.ai/api/organization/managed-settings";
/** Matches the CLI version the wire contract was verified against; proxy rejects stale versions. */
const FACTORY_DROID_CLIENT_VERSION = "0.189.0";

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

/** Mirrors the client-side model gating: feature flags first, then org model policy. */
function isModelAvailable(
	model: FactoryDroidModelInput,
	flags: Record<string, unknown>,
	policy: FactoryModelPolicy | null,
): boolean {
	if (model.featureFlag !== undefined && flags[model.featureFlag] !== true) return false;
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
	fetch?: FetchImpl;
}

/**
 * Availability filter, not a catalog: Factory has no model-listing endpoint —
 * the CLI and desktop app both ship the same static registry and narrow it
 * with `GET /api/feature-flags` (Statsig gates) and the org model policy in
 * `GET /api/organization/managed-settings`. This does the same. Returns null
 * when no credential resolves or the flags fetch fails — callers keep the
 * static list, matching the CLI's cached-snapshot behavior. Policy-filter
 * failures do not hide models (self-hosted/legacy servers may lack it).
 */
export async function fetchFactoryDroidModels(
	options: FactoryDroidModelDiscoveryOptions = {},
): Promise<ModelSpec<"factory-droid-agent">[] | null> {
	const token = options.apiKey?.trim() || (await resolveFactoryDroidAuth())?.accessToken;
	if (!token) return null;
	const fetchImpl = options.fetch ?? fetch;
	const headers = {
		Authorization: `Bearer ${token}`,
		"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
		"X-Factory-Client": "cli",
	};
	let flags: Record<string, unknown>;
	let policy: FactoryModelPolicy | null = null;
	try {
		const [flagsResponse, settingsResponse] = await Promise.all([
			fetchImpl(FACTORY_FEATURE_FLAGS_URL, { headers }),
			fetchImpl(FACTORY_MANAGED_SETTINGS_URL, { headers }).catch(() => null),
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
	} catch {
		return null;
	}
	return FACTORY_DROID_MODELS.filter(model => isModelAvailable(model, flags, policy)).map(buildFactoryDroidModel);
}

export function buildFactoryDroidModel(input: FactoryDroidModelInput): ModelSpec<"factory-droid-agent"> {
	const thinking = buildFactoryDroidThinking(input.supportedReasoningEfforts, input.defaultReasoningEffort);
	return {
		id: input.id,
		name: input.name,
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl: FACTORY_DROID_BASE_URL,
		reasoning: thinking != null,
		input: input.noImageSupport ? ["text"] : ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		thinking,
		contextWindow: input.contextWindow,
		maxTokens: input.maxTokens,
	};
}

function buildFactoryDroidThinking(
	supported: readonly string[] | undefined,
	defaultEffort: string | undefined,
): ThinkingConfig | undefined {
	const available = supported ?? [];
	const efforts = available.filter((effort): effort is Effort => SUPPORTED_EFFORTS.has(effort));
	if (efforts.length === 0) return undefined;
	const supportsOff = available.includes("off") || available.includes("none");
	return {
		mode: "effort",
		efforts,
		...(supportsOff ? undefined : { requiresEffort: true }),
		...(defaultEffort && SUPPORTED_EFFORTS.has(defaultEffort)
			? { defaultLevel: defaultEffort as Effort }
			: undefined),
	};
}
