/**
 * Anthropic-messages compat builder — the anthropic-side analogue of
 * `./openai`. Runs exactly once per model (from `buildModel`); detect-time
 * defaults come from provider ids, strict host checks, and model-id
 * classification, with explicit spec overrides assigned on top.
 */
import { hostMatchesUrl, modelMatchesHost } from "../hosts";
import {
	hasOpus47ApiRestrictions,
	isAnthropicFableOrMythosModel,
	isKimiK3ModelId,
	supportsMidConversationSystemMessages,
} from "../identity/family";
import type { ModelSpec, ResolvedAnthropicCompat } from "../types";
import { applyCompatOverrides } from "./apply";

const OFFICIAL_ANTHROPIC_URL = "https://api.anthropic.com";

/**
 * Official first-party Anthropic API. A missing baseUrl is official on purpose:
 * request dispatch falls back to `https://api.anthropic.com`. This is the one
 * auth-sensitive host check — OAuth credentials are attached based on it — so
 * it requires the exact origin or a path boundary (`/`) after it; a bare
 * prefix check would accept lookalikes like `https://api.anthropic.com.evil.com`.
 */
export function isOfficialAnthropicApiUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase();
	return lower === OFFICIAL_ANTHROPIC_URL || lower.startsWith(`${OFFICIAL_ANTHROPIC_URL}/`);
}

/**
 * Kimi models whose native endpoints (api.kimi.com, api.moonshot.ai) keep
 * thinking enabled server-side no matter what the request carries: they
 * reject disabled thinking (#3852) AND reject forced tool_choice
 * (`tool_choice 'specified' is incompatible with thinking enabled`), so compat
 * must keep thinking on and downgrade forced choices to `auto`. Covers the
 * K2.7 Code family — public id, its Highspeed variant, and the kimi-code
 * `kimi-for-coding[-highspeed]` aliases — plus K3 (`kimi-k3`, bare `k3` on
 * kimi-code). Broader than the `compat/openai.ts` mirror: the OpenAI surface
 * has its own per-dialect policies (K3 forced-choice guard, explicit disable
 * shapes), while this surface has no working way to force a tool.
 * Native-only host gating is the caller's responsibility.
 */
const KIMI_K27_CODE_MODEL_PATTERN = /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i;

function matchesKimiMandatoryThinkingModel(spec: ModelSpec<"anthropic-messages">): boolean {
	if (KIMI_K27_CODE_MODEL_PATTERN.test(spec.id)) return true;
	if (spec.id === "kimi-for-coding" || spec.id === "kimi-for-coding-highspeed") return true;
	return isKimiK3ModelId(spec.id) || spec.id === "k3";
}

const CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER = /gateway\.ai\.cloudflare\.com\/.+\/anthropic(?:\/|$)/i;
const VERTEX_ANTHROPIC_URL_MARKER = /aiplatform\.googleapis\.com\/.+\/publishers\/anthropic\//i;
const BEDROCK_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/i;
const AZURE_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)[a-z0-9-]+\.(?:inference|services)\.ai\.azure\.com/i;

/**
 * Cloudflare AI Gateway's `/anthropic` route forwards to signature-enforcing
 * Anthropic (same failure class as GitHub Copilot #2851 / ZenMux #4192).
 * Detection is by baseUrl marker rather than provider id: users routinely
 * declare `provider: "custom"` (or other free-form ids) in `models.yml` for
 * their own Cloudflare gateway account.
 */
function isCloudflareAnthropicGateway(baseUrl?: string): boolean {
	return baseUrl !== undefined && CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER.test(baseUrl);
}

/**
 * Google Vertex's `publishers/anthropic/models/…:streamRawPredict` route
 * proxies Claude through Google's identity layer and returns full thinking
 * signatures, so it is a SIGNING endpoint.
 */
function isVertexAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && VERTEX_ANTHROPIC_URL_MARKER.test(baseUrl);
}

/**
 * AWS Bedrock's Anthropic route (`bedrock-runtime.<region>.amazonaws.com`)
 * forwards Claude requests through Anthropic's signature protocol. Users can
 * front Bedrock with a custom `anthropic-messages` provider entry in
 * `models.yml`; the URL marker makes those signing by default without
 * requiring a provider-id list.
 */
function isBedrockAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && BEDROCK_ANTHROPIC_URL_MARKER.test(baseUrl);
}

/**
 * Azure AI Inference / Foundry Anthropic route
 * (`<resource>.inference.ai.azure.com`, `<resource>.services.ai.azure.com`).
 * Fronts Claude behind Azure identity and enforces Anthropic signatures on
 * replay.
 */
function isAzureAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && AZURE_ANTHROPIC_URL_MARKER.test(baseUrl);
}

