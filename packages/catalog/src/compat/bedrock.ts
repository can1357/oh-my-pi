import { supportsAdaptiveThinkingDisplay } from "../identity/family";
import type { ModelSpec, ResolvedBedrockCompat } from "../types";
import { applyCompatOverrides } from "./apply";

const NO_EXPLICIT_CHECKPOINTS: ResolvedBedrockCompat = {
	promptCacheMode: "none",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 0,
	promptCacheMaximumCheckpoints: 0,
};
const EXPLICIT_CHECKPOINTS_1024_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 1024,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_1024_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 1024,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_2048_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 2048,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_4096_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 4096,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_4096_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 4096,
	promptCacheMaximumCheckpoints: 4,
};

// AWS モデルカード: 512 トークン、最大 4 個のキャッシュチェックポイント、5 分と 1 時間の TTL。
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html
const EXPLICIT_CHECKPOINTS_512_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 512,
	promptCacheMaximumCheckpoints: 4,
};

/**
 * Explicit Nova cache points complement Bedrock's automatic prefix caching:
 * AWS recommends them for consistent cache hits and input-cost savings. Keep
 * these exact documented model and inference-profile IDs conservative rather
 * than treating arbitrary Nova-like application profiles as checkpoint-capable.
 */
function detectedBedrockCompat(modelId: string): ResolvedBedrockCompat {
	const id = modelId.toLowerCase();

	if (
		id === "amazon.nova-lite-v1:0" ||
		id === "us.amazon.nova-lite-v1:0" ||
		id === "amazon.nova-micro-v1:0" ||
		id === "us.amazon.nova-micro-v1:0" ||
		id === "amazon.nova-pro-v1:0" ||
		id === "us.amazon.nova-pro-v1:0" ||
		id === "amazon.nova-premier-v1:0" ||
		id === "us.amazon.nova-premier-v1:0" ||
		id === "amazon.nova-2-lite-v1:0" ||
		id === "us.amazon.nova-2-lite-v1:0" ||
		id === "eu.amazon.nova-2-lite-v1:0" ||
		id === "jp.amazon.nova-2-lite-v1:0" ||
		id === "global.amazon.nova-2-lite-v1:0"
	) {
		return EXPLICIT_CHECKPOINTS_1024_5M;
	}

	// https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
	// This list is deliberately sourced from AWS model cards, not cache pricing:
	// https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html
	if (
		id.includes("anthropic.claude-opus-4-5") ||
		id.includes("anthropic.claude-sonnet-4-5") ||
		id.includes("anthropic.claude-haiku-4-5") ||
		id.includes("anthropic.claude-opus-4-7") ||
		id.includes("anthropic.claude-opus-4-8") ||
		id.includes("anthropic.claude-sonnet-5")
	) {
		return EXPLICIT_CHECKPOINTS_4096_1H;
	}
	if (id.includes("anthropic.claude-opus-5")) {
		return EXPLICIT_CHECKPOINTS_512_1H;
	}
	if (id.includes("anthropic.claude-opus-4-6")) {
		return EXPLICIT_CHECKPOINTS_4096_5M;
	}
	if (id.includes("anthropic.claude-3-5-haiku")) {
		return EXPLICIT_CHECKPOINTS_2048_5M;
	}
	if (id.includes("anthropic.claude-fable-5")) {
		return EXPLICIT_CHECKPOINTS_1024_1H;
	}

	if (
		id.includes("anthropic.claude-opus-4-1") ||
		id.includes("anthropic.claude-opus-4-20250514") ||
		id.includes("anthropic.claude-sonnet-4-20250514") ||
		id.includes("anthropic.claude-sonnet-4-6") ||
		id.includes("anthropic.claude-3-7-sonnet") ||
		id.includes("anthropic.claude-3-5-sonnet-20241022-v2")
	) {
		return EXPLICIT_CHECKPOINTS_1024_5M;
	}

	return NO_EXPLICIT_CHECKPOINTS;
}

/**
 * Bedrock ConverseStream sends no ping/keepalive events, so a reasoning model
 * that goes quiet mid-thinking (summarized-display gaps, `omitted` thinking,
 * or the wedged long tool-call generation of issue #4900) reads as a dead
 * stream to the generic 300s idle watchdog and dies with "Provider stream
 * stalled while waiting for the next event" (issue #4758's Bedrock variant).
 * Widen the floor to 600s for reasoning models, mirroring the GLM coding-plan
 * floor; explicit `spec.compat.streamIdleTimeoutMs` overrides still win.
 */
const BEDROCK_REASONING_STREAM_IDLE_TIMEOUT_MS = 600_000;
/**
 * Adaptive-thinking Claude (Opus 4.7+, Sonnet/Opus 5, Fable/Mythos 5) reasons
 * for much longer stretches, and starting with Opus 4.7 / Fable 5 the
 * Anthropic-side display default is `omitted` (issue #1373), so quiet gaps run
 * longest on exactly this family — Fable 5 being the worst offender in the
 * field. Direct Anthropic keeps these streams alive with ping keepalives and
 * tolerates up to 3x the 300s idle budget of real-event silence (#4900);
 * pingless Bedrock needs the same 900s tolerance in the raw idle floor.
 */
const BEDROCK_ADAPTIVE_THINKING_STREAM_IDLE_TIMEOUT_MS = 900_000;

/** Resolve Bedrock Converse prompt-cache and stream-watchdog compat once per model. */
export function buildBedrockCompat(spec: ModelSpec<"bedrock-converse-stream">): ResolvedBedrockCompat {
	const compat = { ...detectedBedrockCompat(spec.id) };
	compat.streamIdleTimeoutMs = spec.reasoning
		? supportsAdaptiveThinkingDisplay(spec.id)
			? BEDROCK_ADAPTIVE_THINKING_STREAM_IDLE_TIMEOUT_MS
			: BEDROCK_REASONING_STREAM_IDLE_TIMEOUT_MS
		: undefined;
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
