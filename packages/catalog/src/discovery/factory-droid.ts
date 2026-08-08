import { isRecord } from "@oh-my-pi/pi-utils";
import { Effort } from "../effort";
import type { FetchImpl, ModelSpec, ThinkingConfig, ThinkingControlMode } from "../types";

/**
 * Factory Droid (Droid Core + Standard Credits subscription) — direct HTTP integration.
 *
 * The model registry below is bundled statically: Factory has no model-listing
 * endpoint, so first-party clients ship this table and narrow it live with
 * Statsig feature flags and the org model policy. Context windows, reasoning
 * ladders, credit multipliers, and per-model wire protocols are verified
 * against live traffic.
 */

/** Base URL per wire protocol namespace (paths appended by the stream layer). */
export const FACTORY_DROID_COMPLETIONS_BASE_URL = "https://api.factory.ai/api/llm/o/v1";
export const FACTORY_DROID_RESPONSES_BASE_URL = "https://api.factory.ai/api/llm/o/v1";
export const FACTORY_DROID_ANTHROPIC_BASE_URL = "https://api.factory.ai/api/llm/a";
export const FACTORY_DROID_GOOGLE_BASE_URL = "https://api.factory.ai/api/llm/g/v1";

/** Client version reported to Factory's API. */
export const FACTORY_DROID_CLIENT_VERSION = "0.189.0";

/**
 * Wire protocol the proxy expects for a model:
 * - `openai-completions`: `/api/llm/o/v1/chat/completions` (Droid Core + xAI)
 * - `openai-responses`: `/api/llm/o/v1/responses` (GPT series)
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
	parallelToolCalls: boolean;
	extendedCache: boolean;
	safetyId: boolean;
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
	/** Upstream override when the account region is EU. */
	euApiProviders?: readonly FactoryDroidUpstream[];
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
	/** "core" = Droid Core flat-rate pool; absent = Standard Credits pool. */
	billingPool?: "core";
	/** Standard Credits multipliers. */
	creditMultiplier?: number;
	outputCreditMultiplier?: number;
	thinkingStyle?: FactoryDroidAnthropicThinking;
	/** Gemini `thinkingConfig` supports MEDIUM in addition to LOW/HIGH. */
	geminiMedium?: boolean;
	responsesConfig?: FactoryDroidResponsesConfig;
	noImageSupport?: boolean;
	pdfSupport?: boolean;
	/** Droid Core models run on US-based inference. */
	usOnlyInference?: boolean;
	/** Fast-mode variants point at their base model. */
	baseVariant?: string;
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
 * The CLI's model registry, restricted to entries with `availableInCLI`
 * (drops deprecated/internal entries like `glm-4.6`, `shield-*`, the `auto`
 * router, and image-only models).
 */
