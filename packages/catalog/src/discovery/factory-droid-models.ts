/**
 * Factory Droid (Droid Core + Standard Credits subscription) — static model
 * registry and wire protocol surface, reviewed against the official 0.228.0 CLI.
 *
 * Discovery logic (policy parsing, routing, availability filtering, model
 * building) lives in `./factory-droid.ts`; this module carries only the data
 * and the shared wire types it is built from.
 */

import type { GeneratedProvider } from "../models";

/** Base URL per wire protocol namespace (paths appended by the stream layer). */
export const FACTORY_DROID_COMPLETIONS_BASE_URL = "https://api.factory.ai/api/llm/o/v1";
export const FACTORY_DROID_RESPONSES_BASE_URL = "https://api.factory.ai/api/llm/o/v1";
export const FACTORY_DROID_ANTHROPIC_BASE_URL = "https://api.factory.ai/api/llm/a";
export const FACTORY_DROID_GOOGLE_BASE_URL = "https://api.factory.ai/api/llm/g/v1";

/** Client version reported to Factory's API. */
export const FACTORY_DROID_CLIENT_VERSION = "0.228.0";

/** Wire protocol used by the Factory proxy for each model. */
export type FactoryDroidWire = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generate";

/** Upstream router the proxy dispatches to; sent as the `x-api-provider` header. */
export type FactoryDroidUpstream =
	| "fireworks"
	| "baseten"
	| "mistral"
	| "anthropic"
	| "azure_anthropic"
	| "vertex_anthropic"
	| "bedrock_anthropic"
	| "openai"
	| "azure_openai"
	| "bedrock_openai"
	| "google"
	| "xai"
	| "snowflake";

/**
 * Account residency region, resolved from `GET /api/cli/whoami` at login.
 * `"global"` is the default residency region; the CLI's 0.228.0 table also
 * has `"us"`, which uses the same provider-filtering rules for known entries.
 */
export type FactoryDroidRegion = "global" | "eu";

/**
 * Serving regions from the CLI's `_o` upstream table (0.228.0). EU overrides
 * may explicitly select otherwise global-only upstreams; absent overrides
 * filter the default rotation by this table.
 */
export const FACTORY_DROID_UPSTREAM_REGIONS: Readonly<Record<FactoryDroidUpstream, readonly FactoryDroidRegion[]>> = {
	fireworks: ["global"],
	baseten: ["global"],
	mistral: ["global"],
	anthropic: ["global"],
	azure_anthropic: ["global"],
	vertex_anthropic: ["global", "eu"],
	bedrock_anthropic: ["global", "eu"],
	openai: ["global", "eu"],
	azure_openai: ["global"],
	bedrock_openai: ["global", "eu"],
	google: ["global"],
	xai: ["global"],
	snowflake: ["global"],
};

/** Vercel edge PoPs in Europe; unknown PoPs do not imply a residency region. */
const FACTORY_DROID_EU_EDGE_POPS: Readonly<Record<string, true>> = {
	arn1: true,
	cdg1: true,
	dub1: true,
	fra1: true,
	lhr1: true,
	mad1: true,
	mxp1: true,
	waw1: true,
};

/** European serving region inferred from the first PoP of `x-vercel-id`. */
export function factoryDroidEdgeRegion(headers: Headers): "eu" | undefined {
	const edge = headers.get("x-vercel-id")?.split("::", 1)[0]?.trim().toLowerCase();
	return edge != null && FACTORY_DROID_EU_EDGE_POPS[edge] === true ? "eu" : undefined;
}

/**
 * Effective upstream rotation for an account region. The CLI's `We` resolves
 * eligible upstreams and `I` preserves raw registry order for fallback choice.
 * Explicit overrides constrain membership; otherwise filter by serving region.
 */
