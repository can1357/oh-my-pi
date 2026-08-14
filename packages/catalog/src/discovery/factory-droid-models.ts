/**
 * Factory Droid (Droid Core + Standard Credits subscription) — static model
 * registry and wire protocol surface, hand-maintained against live traffic.
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
export const FACTORY_DROID_CLIENT_VERSION = "0.195.0";

/**
 * Wire protocol the proxy expects for a model:
 * - `openai-completions`: `/api/llm/o/v1/chat/completions` (Droid Core)
 * - `openai-responses`: `/api/llm/o/v1/responses` (GPT series + Grok)
 * - `anthropic-messages`: `/api/llm/a/v1/messages` (Claude + MiniMax)
 * - `google-generate`: `/api/llm/g/v1/generate` (Gemini, native generateContent SSE)
 */
export type FactoryDroidWire = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generate";

/** Upstream router the proxy dispatches to; sent as the `x-api-provider` header. */
export type FactoryDroidUpstream =
	| "fireworks"
	| "baseten"
	| "anthropic"
	| "vertex_anthropic"
	| "bedrock_anthropic"
	| "openai"
	| "azure_openai"
	| "bedrock_openai"
	| "google"
	| "xai";

/**
 * Account residency region, resolved from `GET /api/cli/whoami` at login.
 * `"global"` is the default (US) region; the CLI keys every region behavior
 * off the literal `"eu"`, so any other value behaves as `"global"`.
 */
export type FactoryDroidRegion = "global" | "eu";

/**
 * Regions each upstream serves, ported from the CLI's upstream→regions table
 * (`LA0` in the 0.195.0 bundle). `"global"`-only upstreams are unreachable
 * for EU accounts: the CLI filters them out of every model's rotation, which
 * is why Droid Core (fireworks/baseten-only) and Gemini (google-only) vanish
 * from the EU model list.
 */
export const FACTORY_DROID_UPSTREAM_REGIONS: Readonly<Record<FactoryDroidUpstream, readonly FactoryDroidRegion[]>> = {
	fireworks: ["global"],
	baseten: ["global"],
	anthropic: ["global"],
	vertex_anthropic: ["global", "eu"],
	bedrock_anthropic: ["global", "eu"],
	openai: ["global", "eu"],
	azure_openai: ["global"],
	bedrock_openai: ["global", "eu"],
	google: ["global"],
	xai: ["global"],
};

/**
 * Effective upstream rotation for an account region, ported from the CLI's
 * rotation resolver (`nJH`): an explicit per-region override wins verbatim
 * (an empty list means the model is unavailable in that region), otherwise
 * the default rotation is filtered to upstreams serving the region.
 */