export const FACTORY_DROID_MODELS: readonly FactoryDroidModelInput[] = [
	{
		id: "claude-sonnet-4-5-20250929",
		name: "Sonnet 4.5",
		wire: "anthropic-messages",
		contextWindow: 180000,
		maxTokens: 32000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high"],
		creditMultiplier: 1.2,
		thinkingStyle: "budget-interleaved",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-opus-4-5-20251101",
		name: "Opus 4.5",
		wire: "anthropic-messages",
		contextWindow: 180000,
		maxTokens: 64000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high"],
		creditMultiplier: 2,
		thinkingStyle: "budget-effort-beta",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Sonnet 4.6",
		wire: "anthropic-messages",
		contextWindow: 931000,
		maxTokens: 64000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "max"],
		defaultReasoningEffort: "high",
		creditMultiplier: 1.2,
		thinkingStyle: "adaptive",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-sonnet-5",
		name: "Sonnet 5",
		wire: "anthropic-messages",
		contextWindow: 872000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_sonnet_5",
		creditMultiplier: 1.2,
		outputCreditMultiplier: 5,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-opus-4-6",
		name: "Opus 4.6",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "max"],
		defaultReasoningEffort: "high",
		creditMultiplier: 2,
		thinkingStyle: "adaptive",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-opus-4-6-fast",
		name: "Opus 4.6 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "max"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_claude_opus_4_6_fast",
		creditMultiplier: 12,
		thinkingStyle: "adaptive",
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "claude-opus-4-6",
	},
	{
		id: "claude-opus-4-7",
		name: "Opus 4.7",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: ["bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		creditMultiplier: 2,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-opus-4-7-fast",
		name: "Opus 4.7 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_claude_opus_4_7_fast",
		creditMultiplier: 12,
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "claude-opus-4-7",
	},
	{
		id: "claude-opus-4-8",
		name: "Opus 4.8",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: ["bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_opus_4_8",
		creditMultiplier: 2,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-opus-4-8-fast",
		name: "Opus 4.8 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_opus_4_8_fast",
		creditMultiplier: 4,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "claude-opus-4-8",
	},
	{
		id: "claude-opus-5",
		name: "Opus 5",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: ["bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_opus_5",
		creditMultiplier: 2,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-opus-5-fast",
		name: "Opus 5 Fast Mode",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_opus_5_fast",
		creditMultiplier: 4,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "claude-opus-5",
	},
	{
		id: "claude-fable-5",
		name: "Fable 5",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		euApiProviders: [],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "claude_fable_5",
		creditMultiplier: 4,
		outputCreditMultiplier: 5,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Haiku 4.5",
		wire: "anthropic-messages",
		contextWindow: 180000,
		maxTokens: 32000,
		apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high"],
		creditMultiplier: 0.4,
		thinkingStyle: "budget-interleaved",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "atlas-07-21",
		name: "Atlas 07/21 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "atlas_0721",
		creditMultiplier: 2,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "aster-07-15",
		name: "Aster 07/15 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "aster_0715",
		creditMultiplier: 2,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "amber-07-09",
		name: "Amber 07/09 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		featureFlag: "amber_0709",
		creditMultiplier: 2,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "agate-07-11",
		name: "Agate 07/11 (Preview)",
		wire: "anthropic-messages",
		contextWindow: 867000,
		maxTokens: 128000,
		apiProviders: ["anthropic"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "agate_0711",
		creditMultiplier: 2,
		thinkingStyle: "adaptive-summarized",
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.1-codex-max",
		name: "GPT-5.1-Codex-Max",
		wire: "openai-responses",
		contextWindow: 367232,
		maxTokens: 32768,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		deprecationFlag: "deprecate_gpt_5_1_codex_max",
		creditMultiplier: 0.5,
		responsesConfig: { parallelToolCalls: false, extendedCache: true, safetyId: false },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "low",
		creditMultiplier: 0.7,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: false },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.2-codex",
		name: "GPT-5.2-Codex",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		deprecationFlag: "deprecate_gpt_5_2_codex",
		creditMultiplier: 0.7,
		responsesConfig: { parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		creditMultiplier: 0.7,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.3-codex-fast",
		name: "GPT-5.3-Codex Fast Mode",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		creditMultiplier: 1.4,
		outputCreditMultiplier: 6,
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "gpt-5.3-codex",
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai"],
		euApiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		creditMultiplier: 1,
		outputCreditMultiplier: 6,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.4-fast",
		name: "GPT-5.4 Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		creditMultiplier: 2,
		outputCreditMultiplier: 6,
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "gpt-5.4",
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		wire: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "high",
		creditMultiplier: 0.3,
		outputCreditMultiplier: 6,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai", "bedrock_openai"],
		euApiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		creditMultiplier: 2,
		outputCreditMultiplier: 6,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.5-fast",
		name: "GPT-5.5 Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		creditMultiplier: 5,
		outputCreditMultiplier: 6,
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "gpt-5.5",
	},
	{
		id: "gpt-5.5-pro",
		name: "GPT-5.5 Pro",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		creditMultiplier: 12,
		outputCreditMultiplier: 6,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_sol",
		creditMultiplier: 2,
		outputCreditMultiplier: 6,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.6-sol-fast",
		name: "GPT-5.6 Sol Fast Mode",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_sol_fast",
		creditMultiplier: 4,
		outputCreditMultiplier: 6,
		responsesConfig: {
			verbosity: "low",
			serviceTier: "priority",
			parallelToolCalls: true,
			extendedCache: true,
			safetyId: true,
		},
		noImageSupport: true,
		pdfSupport: true,
		baseVariant: "gpt-5.6-sol",
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_terra",
		creditMultiplier: 0.8,
		outputCreditMultiplier: 6,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		wire: "openai-responses",
		contextWindow: 922000,
		maxTokens: 128000,
		apiProviders: ["openai"],
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "medium",
		featureFlag: "gpt_5_6_luna",
		creditMultiplier: 0.08,
		outputCreditMultiplier: 6,
		responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro",
		wire: "google-generate",
		contextWindow: 200000,
		maxTokens: 32000,
		apiProviders: ["google"],
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		creditMultiplier: 0.8,
		geminiMedium: true,
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash",
		wire: "google-generate",
		contextWindow: 200000,
		maxTokens: 32000,
		apiProviders: ["google"],
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
		creditMultiplier: 0.2,
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		wire: "google-generate",
		contextWindow: 200000,
		maxTokens: 32000,
		apiProviders: ["google"],
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "gemini_3_5_flash",
		creditMultiplier: 0.6,
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		wire: "google-generate",
		contextWindow: 200000,
		maxTokens: 32000,
		apiProviders: ["google"],
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "gemini_3_6_flash",
		creditMultiplier: 0.6,
		outputCreditMultiplier: 5,
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "garnet-07-15",
		name: "Garnet 07/15 (Preview)",
		wire: "google-generate",
		contextWindow: 200000,
		maxTokens: 32000,
		apiProviders: ["google"],
		supportedReasoningEfforts: ["medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "garnet_0715",
		creditMultiplier: 0.6,
		noImageSupport: true,
		pdfSupport: true,
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		wire: "openai-responses",
		contextWindow: 200000,
		maxTokens: 63356,
		apiProviders: ["xai"],
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		featureFlag: "grok_4_5",
		creditMultiplier: 0.8,
		outputCreditMultiplier: 3,
	},
	{
		id: "glm-4.7",
		name: "GLM-4.7 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 198000,
		maxTokens: 25344,
		apiProviders: ["fireworks"],
		deprecationFlag: "deprecate_glm_4_7",
		billingPool: "core",
		creditMultiplier: 0.25,
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 256000,
		maxTokens: 32768,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_kimi_k2_5",
		billingPool: "core",
		creditMultiplier: 0.25,
		outputCreditMultiplier: 5,
		usOnlyInference: true,
	},
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 196608,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		billingPool: "core",
		creditMultiplier: 0.4,
		outputCreditMultiplier: 4,
		usOnlyInference: true,
	},
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code (Droid Core)",
		wire: "openai-completions",
		contextWindow: 196608,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		featureFlag: "kimi_k2_7_code",
		billingPool: "core",
		creditMultiplier: 0.38,
		outputCreditMultiplier: 4.21,
		usOnlyInference: true,
	},
	{
		id: "kimi-k3",
		name: "Kimi K3 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 196608,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["low", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "kimi_k3",
		billingPool: "core",
		creditMultiplier: 1.2,
		outputCreditMultiplier: 5,
		usOnlyInference: true,
	},
	{
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks"],
		supportedReasoningEfforts: ["low", "high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "deepseek_v4_flash_0731",
		billingPool: "core",
		creditMultiplier: 0.056,
		outputCreditMultiplier: 2,
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro (Droid Core)",
		wire: "openai-completions",
		contextWindow: 974464,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["low", "high", "max"],
		defaultReasoningEffort: "high",
		billingPool: "core",
		creditMultiplier: 0.7,
		outputCreditMultiplier: 2,
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5 (Droid Core)",
		wire: "anthropic-messages",
		contextWindow: 204800,
		maxTokens: 64000,
		apiProviders: ["fireworks"],
		supportedReasoningEfforts: ["low", "medium", "high"],
		defaultReasoningEffort: "high",
		billingPool: "core",
		creditMultiplier: 0.12,
		outputCreditMultiplier: 4,
		thinkingStyle: "budget-effort",
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax M2.7 (Droid Core)",
		wire: "anthropic-messages",
		contextWindow: 196600,
		maxTokens: 64000,
		apiProviders: ["fireworks"],
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		billingPool: "core",
		creditMultiplier: 0.12,
		outputCreditMultiplier: 4,
		thinkingStyle: "budget-effort",
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "minimax-m3",
		name: "MiniMax M3 (Droid Core)",
		wire: "anthropic-messages",
		contextWindow: 448000,
		maxTokens: 64000,
		apiProviders: ["fireworks"],
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		featureFlag: "minimax_m3",
		billingPool: "core",
		creditMultiplier: 0.12,
		outputCreditMultiplier: 4,
		thinkingStyle: "budget-effort",
		usOnlyInference: true,
	},
	{
		id: "glm-5",
		name: "GLM-5 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 190000,
		maxTokens: 32000,
		apiProviders: ["fireworks"],
		deprecationFlag: "deprecate_glm_5",
		billingPool: "core",
		creditMultiplier: 0.4,
		outputCreditMultiplier: 3.2,
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 134464,
		maxTokens: 65536,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		deprecationFlag: "deprecate_glm_5_1",
		billingPool: "core",
		creditMultiplier: 0.55,
		outputCreditMultiplier: 3.2,
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2 (Droid Core)",
		wire: "openai-completions",
		contextWindow: 908928,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		euApiProviders: ["baseten"],
		supportedReasoningEfforts: ["high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "glm_5_2",
		billingPool: "core",
		creditMultiplier: 0.55,
		outputCreditMultiplier: 3.2,
		noImageSupport: true,
		usOnlyInference: true,
	},
	{
		id: "glm-5.2-fast",
		name: "GLM-5.2 Fast (Droid Core)",
		wire: "openai-completions",
		contextWindow: 393216,
		maxTokens: 131072,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["high", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "glm_5_2_fast",
		billingPool: "core",
		creditMultiplier: 0.84,
		outputCreditMultiplier: 3.2,
		noImageSupport: true,
		usOnlyInference: true,
		baseVariant: "glm-5.2",
	},
	{
		id: "inkling",
		name: "Inkling (Droid Core)",
		wire: "openai-completions",
		contextWindow: 1007232,
		maxTokens: 32768,
		apiProviders: ["fireworks", "baseten"],
		supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
		defaultReasoningEffort: "high",
		featureFlag: "inkling",
		billingPool: "core",
		creditMultiplier: 0.4,
		outputCreditMultiplier: 4.05,
		usOnlyInference: true,
	},
	{
		id: "nemotron-3-ultra",
		name: "Nemotron 3 Ultra (Droid Core)",
		wire: "openai-completions",
		contextWindow: 136464,
		maxTokens: 65536,
		apiProviders: ["baseten", "fireworks"],
		supportedReasoningEfforts: ["high"],
		defaultReasoningEffort: "high",
		featureFlag: "nemotron_3_ultra",
		billingPool: "core",
		creditMultiplier: 0.24,
		outputCreditMultiplier: 4,
		noImageSupport: true,
		usOnlyInference: true,
	},
];

/** Model id → default upstream (first rotation entry) for the `x-api-provider` header. */
export const FACTORY_DROID_UPSTREAMS: Readonly<Record<string, FactoryDroidUpstream>> = Object.fromEntries(
	FACTORY_DROID_MODELS.map(model => [model.id, model.apiProviders[0]]),
);

/** Model id → registry entry, for the provider wrapper's per-model wire config. */
export const FACTORY_DROID_MODEL_META: Readonly<Record<string, FactoryDroidModelInput>> = Object.fromEntries(
	FACTORY_DROID_MODELS.map(model => [model.id, model]),
);

const FACTORY_FEATURE_FLAGS_URL = "https://api.factory.ai/api/feature-flags";
const FACTORY_MANAGED_SETTINGS_URL = "https://api.factory.ai/api/organization/managed-settings";

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
	const thinking = buildFactoryDroidThinking(input);
	return {
		id: input.id,
		name: input.name,
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl: FACTORY_DROID_COMPLETIONS_BASE_URL,
		reasoning: thinking != null,
		input: input.noImageSupport ? ["text"] : ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		thinking,
		contextWindow: input.contextWindow,
		maxTokens: input.maxTokens,
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
		...(supportsOff ? undefined : { requiresEffort: true }),
		...(input.defaultReasoningEffort && SUPPORTED_EFFORTS.has(input.defaultReasoningEffort)
			? { defaultLevel: input.defaultReasoningEffort as Effort }
			: undefined),
	};
}