export function resolveFactoryDroidRotation(
	input: FactoryDroidModelInput,
	region: string | undefined,
): readonly FactoryDroidUpstream[] {
	const override = region === "eu" ? input.euApiProviders : input.globalApiProviders;
	if (override !== undefined) return input.apiProviders.filter(upstream => override.includes(upstream));
	if (region === "eu") {
		return input.apiProviders.filter(upstream => FACTORY_DROID_UPSTREAM_REGIONS[upstream]?.includes("eu"));
	}
	return input.apiProviders;
}

/** Factory API host per residency region; EU accounts are served from the EU region. */
export function factoryDroidApiBaseUrl(region: string | undefined): string {
	return region === "eu" ? "https://api.eu.factory.ai" : "https://api.factory.ai";
}

/** Per-wire base URL for an account region; the stream layer appends the path suffix. */
export function factoryDroidWireBaseUrl(wire: FactoryDroidWire, region: string | undefined): string {
	const host = factoryDroidApiBaseUrl(region);
	switch (wire) {
		case "openai-completions":
		case "openai-responses":
			return `${host}/api/llm/o/v1`;
		case "anthropic-messages":
			return `${host}/api/llm/a`;
		case "google-generate":
			return `${host}/api/llm/g/v1`;
	}
}

/** How thinking is wired on the Anthropic messages path. */
export type FactoryDroidAnthropicThinking =
	/** `{thinking:{type:"adaptive"}, output_config:{effort}}` — modern Claude. */
	| "adaptive"
	/** Adaptive plus `display:"summarized"`. */
	| "adaptive-summarized"
	/** `{thinking:{type:"enabled",budget_tokens}}` + interleaved beta — older Claude. */
	| "budget-interleaved"
	/** Budget + `output_config.effort` + effort beta. */
	| "budget-effort-beta"
	/** Budget + `output_config.effort`, no betas — MiniMax on the Anthropic path. */
	| "budget-effort";

/** OpenAI Responses request shaping for GPT-series models. */
export interface FactoryDroidResponsesConfig {
	verbosity?: "low";
	serviceTier?: "priority";
	/** Defaults to true when absent; only false is written (gpt-5.1-codex-max). */
	parallelToolCalls?: boolean;
	/** Gates `prompt_cache_retention: "24h"`; absent means no retention. */
	extendedCache?: boolean;
	/** Emits `safety_identifier`; absent means no identifier. */
	safetyId?: boolean;
}