export function resolveFactoryDroidRotation(
	input: FactoryDroidModelInput,
	region: string | undefined,
): readonly FactoryDroidUpstream[] {
	if (region === "eu") {
		if (input.euApiProviders !== undefined) return input.euApiProviders;
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
	contextWindow: number;
	maxTokens: number;
	/** Upstream rotation list; the first entry is the default `x-api-provider`. */
	apiProviders: readonly FactoryDroidUpstream[];
	/**
	 * Explicit rotation override for EU-resident accounts (the CLI's
	 * `regionOverrides.eu`), mirrored verbatim. Absent ⇒ the default rotation
	 * is filtered to upstreams serving the EU; an empty list means the model
	 * is unavailable for EU accounts.
	 */
	euApiProviders?: readonly FactoryDroidUpstream[];
	/**
	 * Droid Standard Credits rates, mirrored verbatim from the CLI's model
	 * table: `input` is the per-token credit weight (`tokenMultiplier`);
	 * `output`/`cacheRead` are multipliers applied to the input rate for
	 * output and cache-read tokens (`outputTokenMultiplier`,
	 * `cacheReadTokenMultiplier`). Absent `output` defaults to 1 (output
	 * billed at the input rate); absent `cacheRead` means cache reads are
	 * not separately metered. The CLI's promo fields are intentionally not
	 * mirrored — every promo to date expired before this integration shipped.
	 */
	credits?: { input: number; output?: number; cacheRead?: number };
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
	/**
	 * Hard deprecation gate: when this Statsig flag is on, first-party clients
	 * hide the model in favor of its fallback. Evaluated after `featureFlag`.
	 */
	deprecationFlag?: string;
	thinkingStyle?: FactoryDroidAnthropicThinking;
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
	/** Anthropic-wire fast mode: sends top-level `speed:"fast"` + `fast-mode-2026-02-01` beta. */
	/**
	 * How the completions transport replays reasoning content on assistant
	 * turns, matching the provider's per-model families: "capture-only"
	 * (Kimi) replays only what was captured, "standard" (GLM-5.1/5.2,
	 * Inkling, Nemotron 3 Ultra) mirrors the captured content, and
	 * "placeholder" (DeepSeek V4) emits a synthetic placeholder on tool calls.
	 */
	reasoningReplay?: "capture-only" | "standard" | "placeholder";
	fastMode?: boolean;
	noImageSupport?: boolean;
}
/** Per-wire base URL; the stream layer appends the path suffix. */
export const FACTORY_DROID_WIRE_BASE_URLS: Readonly<Record<FactoryDroidWire, string>> = {
	"openai-completions": FACTORY_DROID_COMPLETIONS_BASE_URL,
	"openai-responses": FACTORY_DROID_RESPONSES_BASE_URL,
	"anthropic-messages": FACTORY_DROID_ANTHROPIC_BASE_URL,
	"google-generate": FACTORY_DROID_GOOGLE_BASE_URL,
};
export const FACTORY_DROID_MODELS: readonly FactoryDroidModelInput[] = [
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
		thinkingStyle: "budget-interleaved",
		noImageSupport: true,
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
		thinkingStyle: "budget-effort-beta",
		noImageSupport: true,
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
		noImageSupport: true,
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
		featureFlag: "claude_sonnet_5",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
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
		noImageSupport: true,
	},
	{
		id: "claude-opus-4-6-fast",
		name: "Opus 4.6 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 12 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "max"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_claude_opus_4_6_fast",
		thinkingStyle: "adaptive",
		noImageSupport: true,
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
		noImageSupport: true,
	},
	{
		id: "claude-opus-4-7-fast",
		name: "Opus 4.7 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 12 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		thinkingStyle: "adaptive-summarized",
		deprecationFlag: "deprecate_claude_opus_4_7_fast",
		noImageSupport: true,
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
		featureFlag: "claude_opus_4_8",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
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
		featureFlag: "claude_opus_4_8_fast",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		fastMode: true,
	},
	{
		id: "claude-opus-5",
		name: "Opus 5",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: ["bedrock_anthropic"],
		credits: { input: 2 },
		priceRef: { provider: "anthropic", modelId: "claude-opus-5" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_opus_5",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
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
		featureFlag: "claude_opus_5_fast",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		fastMode: true,
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
		featureFlag: "claude_fable_5",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
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
		thinkingStyle: "budget-interleaved",
		noImageSupport: true,
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
		noImageSupport: true,
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
		noImageSupport: true,
	},
	{
		id: "amber-07-09",
		name: "Amber 07/09 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 2 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		featureFlag: "amber_0709",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
	},
	{
		id: "agate-07-11",
		name: "Agate 07/11 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		credits: { input: 2 },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "agate_0711",
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
	},
	{
		id: "gpt-5.1-codex-max",
		name: "GPT-5.1-Codex-Max",
		wire: "openai-responses",
		contextWindow: 367232,
		maxTokens: 32768,
		apiProviders: ["openai"],
		credits: { input: 0.5 },
		priceRef: { provider: "openai", modelId: "gpt-5.1-codex-max" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		deprecationFlag: "deprecate_gpt_5_1_codex_max",
		responsesConfig: { parallelToolCalls: false, extendedCache: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.7 },
		priceRef: { provider: "openai", modelId: "gpt-5.2" },
		supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "low",
		responsesConfig: { verbosity: "low" },
		noImageSupport: true,
	},
	{
		id: "gpt-5.2-codex",
		name: "GPT-5.2-Codex",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.7 },
		priceRef: { provider: "openai", modelId: "gpt-5.2-codex" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		deprecationFlag: "deprecate_gpt_5_2_codex",
		responsesConfig: { parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.7 },
		priceRef: { provider: "openai", modelId: "gpt-5.3-codex" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.3-codex-fast",
		name: "GPT-5.3-Codex Fast Mode",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 1.4, output: 6 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai"],
		euApiProviders: ["openai"],
		credits: { input: 1, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.4" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.4-fast",
		name: "GPT-5.4 Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 2, output: 6 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.3, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.4-mini" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai"],
		euApiProviders: ["openai"],
		credits: { input: 2, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.5" },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.5-fast",
		name: "GPT-5.5 Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 5, output: 6 },
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
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
		noImageSupport: true,
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 2, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.6-sol" },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_sol",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.6-sol-fast",
		name: "GPT-5.6 Sol Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 4, output: 6 },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_sol_fast",
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.8, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.6-terra" },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_terra",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		credits: { input: 0.08, output: 6 },
		priceRef: { provider: "openai", modelId: "gpt-5.6-luna" },
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_luna",
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro",
		wire: "google-generate",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		apiProviders: ["google"],
		credits: { input: 0.8 },
		priceRef: { provider: "google", modelId: "gemini-3.1-pro-preview" },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		geminiMedium: true,
		noImageSupport: true,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash",
		wire: "google-generate",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		apiProviders: ["google"],
		credits: { input: 0.2 },
		priceRef: { provider: "google", modelId: "gemini-3-flash-preview" },
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
		noImageSupport: true,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		wire: "google-generate",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		apiProviders: ["google"],
		credits: { input: 0.6 },
		priceRef: { provider: "google", modelId: "gemini-3.5-flash" },
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "gemini_3_5_flash",
		noImageSupport: true,
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		wire: "google-generate",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		apiProviders: ["google"],
		credits: { input: 0.6, output: 5 },
		priceRef: { provider: "google", modelId: "gemini-3.6-flash" },
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "gemini_3_6_flash",
		noImageSupport: true,
	},
	{
		id: "garnet-07-15",
		name: "Garnet 07/15 (Preview)",
		wire: "google-generate",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		apiProviders: ["google"],
		credits: { input: 0.6 },
		supportedReasoningEfforts: ["medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "garnet_0715",
		noImageSupport: true,
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		wire: "openai-responses",
		contextWindow: 200000,
		maxTokens: 63356,
		apiProviders: ["xai"],
		credits: { input: 0.8, output: 3, cacheRead: 0.25 },
		priceRef: { provider: "xai", modelId: "grok-4.5" },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "grok_4_5",
	},
	{
		id: "glm-4.7",
		name: "GLM-4.7 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 198000,
		maxTokens: 25344,
		apiProviders: ["fireworks"],
		credits: { input: 0.25 },
		priceRef: { provider: "baseten", modelId: "zai-org/GLM-4.7" },
		supportedReasoningEfforts: ["none"],
		deprecationFlag: "deprecate_glm_4_7",
		noImageSupport: true,
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 256000,
		maxTokens: 32768,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.25, output: 5 },
		priceRef: { provider: "fireworks", modelId: "kimi-k2.5" },
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_kimi_k2_5",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "opt-in" } },
		reasoningReplay: "capture-only",
	},
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 262144,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.4, output: 4 },
		priceRef: { provider: "fireworks", modelId: "kimi-k2.6" },
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "opt-in" } },
		reasoningReplay: "capture-only",
	},
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code (Droid Core)",
		wire: "openai-completions",
		contextWindow: 262144,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.38, output: 4.21 },
		priceRef: { provider: "fireworks", modelId: "kimi-k2.7-code" },
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "kimi_k2_7_code",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "opt-in" } },
		reasoningReplay: "capture-only",
	},
	{
		id: "kimi-k3",
		name: "Kimi K3 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 262144,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 1.2, output: 5 },
		priceRef: { provider: "fireworks", modelId: "kimi-k3" },
		toolMessageIncludesName: true,
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "kimi_k3",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "opt-in" } },
		reasoningReplay: "capture-only",
	},
	{
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks"],
		credits: { input: 0.056, output: 2, cacheRead: 0.2 },
		priceRef: { provider: "fireworks", modelId: "deepseek-v4-flash-0731" },
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "deepseek_v4_flash_0731",
		completionsReasoning: { fireworks: { history: "interleaved" } },
		reasoningReplay: "placeholder",
		noImageSupport: true,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro (Droid Core)",
		wire: "openai-completions",
		contextWindow: 1040000,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.7, output: 2 },
		priceRef: { provider: "fireworks", modelId: "deepseek-v4-pro" },
		supportedReasoningEfforts: ["off", "low", "high", "max"],
		defaultReasoningEffort: "high",
		completionsReasoning: { fireworks: { history: "interleaved" }, baseten: { mode: "forced-on" } },
		reasoningReplay: "placeholder",
		noImageSupport: true,
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5 (Droid Core)",
		wire: "anthropic-messages",
		contextWindow: 204800,
		maxTokens: 64000,
		apiProviders: ["fireworks"],
		credits: { input: 0.12, output: 4 },
		priceRef: { provider: "fireworks", modelId: "minimax-m2.5" },
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		thinkingStyle: "budget-effort",
		noImageSupport: true,
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax M2.7 (Droid Core)",
		wire: "anthropic-messages",
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
	{
		id: "minimax-m3",
		name: "MiniMax M3 (Droid Core)",
		wire: "anthropic-messages",
		contextWindow: 448000,
		maxTokens: 64000,
		apiProviders: ["fireworks"],
		credits: { input: 0.12, output: 4 },
		priceRef: { provider: "fireworks", modelId: "minimax-m3" },
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		featureFlag: "minimax_m3",
		thinkingStyle: "budget-effort",
	},
	{
		id: "glm-5",
		name: "GLM-5 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 190000,
		maxTokens: 32000,
		apiProviders: ["fireworks"],
		credits: { input: 0.4, output: 3.2 },
		priceRef: { provider: "fireworks", modelId: "glm-5" },
		supportedReasoningEfforts: ["none"],
		deprecationFlag: "deprecate_glm_5",
		noImageSupport: true,
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 134464,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.55, output: 3.2 },
		priceRef: { provider: "fireworks", modelId: "glm-5.1" },
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_glm_5_1",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "opt-in" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.55, output: 3.2 },
		priceRef: { provider: "fireworks", modelId: "glm-5.2" },
		supportedReasoningEfforts: ["off", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "glm_5_2",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
	{
		id: "glm-5.2-fast",
		name: "GLM-5.2 Fast (Droid Core)",
		wire: "openai-completions",
		contextWindow: 393216,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.84, output: 3.2 },
		supportedReasoningEfforts: ["off", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "glm_5_2_fast",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
	{
		id: "inkling",
		name: "Inkling (Droid Core)",
		wire: "openai-completions",
		contextWindow: 1007232,
		maxTokens: 32768,
		apiProviders: ["fireworks", "baseten"],
		credits: { input: 0.4, output: 4.05, cacheRead: 0.17 },
		priceRef: { provider: "fireworks", modelId: "inkling" },
		supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "inkling",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "reasoning-effort" } },
		reasoningReplay: "standard",
	},
	{
		id: "nemotron-3-ultra",
		name: "Nemotron 3 Ultra (Droid Core)",
		wire: "openai-completions",
		contextWindow: 136464,
		maxTokens: 65536,
		apiProviders: ["baseten", "fireworks"],
		credits: { input: 0.24, output: 4 },
		priceRef: { provider: "baseten", modelId: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B" },
		supportedReasoningEfforts: ["off", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "nemotron_3_ultra",
		completionsReasoning: { fireworks: { history: "preserved" }, baseten: { mode: "opt-in" } },
		reasoningReplay: "standard",
		noImageSupport: true,
	},
];

/** Model id → registry entry, for the provider wrapper's per-model wire config. */
export const FACTORY_DROID_MODEL_META: Readonly<Record<string, FactoryDroidModelInput>> = Object.fromEntries(
	FACTORY_DROID_MODELS.map(model => [model.id, model]),
);