/**
 * Known non-official URLs that enforce Anthropic thinking signatures on replay.
 *
 * Runtime routing calls this with the effective URL because a model's resolved
 * compat can be stale after Foundry or a provider base-URL override reroutes it.
 */
export function isAnthropicSigningProxyUrl(baseUrl?: string): boolean {
	return (
		hostMatchesUrl(baseUrl, "githubCopilot") ||
		hostMatchesUrl(baseUrl, "zenmux") ||
		isCloudflareAnthropicGateway(baseUrl) ||
		isVertexAnthropicRoute(baseUrl) ||
		isBedrockAnthropicRoute(baseUrl) ||
		isAzureAnthropicRoute(baseUrl)
	);
}

/** Build the resolved anthropic-messages compat record for a model spec. */
export function buildAnthropicCompat(spec: ModelSpec<"anthropic-messages">): ResolvedAnthropicCompat {
	const baseUrl = spec.baseUrl;
	const official = isOfficialAnthropicApiUrl(baseUrl);
	// Z.AI's Anthropic-compatible proxy lives at `api.z.ai/api/anthropic`.
	const isZai = modelMatchesHost(spec, "zai");
	// GitHub Copilot's `anthropic-messages` proxy (api.githubcopilot.com/v1/messages)
	// rejects the per-tool `eager_input_streaming` field with
	// `tools.0.custom.eager_input_streaming: Extra inputs are not permitted` and
	// doesn't whitelist the `fine-grained-tool-streaming-2025-05-14` beta either
	// (issue #2558), so eager tool-input streaming is unavailable on this host.
	const isCopilot = modelMatchesHost(spec, "githubCopilot");
	// ZenMux's `anthropic-messages` route (zenmux.ai/api/anthropic) forwards to
	// signature-enforcing Anthropic — same failure class as GitHub Copilot #2851
	// (issue #4192).
	const isZenmux = modelMatchesHost(spec, "zenmux");
	const requiresThinkingEnabled = modelMatchesHost(spec, "moonshotNative") && matchesKimiMandatoryThinkingModel(spec);
	const isAzure = isAzureAnthropicRoute(baseUrl);
	const signingEndpoint = official || isCopilot || isZenmux || isAnthropicSigningProxyUrl(baseUrl);
	const compat: ResolvedAnthropicCompat = {
		officialEndpoint: official,
		signingEndpoint,
		disableStrictTools: isAzure,
		disableAdaptiveThinking: false,
		allowAnthropicHeaderOverrides: false,
		supportsEagerToolInputStreaming: official,
		// Long cache retention is only sent to the official API by default;
		// proxies opt in explicitly via `compat.supportsLongCacheRetention: true`.
		supportsLongCacheRetention: official,
		// First-party Claude API only. Bedrock/Vertex/Foundry and other
		// Anthropic-compatible gateways reject mid-conversation system roles, so
		// detection requires the canonical api.anthropic.com host plus a
		// supported model id.
		supportsMidConversationSystem: official && supportsMidConversationSystemMessages(spec.id),
		supportsForcedToolChoice: !requiresThinkingEnabled && !isAnthropicFableOrMythosModel(spec.id),
		// Opus 4.7+ and Fable/Mythos reject temperature/top_p/top_k with a 400.
		supportsSamplingParams: !hasOpus47ApiRestrictions(spec.id),
		// Z.AI workaround (issue #814): its proxy deserializes tool_result blocks
		// into a class that reads `.id`.
		requiresToolResultId: isZai,
		requiresThinkingEnabled,
		// Official Anthropic and Anthropic-compatible signing proxies enforce
		// signature-based thinking-chain integrity, so unsigned thinking blocks
		// must stay text there. Every other `anthropic-messages` reasoning
		// endpoint replays unsigned thinking natively so the reasoning chain
		// survives continuation and doesn't destabilize the next tool-call
		// arguments (#2005, #2257, #2265, #3288, #3433, #3434). Opaque custom
		// signing proxies remain the reporter's responsibility to mark with
		// `compat.replayUnsignedThinking: false`; the transport surfaces a
		// pointed remediation the first time the signing 400 fires (#4297).
		//
		// Known signing Anthropic-messages hosts (Copilot, ZenMux, Cloudflare
		// AI Gateway `/anthropic`, Google Vertex `publishers/anthropic`, AWS
		// Bedrock `bedrock-runtime.<region>.amazonaws.com`, and Azure
		// AI Inference / Foundry `<res>.(inference|services).ai.azure.com`)
		// are excluded automatically because they can be recognised by provider
		// id or baseUrl marker.
		replayUnsignedThinking: !signingEndpoint && (Boolean(spec.reasoning) || modelMatchesHost(spec, "deepseekFamily")),
		escapeBuiltinToolNames: modelMatchesHost(spec, "umans"),
		streamIdleTimeoutMs: spec.compat?.streamIdleTimeoutMs,
	};
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