export interface FactoryDroidModelInput {
	id: string;
	/** Display name, e.g. "Kimi K3 (Droid Core)". */
	name: string;
	wire: FactoryDroidWire;
	/** Billing pool; when absent, the completions wire is Core and all other wires are Standard. */
	pool?: "core" | "standard";
	contextWindow: number;
	maxTokens: number;
	/** Upstream rotation list; the first entry is the default `x-api-provider`. */
	apiProviders: readonly FactoryDroidUpstream[];
	/** Explicit global-region rotation, distinct from the registry's full upstream set. */
	globalApiProviders?: readonly FactoryDroidUpstream[];
	/**
	 * Explicit rotation override for EU-resident accounts (the CLI's
	 * `regionOverrides.eu`), mirrored verbatim. Absent ⇒ the default rotation
	 * is filtered to upstreams serving the EU; an empty list means the model
	 * is unavailable for EU accounts. Overrides may explicitly enable an
	 * upstream omitted from the EU upstream table (e.g. Mistral).
	 */
	euApiProviders?: readonly FactoryDroidUpstream[];
	/** Per-region context limits, when the official region override changes them. */
	euContextWindow?: number;
	euMaxTokens?: number;
	/**
	 * Droid Standard Credits rates: `input` is the per-token credit weight;
	 * `output` and `cacheRead` multiply that weight. Absent `output` defaults
	 * to 1; absent `cacheRead` means cache reads are not separately metered.
	 */
	credits?: {
		input: number;
		output?: number;
		cacheRead?: number;
	};
	/**
	 * Upstream catalog entry providing the raw-API list price for this model
	 * (the "$ what it would cost" counterfactual). Absent for Factory-only
	 * SKUs with no upstream equivalent: fast tiers are distinct SKUs (per
	 * variant-collapse cost-homogeneity doctrine) and preview codenames have
	 * no catalog entry.
	 */
	priceRef?: { provider: GeneratedProvider; modelId: string };
	/** Tool-result messages carry the tool `name` field on the wire. */
	toolMessageIncludesName?: boolean;
	/** Droid reasoning ladder; "off"/"none" entries mean thinking can be disabled. */
	supportedReasoningEfforts?: readonly string[];
	defaultReasoningEffort?: string;
	/**
	 * Statsig gate (from `GET /api/feature-flags`) that must be on for the
	 * account to see this model. Absent ⇒ always available.
	 */
	featureFlag?: string;
	/** Hard deprecation gate; when on, first-party clients hide this model. */
	deprecationFlag?: string;
	/** The registry requires a consent opt-in; absent policy must not expose it. */
	requiresExplicitOptIn?: boolean;
	/**
	 * Base model this entry is the fast tier of (the CLI's `baseVariant`).
	 * Org policy can withdraw fast tiers wholesale via managed settings'
	 * `isFastModelsAllowed`, and the presence of this field is what that gate
	 * keys off.
	 */
	baseVariant?: string;
	thinkingStyle?: FactoryDroidAnthropicThinking;
	/**
	 * Anthropic-wire refusal fallback chain (the CLI's `refusalFallbackModels`):
	 * sent as the request body's `fallbacks` list, which opts the request into
	 * the `server-side-fallback-2026-06-01` beta — on a refusal the proxy
	 * retries against these models server-side.
	 */
	refusalFallbackModels?: readonly string[];
	/** Gemini `thinkingConfig` supports MEDIUM in addition to LOW/HIGH. */
	geminiMedium?: boolean;
	responsesConfig?: FactoryDroidResponsesConfig;
	/** Per-upstream completions reasoning shaping (from the CLI's per-provider configs). */
	completionsReasoning?: {
		/** Fireworks: reasoning_history value emitted while thinking (effort != off). */
		fireworks?: { history: "preserved" | "interleaved" };
		/** Baseten thinking control mode. */
		baseten?: { mode: "opt-in" | "reasoning-effort" | "forced-on" };
	};
	/**
	 * How the completions transport replays reasoning content on assistant
	 * turns, matching the provider's per-model families: "capture-only"
	 * (Kimi) replays only what was captured, "standard" (GLM-5.1/5.2,
	 * Nemotron 3 Ultra) mirrors the captured content, and
	 * "placeholder" (DeepSeek V4) emits a synthetic placeholder on tool calls.
	 */
	reasoningReplay?: "capture-only" | "standard" | "placeholder";
	fastMode?: boolean;
	noImageSupport?: boolean;
}
export const FACTORY_DROID_MODELS: readonly FactoryDroidModelInput[] = [
	{
		id: "claude-fable-5.1",
		name: "Fable 5.1",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: [],
		credits: { input: 4, output: 5, cacheRead: 0.025 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		requiresExplicitOptIn: true,
		thinkingStyle: "adaptive-summarized",
		refusalFallbackModels: ["claude-opus-5"],
	},
	{
		id: "claude-fable-5",
		name: "Fable 5",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: [],
		credits: { input: 4, output: 5 },
		priceRef: { provider: "anthropic", modelId: "claude-fable-5" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		requiresExplicitOptIn: true,
		thinkingStyle: "adaptive-summarized",
		refusalFallbackModels: ["claude-opus-5"],
	},
	{
		id: "claude-opus-5-5",
		name: "Opus 5.5",
		wire: "anthropic-messages",
		contextWindow: 872000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic", "azure_anthropic"],
		credits: { input: 1.6, output: 5, cacheRead: 0.05 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		priceRef: { provider: "anthropic", modelId: "claude-opus-5-5" },
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "claude-opus-5-5-fast",
		name: "Opus 5.5 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 872000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 3.2, output: 5, cacheRead: 0.05 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "claude_opus_5_5_fast",
		baseVariant: "claude-opus-5-5",
		thinkingStyle: "adaptive-summarized",
		fastMode: true,
	},
	{
		id: "claude-opus-5",
		name: "Opus 5",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic", "azure_anthropic", "snowflake"],
		euApiProviders: ["bedrock_anthropic"],
		credits: { input: 2 },
		priceRef: { provider: "anthropic", modelId: "claude-opus-5" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "claude-opus-5-fast",
		name: "Opus 5 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 4 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		baseVariant: "claude-opus-5",
		thinkingStyle: "adaptive-summarized",
		fastMode: true,
	},
	{
		id: "claude-opus-4-8",
		name: "Opus 4.8",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: ["bedrock_anthropic"],
		credits: { input: 2 },
		priceRef: { provider: "anthropic", modelId: "claude-opus-4-8" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "claude-opus-4-8-fast",
		name: "Opus 4.8 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 4 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		baseVariant: "claude-opus-4-8",
		thinkingStyle: "adaptive-summarized",
		fastMode: true,
	},
	{
		id: "claude-opus-4-7",
		name: "Opus 4.7",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: ["bedrock_anthropic"],
		credits: { input: 2 },
		priceRef: { provider: "anthropic", modelId: "claude-opus-4-7" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "claude-opus-4-6",
		name: "Opus 4.6",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		credits: { input: 2 },
		priceRef: { provider: "anthropic", modelId: "claude-opus-4-6" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "max"],
		defaultReasoningEffort: "high",
		thinkingStyle: "adaptive",
	},
	{
		id: "claude-opus-4-5-20251101",
		name: "Opus 4.5",
		wire: "anthropic-messages",
		contextWindow: 180000,
		maxTokens: 64000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		credits: { input: 2 },
		priceRef: { provider: "anthropic", modelId: "claude-opus-4-5-20251101" },
		supportedReasoningEfforts: ["off", "low", "medium", "high"],
		defaultReasoningEffort: "off",
		thinkingStyle: "budget-effort-beta",
	},
	{
		id: "claude-sonnet-5-5",
		name: "Sonnet 5.5",
		wire: "anthropic-messages",
		contextWindow: 872000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic", "azure_anthropic"],
		credits: { input: 0.8, output: 5 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_sonnet_5_5",
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "claude-sonnet-5",
		name: "Sonnet 5",
		wire: "anthropic-messages",
		contextWindow: 872000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		credits: { input: 0.8, output: 5 },
		priceRef: { provider: "anthropic", modelId: "claude-sonnet-5" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "claude-sonnet-4-6",
		name: "Sonnet 4.6",
		wire: "anthropic-messages",
		contextWindow: 931000,
		maxTokens: 64000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		credits: { input: 1.2 },
		priceRef: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "max"],
		defaultReasoningEffort: "high",
		thinkingStyle: "adaptive",
	},
	{
		id: "claude-sonnet-4-5-20250929",
		name: "Sonnet 4.5",
		wire: "anthropic-messages",
		contextWindow: 180000,
		maxTokens: 32000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		credits: { input: 1.2 },
		priceRef: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
		supportedReasoningEfforts: ["off", "low", "medium", "high"],
		defaultReasoningEffort: "off",
		thinkingStyle: "budget-interleaved",
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Haiku 4.5",
		wire: "anthropic-messages",
		contextWindow: 180000,
		maxTokens: 32000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		credits: { input: 0.4 },
		priceRef: { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
		supportedReasoningEfforts: ["off", "low", "medium", "high"],
		defaultReasoningEffort: "off",
		thinkingStyle: "budget-interleaved",
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		euApiProviders: [],
		credits: { input: 4, output: 5 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		priceRef: { provider: "openai", modelId: "gpt-6-astra" },
	},
	{
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.8, output: 5 },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_6_sol",
		priceRef: { provider: "openai", modelId: "gpt-6-sol" },
		responsesConfig: { parallelToolCalls: true, extendedCache: true, safetyId: true, verbosity: "low" },
	},
	{
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.04, output: 5 },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_6_luna",
		priceRef: { provider: "openai", modelId: "gpt-6-luna" },
		responsesConfig: { parallelToolCalls: true, extendedCache: true, safetyId: true, verbosity: "low" },
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai", "azure_openai", "snowflake"],
		euApiProviders: ["openai"],
		credits: { input: 2, output: 5 },
		priceRef: { provider: "openai", modelId: "gpt-5.6-sol" },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.6-sol-fast",
		name: "GPT-5.6 Sol Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "azure_openai"],
		credits: { input: 4, output: 5 },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		baseVariant: "gpt-5.6-sol",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai", "azure_openai", "snowflake"],
		euApiProviders: ["openai"],
		credits: { input: 0.8, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.6-terra" },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai", "azure_openai", "snowflake"],
		euApiProviders: ["openai"],
		credits: { input: 0.08, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.6-luna" },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai", "azure_openai", "snowflake"],
		euApiProviders: ["openai"],
		credits: { input: 2, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.5" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.5-fast",
		name: "GPT-5.5 Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "azure_openai"],
		credits: { input: 5, output: 6 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		baseVariant: "gpt-5.5",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
	},
	{
		id: "gpt-5.5-pro",
		name: "GPT-5.5 Pro",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 12, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.5-pro" },
		supportedReasoningEfforts: ["medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai", "azure_openai"],
		euApiProviders: ["openai"],
		credits: { input: 1, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.4" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.4-fast",
		name: "GPT-5.4 Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "azure_openai"],
		credits: { input: 2, output: 6 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		baseVariant: "gpt-5.4",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai", "azure_openai"],
		credits: { input: 0.3, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.4-mini" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.4-mini-fast",
		name: "GPT-5.4 Mini Fast Mode",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai", "azure_openai"],
		credits: { input: 0.6, output: 6 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		baseVariant: "gpt-5.4-mini",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai", "azure_openai"],
		credits: { input: 0.7 },
		priceRef: { provider: "openai", modelId: "gpt-5.3-codex" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
	},
	{
		id: "gpt-5.3-codex-fast",
		name: "GPT-5.3-Codex Fast Mode",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 1.4, output: 8 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		baseVariant: "gpt-5.3-codex",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai", "azure_openai"],
		credits: { input: 0.7 },
		priceRef: { provider: "openai", modelId: "gpt-5.2" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "low",
		responsesConfig: { verbosity: "low" },
	},
	{
		id: "garnet-07-15",
		name: "Garnet 07/15 (Preview)",
		wire: "google-generate",
		contextWindow: 1000000,
		maxTokens: 65536,
		apiProviders: ["google"],
		credits: { input: 0.6 },
		supportedReasoningEfforts: ["medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "garnet_0715",
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro",
		wire: "google-generate",
		contextWindow: 1000000,
		maxTokens: 65536,
		apiProviders: ["google"],
		credits: { input: 0.8 },
		priceRef: { provider: "google", modelId: "gemini-3.1-pro-preview" },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		geminiMedium: true,
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		wire: "google-generate",
		contextWindow: 1000000,
		maxTokens: 65536,
		apiProviders: ["google"],
		credits: { input: 0.6, output: 5 },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		geminiMedium: true,
		priceRef: { provider: "google", modelId: "gemini-3.8-flash" },
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		wire: "google-generate",
		contextWindow: 1000000,
		maxTokens: 65536,
		apiProviders: ["google"],
		credits: { input: 0.6, output: 5 },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		geminiMedium: true,
		priceRef: { provider: "google", modelId: "gemini-3.7-flash" },
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		wire: "google-generate",
		contextWindow: 1000000,
		maxTokens: 65536,
		apiProviders: ["google"],
		credits: { input: 0.6, output: 5 },
		priceRef: { provider: "google", modelId: "gemini-3.6-flash" },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		wire: "google-generate",
		contextWindow: 1000000,
		maxTokens: 65536,
		apiProviders: ["google"],
		credits: { input: 0.6 },
		priceRef: { provider: "google", modelId: "gemini-3.5-flash" },
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash",
		wire: "google-generate",
		contextWindow: 1000000,
		maxTokens: 65536,
		apiProviders: ["google"],
		credits: { input: 0.2 },
		priceRef: { provider: "google", modelId: "gemini-3-flash-preview" },
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
	},
	{
		id: "inkling",
		name: "Inkling",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 1007232,
		maxTokens: 32768,
		apiProviders: ["fireworks"],
		credits: { input: 0.4, output: 4.05, cacheRead: 0.17 },
		supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		priceRef: { provider: "fireworks", modelId: "inkling" },
		completionsReasoning: { fireworks: { history: "preserved" } },
		reasoningReplay: "capture-only",
	},
	{
		id: "mistral-medium-3.5",
		name: "Mistral Medium 3.5",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 192000,
		maxTokens: 64000,
		apiProviders: ["mistral"],
		euApiProviders: ["mistral"],
		credits: { input: 0.6, output: 5 },
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		reasoningReplay: "standard",
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 917504,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.06, output: 3.34, cacheRead: 0.2 },
		supportedReasoningEfforts: ["low", "high", "max"],
		defaultReasoningEffort: "high",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "standard",
		noImageSupport: true,
		priceRef: { provider: "fireworks", modelId: "glm-5.3-flash" },
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten", "mistral"],
		globalApiProviders: ["fireworks", "baseten"],
		euApiProviders: ["mistral"],
		credits: { input: 0.56, output: 3.15 },
		priceRef: { provider: "fireworks", modelId: "glm-5.3" },
		supportedReasoningEfforts: ["low", "high", "max"],
		defaultReasoningEffort: "max",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["baseten", "mistral"],
		globalApiProviders: ["baseten"],
		euApiProviders: ["mistral", "baseten"],
		euContextWindow: 200000,
		euMaxTokens: 65536,
		credits: { input: 0.56, output: 3.15 },
		priceRef: { provider: "fireworks", modelId: "glm-5.2" },
		supportedReasoningEfforts: ["off", "high", "max"],
		defaultReasoningEffort: "high",
		completionsReasoning: { baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
	{
		id: "glm-5.2-fast",
		name: "GLM-5.2 Fast",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 393216,
		maxTokens: 131072,
		apiProviders: ["baseten"],
		credits: { input: 0.84, output: 3.2 },
		supportedReasoningEfforts: ["off", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "glm_5_2_fast",
		baseVariant: "glm-5.2",
		completionsReasoning: { baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
	{
		id: "kimi-k3",
		name: "Kimi K3",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 196608,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 1.2, output: 5 },
		priceRef: { provider: "fireworks", modelId: "kimi-k3" },
		toolMessageIncludesName: true,
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "capture-only",
	},
	{
		id: "qwen3.8-max",
		name: "Qwen3.8 Max",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 131072,
		maxTokens: 131072,
		apiProviders: ["fireworks"],
		credits: { input: 0.8, output: 3 },
		supportedReasoningEfforts: ["low", "medium", "xhigh"],
		defaultReasoningEffort: "xhigh",
		noImageSupport: true,
		priceRef: { provider: "fireworks", modelId: "qwen3.8-max" },
		completionsReasoning: { fireworks: { history: "preserved" } },
		reasoningReplay: "capture-only",
	},
	{
		id: "nemotron-3-ultra",
		name: "Nemotron 3 Ultra",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 136464,
		maxTokens: 65536,
		apiProviders: ["baseten", "fireworks"],
		credits: { input: 0.24, output: 4 },
		priceRef: { provider: "baseten", modelId: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B" },
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "opt-in" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.12, output: 4, cacheRead: 0.1 },
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "deepseek_v4_1_flash",
		priceRef: { provider: "fireworks", modelId: "deepseek-v4.1-flash" },
		completionsReasoning: { fireworks: { history: "interleaved" }, baseten: { mode: "forced-on" } },
		reasoningReplay: "placeholder",
	},
	{
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.176, output: 3, cacheRead: 0.032 },
		priceRef: { provider: "fireworks", modelId: "deepseek-v4-flash-0731" },
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_deepseek_v4_flash_0731",
		completionsReasoning: { fireworks: { history: "interleaved" }, baseten: { mode: "forced-on" } },
		reasoningReplay: "placeholder",
		noImageSupport: true,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.528, output: 3, cacheRead: 0.034 },
		priceRef: { provider: "fireworks", modelId: "deepseek-v4-pro" },
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_deepseek_v4_pro",
		completionsReasoning: { fireworks: { history: "interleaved" }, baseten: { mode: "forced-on" } },
		reasoningReplay: "placeholder",
		noImageSupport: true,
	},
	{
		id: "minimax-m3",
		name: "MiniMax M3",
		wire: "openai-completions",
		pool: "core",
		contextWindow: 448000,
		maxTokens: 64000,
		apiProviders: ["fireworks"],
		credits: { input: 0.12, output: 4 },
		priceRef: { provider: "fireworks", modelId: "minimax-m3" },
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		featureFlag: "minimax_m3",
		reasoningReplay: "capture-only",
	},
	{
		id: "grok-4.7",
		name: "Grok 4.7",
		wire: "openai-responses",
		contextWindow: 436644,
		maxTokens: 63356,
		apiProviders: ["xai"],
		credits: { input: 0.8, output: 3, cacheRead: 0.25 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		priceRef: { provider: "xai", modelId: "grok-4.7" },
	},
	{
		id: "grok-4.6",
		name: "Grok 4.6",
		wire: "openai-responses",
		contextWindow: 200000,
		maxTokens: 63356,
		apiProviders: ["xai"],
		credits: { input: 0.8, output: 3, cacheRead: 0.25 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		priceRef: { provider: "xai", modelId: "grok-4.6" },
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		wire: "openai-responses",
		contextWindow: 200000,
		maxTokens: 63356,
		apiProviders: ["xai"],
		credits: { input: 0.8, output: 3, cacheRead: 0.15 },
		priceRef: { provider: "xai", modelId: "grok-4.5" },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
	},
	{
		id: "atlas-07-21",
		name: "Atlas 07/21 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 2 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "atlas_0721",
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "aster-07-15",
		name: "Aster 07/15 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 2 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "aster_0715",
		thinkingStyle: "adaptive-summarized",
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax M2.7",
		wire: "anthropic-messages",
		pool: "core",
		contextWindow: 196600,
		maxTokens: 64000,
		apiProviders: ["fireworks"],
		credits: { input: 0.12, output: 4 },
		priceRef: { provider: "fireworks", modelId: "minimax-m2.7" },
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		thinkingStyle: "budget-effort",
		noImageSupport: true,
	},
];

/** Model id → registry entry, for the provider wrapper's per-model wire config. */
export const FACTORY_DROID_MODEL_META: Readonly<Record<string, FactoryDroidModelInput>> = Object.fromEntries(
	FACTORY_DROID_MODELS.map(model => [model.id, model]),
);

/** Factory subscription billing pool; unknown IDs have no inferred entitlement. */
export function factoryDroidPoolForModel(modelId: string): "core" | "standard" | undefined {
	const meta = FACTORY_DROID_MODEL_META[modelId];
	if (!meta) return undefined;
	return meta.pool ?? (meta.wire === "openai-completions" ? "core" : "standard");
}
