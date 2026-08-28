import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import { scheduler } from "node:timers/promises";
import * as tls from "node:tls";
import { isAnthropicSigningProxyUrl, isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { hostMatchesUrl, isVertexRawPredictUrl } from "@oh-my-pi/pi-catalog/hosts";
import { mapEffortToAnthropicAdaptiveEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import {
	$env,
	getInstallId,
	isEnoent,
	logger,
	parseJsonWithRepair,
	parseStreamingJsonThrottled,
	readSseEvents,
} from "@oh-my-pi/pi-utils";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getEnvApiKey, OUTPUT_FALLBACK_BUFFER } from "../stream";
import type {
	AnthropicFallbackContent,
	AnthropicServerToolContent,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	FetchImpl,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	RawSseEvent,
	RedactedThinkingContent,
	ServiceTier,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types";
import { isRecord, normalizeSystemPrompts, normalizeToolCallId, resolveCacheRetention } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import {
	clearStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { withReplaySafeStreamRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { isFoundryEnabled } from "../utils/foundry";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "../utils/retry-after";
import { COMBINATOR_KEYS, NO_STRICT, toolWireSchema } from "../utils/schema";
import { spillToDescription } from "../utils/schema/spill";
import { createSdkStreamRequestOptions } from "../utils/sdk-stream-timeout";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { isForcedToolChoice } from "../utils/tool-choice";
import {
	AnthropicConnectionTimeoutError,
	type AnthropicFetchOptions,
	AnthropicMessagesClient,
	type AnthropicMessagesClientLike,
	calculateAnthropicRetryDelayMs,
} from "./anthropic-client";
import {
	type ToolInputSchema as AnthropicToolInputSchema,
	type Tool as AnthropicWireTool,
	type Usage as AnthropicWireUsage,
	type ContentBlockParam,
	type FallbackParam,
	isAnthropicServerToolHistoryBlock,
	type MessageCreateParams,
	type MessageCreateParamsStreaming,
	type MessageParam,
	type RawMessageStreamEvent,
	type TextBlockParam,
} from "./anthropic-wire";
import {
	CLAUDE_CODE_MAX_OUTPUT_TOKENS,
	claudeCodeSystemInstruction,
	claudeCodeVersion,
	claudeToolPrefix,
	coworkUserAgent,
} from "./claude-code-fingerprint";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { getOpenAIPromptCacheKey } from "./openai-shared";
import { transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
	isCloudflareAiGateway?: boolean;
	claudeCodeSessionId?: string;
	coworkBetas?: readonly string[];
	/** Allow explicit fingerprint headers to replace OAuth defaults on non-official endpoints. */
	allowAnthropicHeaderOverrides?: boolean;
};

export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

// Build deduplicated beta header string
export function buildBetaHeader(baseBetas: readonly string[], extraBetas: readonly string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

/**
 * Merge an extra Anthropic beta into a caller-provided `anthropic-beta` header,
 * preserving the caller's key casing and deduping the tokens. Returns a
 * single-entry header record for a per-request `headers` override — used to
 * attach a required beta to injected SDK clients that bypass the client-level
 * beta construction.
 */
function mergeAnthropicBetaHeader(callerHeaders: Record<string, string>, beta: string): Record<string, string> {
	for (const key in callerHeaders) {
		if (key.toLowerCase() === "anthropic-beta") {
			return { [key]: buildBetaHeader(normalizeExtraBetas(callerHeaders[key]), [beta]) };
		}
	}
	return { "anthropic-beta": beta };
}

const midConversationSystemBeta = "mid-conversation-system-2026-04-07";
const contextManagementBeta = "context-management-2025-06-27";
const structuredOutputsBeta = "structured-outputs-2025-12-15";
const thinkingTokenCountBeta = "thinking-token-count-2026-05-13";
const fallbackCreditBeta = "fallback-credit-2026-06-01";
const coworkUtilityBetaDefaults = [
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	structuredOutputsBeta,
] as const;
const coworkAgentBetaDefaults = [
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	midConversationSystemBeta,
	"advanced-tool-use-2025-11-20",
] as const;
const extendedCacheTtlBeta = "extended-cache-ttl-2025-04-11";
const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
const fastModeBeta = "fast-mode-2026-02-01";
const taskBudgetBeta = "task-budgets-2026-03-13";
const effortBeta = "effort-2025-11-24";
const serverSideFallbackBeta = "server-side-fallback-2026-06-01";

function buildCoworkBetas(
	agentRequest: boolean,
	thinkingRequest: boolean,
	disableStrictTools = false,
): readonly string[] {
	// `context-1m-2025-08-07` is intentionally never advertised. OAuth
	// subscription credentials have no long-context credit balance, so Anthropic
	// hard-429s ("Usage credits are required for long context requests") on any
	// beta-gated 1M model regardless of prompt size (#7238). Natively-1M models
	// (e.g. claude-sonnet-5) serve their full window without the beta anyway.
	if (!agentRequest && !disableStrictTools) return coworkUtilityBetaDefaults;
	const betas: string[] = [];
	for (const beta of agentRequest ? coworkAgentBetaDefaults : coworkUtilityBetaDefaults) {
		if (disableStrictTools && beta === structuredOutputsBeta) continue;
		betas.push(beta);
	}
	if (!agentRequest) return betas;
	if (thinkingRequest) betas.push(effortBeta);
	betas.push(fallbackCreditBeta);
	return betas;
}

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, headerName: string): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"anthropic-version": "2023-06-01",
	"anthropic-dangerous-direct-browser-access": "true",
	"x-app": "cli",
};

export function buildAnthropicHeaders(options: AnthropicHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;
	// `enforcedHeaderKeys` strips User-Agent / X-Api-Key / Authorization out of
	// modelHeaders so a case-insensitive spread can't produce duplicate keys; each
	// branch re-adds the caller's value explicitly. User-Agent and X-Api-Key are
	// always honored (with branch-specific defaults filling in when absent), while
	// Authorization is honored for every non-OAuth, non-Cloudflare-gateway branch —
	// OAuth requests MUST carry `Authorization: Bearer <oauth-token>` (the OAuth
	// credential itself) and Cloudflare AI Gateway authenticates via
	// `cf-aig-authorization`, so user-supplied auth there would just leak. Both of
	// those cases drop + log the caller value (#3391).
	const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
	const incomingAuthorization = getHeaderCaseInsensitive(options.modelHeaders, "Authorization");
	const incomingApiKey = getHeaderCaseInsensitive(options.modelHeaders, "X-Api-Key");
	// Cowork's beta profile is part of the OAuth fingerprint; API-key requests
	// default to extras only, matching the streaming path.
	const betaHeader = buildBetaHeader(
		options.coworkBetas ?? (oauthToken ? buildCoworkBetas(true, true) : []),
		extraBetas,
	);
	const acceptHeader = oauthToken ? "application/json" : stream ? "text/event-stream" : "application/json";
	const isCloudflare = options.isCloudflareAiGateway ?? false;
	const honorAuthorization = !oauthToken && !isCloudflare;
	const allowAnthropicHeaderOverrides =
		oauthToken &&
		options.allowAnthropicHeaderOverrides === true &&
		!isCloudflare &&
		!isOfficialAnthropicApiUrl(options.baseUrl);
	const honorApiKey = !isCloudflare;
	const modelHeaders: Record<string, string> = {};
	const anthropicHeaderOverrides: Record<string, string> = {};
	const filteredEnforcedKeys: string[] = [];
	const headerSource = options.modelHeaders;
	if (headerSource) {
		for (const key in headerSource) {
			const value = headerSource[key];
			const lowerKey = key.toLowerCase();
			if (enforcedHeaderKeys.has(lowerKey)) {
				if (allowAnthropicHeaderOverrides && overridableAnthropicHeaderKeys.has(lowerKey)) {
					anthropicHeaderOverrides[key] = value;
					continue;
				}
				// user-agent is always re-applied explicitly. authorization / x-api-key
				// are silently re-applied in honoring branches and dropped + logged
				// where the branch enforces its own credential.
				if (lowerKey === "user-agent") continue;
				if (lowerKey === "authorization" && honorAuthorization) continue;
				if (lowerKey === "x-api-key" && honorApiKey) continue;
				filteredEnforcedKeys.push(key);
				continue;
			}
			modelHeaders[key] = value;
		}
	}
	if (filteredEnforcedKeys.length > 0) {
		// Caller/env-supplied values (options.headers, ANTHROPIC_CUSTOM_HEADERS)
		// for enforced headers are replaced by our own values; say so instead of
		// dropping them silently. Keys only — values may carry credentials.
		logger.debug("anthropic: ignoring caller-supplied enforced headers", {
			headers: filteredEnforcedKeys,
		});
	}

	if (isCloudflare) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			"cf-aig-authorization": `Bearer ${options.apiKey}`,
		};
	}

	if (oauthToken) {
		const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent) ? incomingUserAgent : coworkUserAgent;
		const headers = {
			...modelHeaders,
			Accept: acceptHeader,
			"Content-Type": "application/json",
			"User-Agent": userAgent,
			...(options.claudeCodeSessionId ? { "X-Claude-Code-Session-Id": options.claudeCodeSessionId } : {}),
			...coworkHeaders,
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-version": "2023-06-01",
			Authorization: `Bearer ${options.apiKey}`,
			"x-app": "cli",
			"x-client-request-id": nodeCrypto.randomUUID(),
			Connection: "keep-alive",
			"Accept-Encoding": "gzip, deflate, br, zstd",
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
		return allowAnthropicHeaderOverrides ? mergeHeaders(headers, anthropicHeaderOverrides) : headers;
	} else if (!isOfficialAnthropicApiUrl(options.baseUrl)) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			Authorization: incomingAuthorization ?? `Bearer ${options.apiKey}`,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
	} else {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingAuthorization ? { Authorization: incomingAuthorization } : {}),
			"X-Api-Key": incomingApiKey ?? options.apiKey,
		};
	}
}

type AnthropicCacheControl = NonNullable<TextBlockParam["cache_control"]>;
type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function normalizeAnthropicImageMediaType(mimeType: string): AnthropicImageMediaType | undefined {
	const normalized = mimeType.trim().toLowerCase();
	if (normalized === "image/jpg") return "image/jpeg";
	if (
		normalized === "image/jpeg" ||
		normalized === "image/png" ||
		normalized === "image/gif" ||
		normalized === "image/webp"
	) {
		return normalized;
	}
	return undefined;
}

function cloneAnthropicCacheControl(cacheControl: AnthropicCacheControl): AnthropicCacheControl {
	return { ...cacheControl };
}

type AnthropicOutputConfig = NonNullable<MessageCreateParamsStreaming["output_config"]>;

const ANTHROPIC_STOP_SEQUENCES_MAX = 4;
let warnedStopSequencesTrim = false;

const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
	fastModeDisabled: boolean;
	/**
	 * Runtime-learned: this endpoint returned `400 Invalid signature in
	 * thinking block` for a replayed unsigned thinking block, so it must be
	 * treated as a signing proxy from now on. All subsequent requests demote
	 * unsigned thinking to text for this (baseUrl, modelId), same behavior as
	 * an explicit `compat.replayUnsignedThinking: false`. Cleared on session
	 * close.
	 */
	replayUnsignedThinkingDisabled: boolean;
};

function createAnthropicProviderSessionState(): AnthropicProviderSessionState {
	const state: AnthropicProviderSessionState = {
		strictToolsDisabled: false,
		fastModeDisabled: false,
		replayUnsignedThinkingDisabled: false,
		close: () => {
			state.strictToolsDisabled = false;
			state.fastModeDisabled = false;
			state.replayUnsignedThinkingDisabled = false;
		},
	};
	return state;
}

/**
 * Key the sticky strict-tools / fast-mode learning per endpoint+model. A
 * grammar-too-large 400 or a fast-mode rejection is specific to the model (its
 * tool grammar / entitlement) and the endpoint (direct Anthropic vs a gateway /
 * Foundry / Bedrock proxy), so it MUST NOT bleed onto unrelated anthropic-messages
 * requests in the same session. NUL separates the two components so neither can
 * forge the boundary.
 */
function anthropicProviderSessionStateKey(baseUrl: string, modelId: string): string {
	return `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:${baseUrl}\u0000${modelId}`;
}

function getAnthropicProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	baseUrl: string,
	modelId: string,
): AnthropicProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = anthropicProviderSessionStateKey(baseUrl, modelId);
	const existing = providerSessionState.get(key) as AnthropicProviderSessionState | undefined;
	if (existing) return existing;
	const created = createAnthropicProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

/**
 * Clears the in-session "server rejected fast mode" sticky flag. Call when the
 * caller is explicitly re-arming `serviceTier: "priority"` (e.g. user toggled
 * `/fast on` after a previous turn auto-disabled it) so the next request
 * actually carries `speed: "fast"` again. No-op when the map or state entry
 * hasn't been materialized yet.
 */
export function clearAnthropicFastModeFallback(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): void {
	if (!providerSessionState) return;
	// Fast mode is re-armed session-wide (user toggled `/fast on`), so clear the
	// sticky flag on every per-endpoint/model Anthropic entry — plus the legacy
	// unscoped key — rather than a single shared object.
	const prefix = `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:`;
	for (const [key, value] of providerSessionState) {
		if (key !== ANTHROPIC_PROVIDER_SESSION_STATE_KEY && !key.startsWith(prefix)) continue;
		(value as AnthropicProviderSessionState).fastModeDisabled = false;
	}
}
/**
 * Whether the direct Anthropic model's endpoint-scoped fast-mode fallback is
 * currently active. Reading the map directly is intentional: inspection must
 * not materialize a state entry for a model that has never streamed.
 */
export function isAnthropicFastModeFallbackDisabled(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	model: Model<Api>,
): boolean {
	if (!providerSessionState || model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	const baseUrl = resolveAnthropicBaseUrl(model as Model<"anthropic-messages">) ?? "https://api.anthropic.com";
	const key = anthropicProviderSessionStateKey(baseUrl, model.id);
	return (providerSessionState.get(key) as AnthropicProviderSessionState | undefined)?.fastModeDisabled ?? false;
}

function hasStrictAnthropicTools(params: MessageCreateParamsStreaming): boolean {
	return params.tools?.some(tool => tool.strict === true) ?? false;
}

function dropAnthropicFastMode(params: MessageCreateParamsStreaming): void {
	delete params.speed;
}

function dropAnthropicStrictTools(params: MessageCreateParamsStreaming): void {
	if (!params.tools) return;
	for (const tool of params.tools) {
		delete tool.strict;
	}
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention: CacheRetention | undefined,
): { retention: CacheRetention; cacheControl?: AnthropicCacheControl } {
	// Five-minute writes are the cheapest cache population strategy. Longer
	// retention remains an explicit PI_CACHE_RETENTION/request override; idle
	// sessions keep the short entry warm with bounded read-only refreshes.
	const retention = resolveCacheRetention(cacheRetention, "short");
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && model.compat.supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Cowork mode: mimic the desktop agent's direct inference transport. Constants
// live in the leaf module so registry/usage consumers avoid an init cycle.
export * from "./claude-code-fingerprint";

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

/** Static headers emitted by Cowork's Linux Claude runtime. */
export const coworkHeaders = {
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-Lang": "js",
	"X-Stainless-OS": "Linux",
	"X-Stainless-Package-Version": "0.94.0",
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": "v26.3.0",
	"X-Stainless-Timeout": "600",
};

const enforcedHeaderKeys = new Set(
	[
		...Object.keys(coworkHeaders),
		"Accept",
		"Accept-Encoding",
		"Connection",
		"Content-Type",
		"anthropic-version",
		"anthropic-dangerous-direct-browser-access",
		"anthropic-beta",
		"User-Agent",
		"x-app",
		"Authorization",
		"X-Api-Key",
		"X-Claude-Code-Session-Id",
		"x-client-request-id",
		"cf-aig-authorization",
	].map(key => key.toLowerCase()),
);

const overridableAnthropicHeaderKeys = new Set(
	[...Object.keys(coworkHeaders), "anthropic-beta", "User-Agent", "x-app"].map(key => key.toLowerCase()),
);

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function createClaudeBillingHeader(firstUserMessageText: string): string {
	// Fingerprint: SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]
	// Matches CC's computeFingerprint in utils/fingerprint.ts.
	// Uses chars from the first user message (not the system prompt).
	const k = [4, 7, 20].map(i => firstUserMessageText[i] ?? "0").join("");
	const versionSuffix = nodeCrypto
		.createHash("sha256")
		.update(`59cf53e54c78${k}${claudeCodeVersion}`)
		.digest("hex")
		.slice(0, 3);
	// cch=00000: placeholder replaced with the real attestation hash by wrapFetchForCch
	// before the request hits the wire (see below).
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER_STR};`;
}

// cch attestation: XXHash64(body_with_placeholder, seed) low-20-bits, 5 hex chars.
const CCH_SEED = 0x4d659218e32a3268n;
const CCH_PLACEHOLDER_STR = "cch=00000";
const cchEncoder = new TextEncoder();
const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR);
// Combined anchor for the billing-header placeholder inside system[0].
// "system":[{"type":"text","text":"x-anthropic-billing-header:
// Matches the exact JSON prefix of the first system block when
// createClaudeBillingHeader injects system[0].  "messages" serializes before
// "system" in Anthropic SDK payloads (~byte 29 vs ~byte 4705), so user content
// in the messages array can never match this sequence.  User system prompt text
// lives in system[2] and therefore also cannot match.
const BILLING_SYSTEM_MARKER = cchEncoder.encode(`"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`);
const CCH_BILLING_SEARCH_WINDOW = 150;

function patchCch(body: Uint8Array): "patched" | "no-billing-header" | "unanchored" {
	// Zero-copy Buffer view over the same memory; its `indexOf` is a native memmem,
	// ~7.5x faster than a hand-rolled byte loop here — the marker sits ~99% through
	// the body because `messages` serializes before `system`, so a JS scan would
	// walk almost the entire payload (benchmarked: 563µs -> 75µs on a 1MB body).
	const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

	// Find the combined system[0] + billing-header prefix marker.
	const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER);
	if (markerIdx === -1) return "no-billing-header"; // no CC billing header injected

	// Placeholder must sit within CCH_BILLING_SEARCH_WINDOW bytes after the marker.
	const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length;
	const idx = view.indexOf(CCH_PLACEHOLDER, searchFrom);
	if (idx === -1 || idx - searchFrom > CCH_BILLING_SEARCH_WINDOW) return "unanchored";

	// Hash the body with the placeholder in place (matches CC's in-place behaviour).
	const h = Bun.hash.xxHash64(body, CCH_SEED);
	const cch = (h & 0xfffffn).toString(16).padStart(5, "0");

	for (let i = 0; i < 5; i++) body[idx + 4 + i] = cch.charCodeAt(i);
	return "patched";
}

/**
 * Wraps a fetch implementation to patch the Claude Code billing-header `cch`
 * attestation into outgoing request bodies. Bodies without the placeholder
 * pass through untouched, so installing it on every OAuth flow is safe.
 */
export function wrapFetchForCch(base: FetchImpl): FetchImpl {
	return (input, init) => {
		if (init?.body && typeof init.body === "string" && init.body.includes(CCH_PLACEHOLDER_STR)) {
			const encoded = cchEncoder.encode(init.body);
			if (patchCch(encoded) === "unanchored") {
				// The OAuth billing placeholder is anchored to system[0] but we couldn't
				// patch it — e.g. an `onPayload` hook reordered the first system block's keys
				// so BILLING_SYSTEM_MARKER no longer matches. Send the body as-is (cch stays
				// `00000`, the prior behaviour) rather than failing the request, but surface the
				// fingerprint regression instead of letting it ship silently. A `cch=00000`
				// literal in user content alone ("no-billing-header") is not a regression.
				logger.warn("anthropic: cch billing placeholder present but not patched; sending unattested request");
			}
			return base(input, { ...init, body: encoded });
		}
		return base(input, init);
	};
}

const CLAUDE_CLOAKING_USER_ID_REGEX =
	/^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeCloakingUserId(userId: string): boolean {
	return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId);
}

/**
 * Real Claude Code sends `metadata.user_id` as a JSON-stringified object of the
 * shape `{ device_id, account_uuid, session_id, ...extra }` (see
 * services/api/claude.ts → getAPIMetadata). Accept that shape so callers that
 * supply a stable `session_id` aren't silently overwritten with fresh entropy
 * on every request, which would inflate the backend session count.
 */
function isClaudeJsonUserId(userId: string): boolean {
	if (userId.length === 0 || userId[0] !== "{") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const obj = parsed as Record<string, unknown>;
	return typeof obj.session_id === "string" && obj.session_id.length > 0;
}

function extractClaudeMetadataSessionId(userId: unknown): string | undefined {
	if (typeof userId !== "string") return undefined;
	if (isClaudeCloakingUserId(userId)) {
		return userId.slice(userId.lastIndexOf("_session_") + "_session_".length);
	}
	if (userId.length === 0 || userId[0] !== "{") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const sessionId = (parsed as Record<string, unknown>).session_id;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

export function generateClaudeCloakingUserId(): string {
	const userHash = nodeCrypto.randomBytes(32).toString("hex");
	const accountId = nodeCrypto.randomUUID().toLowerCase();
	const sessionId = nodeCrypto.randomUUID().toLowerCase();
	return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "omp-claude-device-id-v1:";
const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "omp-claude-device-id-v2";

export function deriveClaudeDeviceId(installId: string, accountId?: string): string {
	const hash = nodeCrypto.createHash("sha256");
	if (accountId && accountId.length > 0) {
		return hash
			.update(CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN)
			.update("\0")
			.update(installId)
			.update("\0")
			.update(accountId)
			.digest("hex");
	}
	return hash.update(CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN).update(installId).digest("hex");
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readAnthropicMetadataAccountId(metadata: Record<string, unknown> | undefined): string | undefined {
	return (
		readMetadataString(metadata, "account_uuid") ??
		readMetadataString(metadata, "accountId") ??
		readMetadataString(metadata, "account_id")
	);
}

function deriveClaudeDeviceIdFromInstallId(accountId?: string): string {
	return deriveClaudeDeviceId(getInstallId(), accountId);
}

function generateClaudeJsonUserId(sessionId?: string, accountId?: string): string {
	const userId: Record<string, string> = {
		device_id: deriveClaudeDeviceIdFromInstallId(accountId),
		session_id: sessionId ?? nodeCrypto.randomUUID().toLowerCase(),
	};
	if (accountId && accountId.length > 0) userId.account_uuid = accountId;
	return JSON.stringify(userId);
}

/**
 * Resolve the `metadata.user_id` field for an Anthropic Messages request.
 *
 * For API-key tokens, an explicit caller-supplied `userId` is forwarded
 * verbatim and `undefined` yields no metadata. For OAuth tokens the value
 * must match the Claude Code attribution shape (`isClaudeCloakingUserId` or
 * the `{session_id, account_uuid?, device_id?}` JSON envelope) — anything
 * else is dropped and a fresh Claude-Code-style JSON id is generated from
 * `sessionId`/`accountId` so attribution stays consistent across the main
 * streaming path and provider-specific request builders (e.g. web search).
 */
export function resolveAnthropicMetadataUserId(
	userId: unknown,
	isOAuthToken: boolean,
	sessionId?: string,
	accountId?: string,
): string | undefined {
	if (typeof userId === "string") {
		if (!isOAuthToken || isClaudeCloakingUserId(userId) || isClaudeJsonUserId(userId)) {
			return userId;
		}
	}

	if (!isOAuthToken) return undefined;
	return generateClaudeJsonUserId(sessionId, accountId);
}
const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set(["web_search", "code_execution", "text_editor", "computer"]);
const UMANS_WEBSEARCH_PROVIDER_HEADER = "X-Umans-Websearch-Provider";
const UMANS_WEBSEARCH_TOOL_NAME = "web_search";
export const applyClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;
	// Always prepend (no "already prefixed" short-circuit): the prefix is a wire
	// transport detail applied once to internal tool names, and `stripClaudeToolPrefix`
	// removes exactly one prefix on receive. Skipping names that already start with the
	// prefix would make a tool literally named `_foo` lose its leading underscore on the
	// return trip (`_foo` → wire `_foo` → strip → `foo`), so the agent loop can't find it.
	return `${claudeToolPrefix}${name}`;
};

export const stripClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (!name.toLowerCase().startsWith(claudeToolPrefix.toLowerCase())) return name;
	return name.slice(claudeToolPrefix.length);
};

function normalizeUmansWebSearchProvider(value: string | undefined): "native" | "exa" | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "native" || normalized === "exa" ? normalized : undefined;
}

function getUmansWebSearchProvider(headers: Record<string, string> | undefined): "native" | "exa" | undefined {
	const explicit = getHeaderCaseInsensitive(headers, UMANS_WEBSEARCH_PROVIDER_HEADER);
	if (explicit !== undefined) return normalizeUmansWebSearchProvider(explicit);
	return normalizeUmansWebSearchProvider($env.UMANS_WEBSEARCH_PROVIDER);
}

function isUmansAnthropicModel(model: Model<"anthropic-messages">): boolean {
	return model.provider === "umans" || model.baseUrl.toLowerCase().includes("api.code.umans.ai");
}

function getUmansWebSearchHeader(
	model: Model<"anthropic-messages">,
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!isUmansAnthropicModel(model)) return undefined;
	const provider = getUmansWebSearchProvider(headers);
	return provider ? { [UMANS_WEBSEARCH_PROVIDER_HEADER]: provider } : undefined;
}

function shouldUseUmansGatewayWebSearch(name: string, enabled: boolean): boolean {
	return enabled && name.toLowerCase() === UMANS_WEBSEARCH_TOOL_NAME;
}

function encodeAnthropicToolName(
	name: string,
	isOAuthToken: boolean,
	escapeBuiltinToolNames: boolean,
	useUmansGatewayWebSearch = false,
): string {
	if (shouldUseUmansGatewayWebSearch(name, useUmansGatewayWebSearch)) return name;
	if (escapeBuiltinToolNames) return `${claudeToolPrefix}${name}`;
	return isOAuthToken ? applyClaudeToolPrefix(name) : name;
}

function decodeAnthropicToolName(name: string, isOAuthToken: boolean, escapeBuiltinToolNames: boolean): string {
	if (isOAuthToken || escapeBuiltinToolNames) return stripClaudeToolPrefix(name);
	return name;
}

const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
const ANTHROPIC_MANY_IMAGE_MAX_DIMENSION = 2000;

function countAnthropicImageBlocks(messages: Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "image") count++;
		}
	}
	return count;
}

const ANTHROPIC_IMAGE_RESIZE_CONCURRENCY = 4;

/**
 * Memoized resize results keyed on ImageContent identity. Callers keep message
 * objects stable across turns, so without this every request (and every
 * in-provider retry of a fresh turn) re-decodes and re-encodes the same
 * oversized screenshots. A cached value identical to the key means "already
 * within bounds / unresizable — skip the decode".
 */
const anthropicManyImageResizeCache = new WeakMap<ImageContent, ImageContent>();

type ResizeLimiter = <R>(fn: () => Promise<R>) => Promise<R>;

/**
 * Bounded-concurrency gate for image decode/encode work. The many-image path
 * fans out over every block of every message; unbounded, 100+ oversized images
 * would decode concurrently (two encode pipelines each) and spike memory by
 * gigabytes. Slots are handed off directly to the next waiter on release.
 */
function createResizeLimiter(limit: number): ResizeLimiter {
	let active = 0;
	const queue: (() => void)[] = [];
	return async fn => {
		if (active >= limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			queue.push(resolve);
			await promise;
		} else {
			active++;
		}
		try {
			return await fn();
		} finally {
			const next = queue.shift();
			if (next) next();
			else active--;
		}
	};
}

async function resizeAnthropicManyImageBlock(block: ImageContent): Promise<ImageContent> {
	try {
		const inputBuffer = Buffer.from(block.data, "base64");
		const { width, height } = await new Bun.Image(inputBuffer).metadata();
		if (!width || !height) return block;
		if (width <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION && height <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION) return block;

		const scale = Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION / width, ANTHROPIC_MANY_IMAGE_MAX_DIMENSION / height);
		const targetWidth = Math.max(1, Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION, Math.round(width * scale)));
		const targetHeight = Math.max(1, Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION, Math.round(height * scale)));

		const [png, jpeg] = await Promise.all([
			new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).png().bytes(),
			new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).jpeg({ quality: 85 }).bytes(),
		]);
		const best =
			png.length <= jpeg.length ? { buffer: png, mimeType: "image/png" } : { buffer: jpeg, mimeType: "image/jpeg" };

		return {
			type: "image",
			data: Buffer.from(best.buffer).toString("base64"),
			mimeType: best.mimeType,
		};
	} catch (error) {
		logger.warn("anthropic: failed to resize oversized image for many-image request", {
			mimeType: block.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return block;
	}
}

async function resizeAnthropicManyImageContent(
	content: (TextContent | ImageContent)[],
	state: { resized: number },
	limit: ResizeLimiter,
): Promise<(TextContent | ImageContent)[]> {
	let changed = false;
	const next = await Promise.all(
		content.map(async block => {
			// Remotely referenced blocks never put base64 on the wire, so their size
			// cannot violate the many-image request budget — and resizing would
			// desync fallback bytes from the advertised remote image.
			if (
				block.type !== "image" ||
				block.url ||
				(block.providerFile?.provider === "anthropic" && block.providerFile.id)
			)
				return block;
			let resized = anthropicManyImageResizeCache.get(block);
			if (resized === undefined) {
				resized = await limit(() => resizeAnthropicManyImageBlock(block));
				anthropicManyImageResizeCache.set(block, resized);
			}
			if (resized !== block) {
				changed = true;
				state.resized++;
			}
			return resized;
		}),
	);
	return changed ? next : content;
}

async function resizeAnthropicManyImageMessage(
	message: Message,
	state: { resized: number },
	limit: ResizeLimiter,
): Promise<Message> {
	if (message.role === "user" || message.role === "developer") {
		if (!Array.isArray(message.content)) return message;
		const content = await resizeAnthropicManyImageContent(message.content, state, limit);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role === "toolResult") {
		const content = await resizeAnthropicManyImageContent(message.content, state, limit);
		return content === message.content ? message : { ...message, content };
	}
	return message;
}

async function prepareAnthropicManyImageContext(context: Context, supportsImages: boolean): Promise<Context> {
	if (!supportsImages) return context;
	const imageCount = countAnthropicImageBlocks(context.messages);
	if (imageCount <= ANTHROPIC_MANY_IMAGE_THRESHOLD) return context;

	let changed = false;
	const state = { resized: 0 };
	const limit = createResizeLimiter(ANTHROPIC_IMAGE_RESIZE_CONCURRENCY);
	const messages = await Promise.all(
		context.messages.map(async message => {
			const next = await resizeAnthropicManyImageMessage(message, state, limit);
			if (next !== message) changed = true;
			return next;
		}),
	);
	if (!changed) return context;
	logger.debug("anthropic: resized oversized images for many-image request", {
		imageCount,
		resized: state.resized,
		maxDimension: ANTHROPIC_MANY_IMAGE_MAX_DIMENSION,
	});
	return { ...context, messages };
}

type AnthropicImageSource =
	| { type: "base64"; media_type: AnthropicImageMediaType; data: string }
	| { type: "url"; url: string }
	| { type: "file"; file_id: string };

type AnthropicToolResultContent =
	| string
	| Array<{ type: "text"; text: string } | { type: "image"; source: AnthropicImageSource }>;

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(
	content: (TextContent | ImageContent)[],
	supportsImages = true,
): AnthropicToolResultContent {
	const blocks: Array<{ type: "text"; text: string } | { type: "image"; source: AnthropicImageSource }> = [];
	let sawText = false;
	let sawImage = false;

	for (const block of content) {
		if (block.type === "text") {
			const text = block.text.toWellFormed();
			if (text.trim().length === 0) continue;
			sawText = true;
			blocks.push({ type: "text", text });
			continue;
		}

		if (!supportsImages) {
			blocks.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
			continue;
		}

		let source: AnthropicImageSource;
		if (block.providerFile?.provider === "anthropic" && block.providerFile.id) {
			source = { type: "file", file_id: block.providerFile.id };
		} else if (block.url) {
			source = { type: "url", url: block.url };
		} else {
			const mediaType = normalizeAnthropicImageMediaType(block.mimeType);
			if (!mediaType) {
				blocks.push({ type: "text", text: `[unsupported image: ${block.mimeType}]` });
				continue;
			}
			source = { type: "base64", media_type: mediaType, data: block.data };
		}

		sawImage = true;
		blocks.push({ type: "image", source });
	}

	if (!supportsImages) {
		return blocks
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.toWellFormed();
	}

	if (sawImage && !sawText) {
		blocks.unshift({
			type: "text",
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicEffort = AnthropicOutputEffort | "adaptive";
export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive-capable models (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5):
	 * uses adaptive thinking (Claude decides when/how much to think). For older
	 * models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive-capable models.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Upstream wire model id override for collapsed effort-tier variants.
	 * Serialized as `requestModelId ?? model.requestModelId ?? model.id`.
	 */
	requestModelId?: string;
	/**
	 * Effort level for adaptive thinking.
	 * Controls how much Claude allocates, or uses "adaptive" for MiniMax's
	 * binary adaptive-thinking tag:
	 * - "max": Always thinks with no constraints
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * - "adaptive": Sends `thinking.type: "adaptive"` without `output_config.effort`
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	/**
	 * Optional reasoning level fallback for direct Anthropic provider usage.
	 * Converted to adaptive effort when effort is not explicitly provided.
	 */
	reasoning?: SimpleStreamOptions["reasoning"];
	/**
	 * Controls how Anthropic returns thinking content when the selected thinking
	 * transport supports a display option. Defaults to "summarized" where the
	 * API accepts it.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	betas?: string[] | string;
	/**
	 * Realization of `serviceTier: "priority"` on Anthropic models. When
	 * `"priority"`, sets `speed: "fast"` on the request and appends the
	 * `fast-mode-2026-02-01` beta header. Anthropic rejects unsupported models
	 * with `invalid_request_error`, which triggers an in-provider one-shot
	 * fallback (see `fastModeDisabled` provider state).
	 *
	 * Other `ServiceTier` values are currently ignored on this provider.
	 */
	serviceTier?: ServiceTier;
	/** Force OAuth bearer auth mode for proxy tokens that don't match Anthropic token prefixes. */
	isOAuth?: boolean;
	/**
	 * Pre-built Anthropic Messages client. When provided, skips internal client
	 * construction entirely. Accepts any structurally compatible client,
	 * including SDK clients such as `AnthropicVertex`.
	 */
	client?: AnthropicMessagesClientLike;
	/**
	 * Server-side fallback beta chain (`server-side-fallback-2026-06-01`).
	 * When set, `fallbacks` is forwarded on the request body and the beta
	 * header is auto-attached; the response parser then honors mid-stream
	 * `fallback` content blocks and `usage.iterations` for served-model
	 * promotion and per-attempt pricing. Opt-in ONLY — leaving this
	 * undefined preserves the pre-fallback behavior on every code path.
	 */
	fallbacks?: FallbackParam[];
}

export type AnthropicClientOptionsArgs = {
	model: Model<"anthropic-messages">;
	apiKey: string;
	extraBetas?: string[];
	stream?: boolean;
	interleavedThinking?: boolean;
	headers?: Record<string, string>;
	dynamicHeaders?: Record<string, string>;
	isOAuth?: boolean;
	hasTools?: boolean;
	thinkingEnabled?: boolean;
	thinkingDisplay?: AnthropicThinkingDisplay;
	disableStrictTools?: boolean;
	fetch?: FetchImpl;
	maxRetryDelayMs?: number;
	claudeCodeSessionId?: string;
};

export type AnthropicClientOptionsResult = {
	isOAuthToken: boolean;
	apiKey: string | null;
	authToken?: string | null;
	baseURL?: string;
	maxRetries: number;
	maxRetryDelayMs?: number;
	defaultHeaders: Record<string, string>;
	fetch?: FetchImpl;
	fetchOptions?: AnthropicFetchOptions;
};

const COWORK_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

const foundryTlsOptionsCache = new Map<string, FoundryTlsOptions | undefined>();

function foundryTlsCacheKeyComponent(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	// For path-valued vars, fold the file mtime into the key so on-disk cert
	// rotation (common for short-lived corporate mTLS certs) invalidates the
	// cached TLS options instead of pinning the first read forever.
	if (trimmed && !trimmed.includes("-----BEGIN") && looksLikeFilePath(trimmed)) {
		try {
			return `${trimmed}@${fs.statSync(trimmed).mtimeMs}`;
		} catch {
			return trimmed;
		}
	}
	return value;
}

function foundryTlsOptionsCacheKey(): string {
	return JSON.stringify([
		foundryTlsCacheKeyComponent($env.NODE_EXTRA_CA_CERTS),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_CERT),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_KEY),
	]);
}

function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	if (model.provider === "github-copilot") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	if (model.provider === "anthropic" && isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) {
			return foundryBaseUrl;
		}
	}
	if (model.provider === "anthropic") {
		const configured = normalizeAnthropicBaseUrl(model.baseUrl);
		// An explicitly configured non-official baseUrl (e.g. a models.yml provider
		// override) is more specific than the generic env fallback and wins.
		if (configured && !isOfficialAnthropicApiUrl(configured)) return configured;
		// Otherwise ANTHROPIC_BASE_URL routes chat through an enterprise gateway
		// (docs/environment-variables.md), ahead of the official default. The
		// Foundry redirect is already handled above.
		return normalizeAnthropicBaseUrl($env.ANTHROPIC_BASE_URL) ?? configured ?? "https://api.anthropic.com";
	}
	return normalizeAnthropicBaseUrl(model.baseUrl);
}

function resolveEagerToolInputStreamingSupport(
	model: Model<"anthropic-messages">,
	effectiveBaseUrl: string | undefined,
): boolean {
	if (!model.compat.supportsEagerToolInputStreaming) return false;
	// First-party Anthropic endpoints accept the per-tool flag.
	if (isOfficialAnthropicApiUrl(effectiveBaseUrl)) return true;
	// Non-official effective endpoint. `supportsEagerToolInputStreaming` may be
	// stale-true here because compat is materialized once at build time and is
	// never rebuilt for a baseUrl-only reroute — either a runtime provider
	// override (`pi.registerProvider("anthropic", { baseUrl })`) or Foundry
	// (`CLAUDE_CODE_USE_FOUNDRY`). Both leave the canonical model's resolved
	// compat in place. `officialEndpoint` records whether compat was built for
	// the canonical Anthropic URL, so only endpoints whose compat was authored
	// for a non-official host (an explicit `compat.supportsEagerToolInputStreaming`
	// opt-in on a custom `baseUrl`) still send the field.
	return !model.compat.officialEndpoint;
}

function parseAnthropicCustomHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
	const source = rawHeaders?.trim();
	if (!source) return undefined;

	const parsed: Record<string, string> = {};
	for (const token of source.split(/\r?\n|,/)) {
		const entry = token.trim();
		if (!entry) continue;
		const separatorIndex = entry.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) continue;
		parsed[key] = value;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * Returns env-supplied custom headers (`ANTHROPIC_CUSTOM_HEADERS`) when they
 * should be forwarded to the upstream endpoint.
 *
 * Foundry mode forwards them unconditionally. Outside Foundry, they're applied
 * only when the configured base URL is a non-Anthropic host — i.e. an
 * enterprise/corporate gateway that may require its own proprietary auth
 * header. Stock `api.anthropic.com` would reject unknown headers, so they're
 * omitted there.
 */
export function resolveAnthropicCustomHeadersForBaseUrl(
	baseUrl: string | undefined,
): Record<string, string> | undefined {
	if (!isFoundryEnabled() && isOfficialAnthropicApiUrl(baseUrl)) return undefined;
	return parseAnthropicCustomHeaders($env.ANTHROPIC_CUSTOM_HEADERS);
}

function resolveAnthropicCustomHeaders(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): Record<string, string> | undefined {
	if (model.provider !== "anthropic") return undefined;
	return resolveAnthropicCustomHeadersForBaseUrl(baseUrl);
}

function looksLikeFilePath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || /\.(pem|crt|cer|key)$/i.test(value);
}

function resolvePemValue(value: string | undefined, name: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const inline = trimmed.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		return inline;
	}

	if (looksLikeFilePath(trimmed)) {
		try {
			return fs.readFileSync(trimmed, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new AIError.ValidationError(`${name} path does not exist: ${trimmed}`);
			}
			throw error;
		}
	}

	return inline;
}

function resolveFoundryTlsOptions(model: Model<"anthropic-messages">): FoundryTlsOptions | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;

	const cacheKey = foundryTlsOptionsCacheKey();
	if (foundryTlsOptionsCache.has(cacheKey)) return foundryTlsOptionsCache.get(cacheKey);

	const ca = resolvePemValue($env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS");
	const cert = resolvePemValue($env.CLAUDE_CODE_CLIENT_CERT, "CLAUDE_CODE_CLIENT_CERT");
	const key = resolvePemValue($env.CLAUDE_CODE_CLIENT_KEY, "CLAUDE_CODE_CLIENT_KEY");

	if ((cert && !key) || (!cert && key)) {
		throw new AIError.ConfigurationError(
			"Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.",
		);
	}

	const options: FoundryTlsOptions = {};
	if (ca) options.ca = [...tls.rootCertificates, ca];
	if (cert) options.cert = cert;
	if (key) options.key = key;
	const resolved = Object.keys(options).length > 0 ? options : undefined;
	foundryTlsOptionsCache.set(cacheKey, resolved);
	return resolved;
}

function buildCoworkTlsFetchOptions(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): AnthropicFetchOptions | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!baseUrl) return undefined;

	let serverName: string;
	try {
		serverName = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}

	if (!serverName) return undefined;

	const foundryTlsOptions = resolveFoundryTlsOptions(model);

	return {
		tls: {
			rejectUnauthorized: true,
			serverName,
			...(COWORK_TLS_CIPHERS ? { ciphers: COWORK_TLS_CIPHERS } : {}),
			...(foundryTlsOptions ?? {}),
		},
	};
}
function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	// Case-insensitive merge: later sources win and keep their casing. A plain
	// Object.assign would let `authorization` and `Authorization` coexist, and
	// the Headers constructor then joins both values comma-separated on the wire.
	const merged: Record<string, string> = {};
	const keyByLower = new Map<string, string>();
	for (const headers of headerSources) {
		if (!headers) continue;
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			const existing = keyByLower.get(lower);
			if (existing !== undefined && existing !== key) delete merged[existing];
			keyByLower.set(lower, key);
			merged[key] = value;
		}
	}
	return merged;
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

/**
 * Iterate over Anthropic SSE events from a raw Response, preserving ping events
 * for liveness. Malformed event envelopes are logged and skipped (non-fatal)
 * rather than aborting the stream.
 */
type RawMessagePingEvent = { type: "ping" };
type AnthropicStreamEvent = RawMessageStreamEvent | RawMessagePingEvent;
const ANTHROPIC_PING_EVENT: RawMessagePingEvent = { type: "ping" };

/**
 * In-stream `error` SSE frames carry an Anthropic error envelope:
 * `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
 * Surface the structured type + message instead of the raw JSON blob; the
 * error type token (e.g. `overloaded_error`, `rate_limit_error`) is kept in
 * the message so `isProviderRetryableError`'s classification keys off the
 * structured type rather than incidental JSON substrings.
 */
function createAnthropicSseStreamError(data: string): Error {
	try {
		const parsed = JSON.parse(data) as { error?: { type?: unknown; message?: unknown } };
		const errorType = typeof parsed?.error?.type === "string" ? parsed.error.type : undefined;
		const message = typeof parsed?.error?.message === "string" ? parsed.error.message : undefined;
		if (message) {
			return new AIError.ProviderResponseError(
				errorType ? `Anthropic stream error (${errorType}): ${message}` : `Anthropic stream error: ${message}`,
				{ provider: "anthropic", kind: "output" },
			);
		}
	} catch {
		// Not a JSON envelope; fall through to the raw payload.
	}
	return new AIError.ProviderResponseError(data, { provider: "anthropic", kind: "output" });
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): AsyncGenerator<AnthropicStreamEvent> {
	if (!response.body) {
		throw new AIError.AnthropicStreamEnvelopeError("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of readSseEvents(response.body, signal)) {
		notifyRawSseEvent(onSseEvent, sse);
		if (sse.event === "error") {
			throw createAnthropicSseStreamError(sse.data);
		}

		if (sse.event === "ping") {
			// Surface keepalives so the idle watchdog treats them as liveness.
			yield ANTHROPIC_PING_EVENT;
			continue;
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = JSON.parse(sse.data) as RawMessageStreamEvent;
			if (event.type !== sse.event) {
				reportAnthropicEnvelopeAnomaly(`event type ${event.type} does not match SSE event ${sse.event}`);
			}
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			reportAnthropicEnvelopeAnomaly(
				`could not parse SSE event ${sse.event}: ${message}; skipping frame; data=${sse.data}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd && !signal?.aborted) {
		reportAnthropicEnvelopeAnomaly("stream ended before message_stop");
	}
}

type AnthropicRawResponseRequest = {
	asResponse(): Promise<Response>;
};

function hasAnthropicRawResponseRequest(request: unknown): request is AnthropicRawResponseRequest {
	return isRecord(request) && typeof request.asResponse === "function";
}

type AnthropicStreamWithResponseRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<RawMessageStreamEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

function hasAnthropicStreamWithResponseRequest(request: unknown): request is AnthropicStreamWithResponseRequest {
	return isRecord(request) && typeof request.withResponse === "function";
}

async function getAnthropicStreamResponse(
	request: unknown,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): Promise<{
	events: AsyncIterable<AnthropicStreamEvent>;
	response: Response;
	requestId: string | null;
	recordsRawSseEvents: boolean;
}> {
	if (hasAnthropicRawResponseRequest(request)) {
		const response = await request.asResponse();
		return {
			events: iterateAnthropicEvents(response, signal, onSseEvent),
			response,
			requestId: response.headers.get("request-id"),
			recordsRawSseEvents: true,
		};
	}
	if (hasAnthropicStreamWithResponseRequest(request)) {
		const { data, response, request_id } = await request.withResponse();
		return { events: data, response, requestId: request_id, recordsRawSseEvents: false };
	}
	throw new AIError.AnthropicStreamEnvelopeError("Anthropic SDK request did not expose a stream response");
}

async function* observeDecodedAnthropicSdkEvents(
	events: AsyncIterable<AnthropicStreamEvent>,
	observer: (event: RawSseEvent) => void,
): AsyncGenerator<AnthropicStreamEvent> {
	for await (const event of events) {
		const data = JSON.stringify(event);
		// Reconstructed from decoded SDK event; not literal wire bytes.
		notifyRawSseEvent(observer, { event: event.type, data, raw: [`event: ${event.type}`, `data: ${data}`] });
		yield event;
	}
}

const PROVIDER_MAX_RETRIES = 10;

/**
 * Flat delay between attempts when Copilot 400s a model its own `/models`
 * catalog advertises. Part of the fleet carries the model and part doesn't, so
 * the retry is a reroll rather than a wait for capacity to free up.
 */
const COPILOT_MODEL_FLAP_RETRY_DELAY_MS = 400;

/**
 * How long `ping` keepalives may keep extending the idle deadline without any
 * semantic stream progress, as a multiple of the idle timeout. Anthropic pings
 * across legitimate generation gaps, so pings count as liveness — but a wedged
 * upstream that pings forever while producing no events must eventually trip
 * the idle watchdog instead of hanging an active tool-call stream without a
 * recovery path (#4900).
 */
const PING_PROGRESS_MAX_IDLE_MULTIPLIER = 3;

/**
 * Log a malformed-stream-envelope anomaly without aborting the turn. The strict
 * parser would `throw new AnthropicStreamEnvelopeError(...)` here; we instead
 * surface a warning and let the caller skip the offending event (or finalize what
 * already streamed) so a non-conforming endpoint degrades to best-effort content
 * rather than failing the request.
 */
function reportAnthropicEnvelopeAnomaly(detail: string): void {
	logger.warn(`anthropic: ignoring malformed stream envelope: ${detail}`);
}

function shouldIgnoreAnthropicPreambleEvent(eventType: unknown): boolean {
	if (typeof eventType !== "string") return false;
	if (eventType === "ping") return true;
	return !ANTHROPIC_MESSAGE_EVENTS.has(eventType);
}

/**
 * Whether an Anthropic (or Copilot-over-Anthropic) stream error should be
 * retried. The classification lives in {@link AIError.isProviderRetryableError};
 * this wrapper injects the Copilot-specific model-availability transient check,
 * which the error module must not import directly.
 */
export function isProviderRetryableError(error: unknown, provider?: string): boolean {
	return AIError.isProviderRetryableError(error, {
		provider,
		isProviderTransient:
			provider === "github-copilot" ? (err): boolean => AIError.isCopilotTransientModelError(err) : undefined,
	});
}

const THINKING_ENVELOPE_OPEN = "<thinking>";
const THINKING_ENVELOPE_CLOSE = "</thinking>";

function unwrapAnthropicThinkingEnvelope(text: string): string | undefined {
	let current = text.trim();
	let stripped = false;
	while (current.startsWith(THINKING_ENVELOPE_OPEN) && current.endsWith(THINKING_ENVELOPE_CLOSE)) {
		current = current.slice(THINKING_ENVELOPE_OPEN.length, current.length - THINKING_ENVELOPE_CLOSE.length).trim();
		stripped = true;
	}
	return stripped ? current : undefined;
}

function createEmptyUsage(premiumRequests?: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...(premiumRequests === undefined ? {} : { premiumRequests }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export type AnthropicUsageLike = {
	cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
	server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
};

/**
 * Capture Anthropic's optional cache-creation TTL breakdown and server-tool-use
 * counters into the harness Usage shape. Omitted/null fields are no-ops; explicit
 * zero-valued objects clear prior extras from earlier stream usage snapshots.
 */
export function applyAnthropicUsageExtras(usage: Usage, source: AnthropicUsageLike): void {
	const cacheCreation = source.cache_creation;
	if (cacheCreation != null) {
		const fiveMinute = cacheCreation.ephemeral_5m_input_tokens ?? 0;
		const oneHour = cacheCreation.ephemeral_1h_input_tokens ?? 0;
		if (fiveMinute > 0 || oneHour > 0) {
			usage.cttl = {
				...(fiveMinute > 0 ? { ephemeral5m: fiveMinute } : {}),
				...(oneHour > 0 ? { ephemeral1h: oneHour } : {}),
			};
		} else {
			delete usage.cttl;
		}
	}
	const serverToolUse = source.server_tool_use;
	if (serverToolUse != null) {
		const webSearch = serverToolUse.web_search_requests ?? 0;
		const webFetch = serverToolUse.web_fetch_requests ?? 0;
		if (webSearch > 0 || webFetch > 0) {
			usage.server = {
				...(webSearch > 0 ? { webSearch } : {}),
				...(webFetch > 0 ? { webFetch } : {}),
			};
		} else {
			delete usage.server;
		}
	}
}

function parseAnthropicWireUsage(value: unknown): AnthropicWireUsage | undefined {
	if (!isRecord(value)) return undefined;
	const cacheCreation = isRecord(value.cache_creation)
		? {
				...(typeof value.cache_creation.ephemeral_5m_input_tokens === "number"
					? { ephemeral_5m_input_tokens: value.cache_creation.ephemeral_5m_input_tokens }
					: {}),
				...(typeof value.cache_creation.ephemeral_1h_input_tokens === "number"
					? { ephemeral_1h_input_tokens: value.cache_creation.ephemeral_1h_input_tokens }
					: {}),
			}
		: undefined;
	return {
		...(typeof value.input_tokens === "number" ? { input_tokens: value.input_tokens } : {}),
		...(typeof value.output_tokens === "number" ? { output_tokens: value.output_tokens } : {}),
		...(typeof value.cache_read_input_tokens === "number"
			? { cache_read_input_tokens: value.cache_read_input_tokens }
			: {}),
		...(typeof value.cache_creation_input_tokens === "number"
			? { cache_creation_input_tokens: value.cache_creation_input_tokens }
			: {}),
		...(cacheCreation === undefined ? {} : { cache_creation: cacheCreation }),
	};
}

function parseAnthropicFallbackWireBlock(value: unknown): AnthropicFallbackContent | undefined {
	if (!isRecord(value) || value.type !== "fallback") return undefined;
	const from = isRecord(value.from) && typeof value.from.model === "string" ? value.from.model : undefined;
	const to = isRecord(value.to) && typeof value.to.model === "string" ? value.to.model : undefined;
	if (!from?.trim() || !to?.trim()) return undefined;
	return { type: "fallback", from: { model: from }, to: { model: to } };
}

/**
 * The definitive "served by fallback" signal per Anthropic's fallback
 * billing cookbook (§4): a `fallback_message` iteration in `usage.iterations`.
 * Any other iteration type is per-attempt bookkeeping for the requested model
 * (including its dated snapshot alias) and MUST NOT retag the assistant turn.
 */
function fallbackServedModelFromUsage(source: AnthropicWireUsage): string | undefined {
	const iterations = source.iterations ?? [];
	for (let index = iterations.length - 1; index >= 0; index -= 1) {
		const iteration = iterations[index];
		if (iteration?.type === "fallback_message" && iteration.model?.trim()) return iteration.model;
	}
	return undefined;
}

/**
 * Price a fallback turn per the fallback billing cookbook §4:
 *   • A pre-served attempt with zero output/cache-creation is not billed
 *     (waived classifier block); its iteration is skipped.
 *   • Mid-stream refusals bill their attempting model's input+output at
 *     that model's normal rates.
 *   • The `fallback_message` attempt's input tokens are rebilled at the
 *     served model's cache-read rate (fallback credit — 10% of base input).
 *
 * Top-level `usage.input/output/cacheRead/cacheWrite` stay Anthropic's raw
 * served-attempt counts; `usage.cost` reflects the per-iteration attributed
 * total. Non-fallback turns skip this path entirely and use the requested
 * model at the normal `calculateCost` call.
 */
/**
 * Resolve a served/iteration model id to its bundled catalog entry when
 * possible so the per-iteration cost uses the served model's pricing
 * (e.g. Opus 4.8 rates for a Fable→Opus fallback). Falls back to
 * `requestModel` when the id is empty, matches the request, or the
 * catalog has no entry under it — the caller keeps the requested-model
 * pricing as the safe default and logs at the source.
 */
function resolveIterationModel(
	requestModel: Model<"anthropic-messages">,
	iterationModelId: string | null | undefined,
): Model<Api> {
	const id = iterationModelId?.trim();
	if (!id || id === requestModel.id) return requestModel;
	// Bundled catalog lookup: only Anthropic provider entries are safe to
	// reference (dated snapshots resolve to their alias entry when present).
	if (requestModel.provider === "anthropic") {
		const bundled = getBundledModel("anthropic", id);
		if (bundled?.api === "anthropic-messages") return bundled;
	}
	return requestModel;
}

function calculateFallbackTurnCost(
	requestModel: Model<"anthropic-messages">,
	usage: Usage,
	source: AnthropicWireUsage,
): boolean {
	const iterations = source.iterations ?? [];
	if (iterations.length === 0) return false;
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const hasFallbackMessage = iterations.some(iter => iter.type === "fallback_message");
	let applied = false;
	for (const iteration of iterations) {
		const inputTokens = iteration.input_tokens ?? 0;
		const outputTokens = iteration.output_tokens ?? 0;
		const cacheReadTokens = iteration.cache_read_input_tokens ?? 0;
		const cacheWriteTokens = iteration.cache_creation_input_tokens ?? 0;
		const isFallback = iteration.type === "fallback_message";
		if (hasFallbackMessage && !isFallback && outputTokens === 0 && cacheWriteTokens === 0) continue;
		const iterationUsage = createEmptyUsage();
		if (isFallback) {
			iterationUsage.input = 0;
			iterationUsage.cacheRead = cacheReadTokens + inputTokens;
		} else {
			iterationUsage.input = inputTokens;
			iterationUsage.cacheRead = cacheReadTokens;
		}
		iterationUsage.output = outputTokens;
		iterationUsage.cacheWrite = cacheWriteTokens;
		iterationUsage.totalTokens =
			iterationUsage.input + iterationUsage.output + iterationUsage.cacheRead + iterationUsage.cacheWrite;
		calculateCost(resolveIterationModel(requestModel, iteration.model), iterationUsage);
		cost.input += iterationUsage.cost.input;
		cost.output += iterationUsage.cost.output;
		cost.cacheRead += iterationUsage.cost.cacheRead;
		cost.cacheWrite += iterationUsage.cost.cacheWrite;
		cost.total += iterationUsage.cost.total;
		applied = true;
	}
	if (!applied) return false;
	usage.cost = cost;
	return true;
}

/**
 * Detects the Anthropic `400 Invalid `signature` in `thinking` block` failure
 * a signing proxy returns when a stripped/unsigned prior thinking block is
 * replayed as `signature: ""`. Exported for the compat tests.
 */
const INVALID_THINKING_SIGNATURE_PATTERN = /invalid\s+`?signature`?\s+in\s+`?thinking`?(?:\s+block)?/i;
export function isInvalidThinkingSignatureError(message: string): boolean {
	return INVALID_THINKING_SIGNATURE_PATTERN.test(message);
}

/**
 * Prepend a pointed remediation to Anthropic's `Invalid signature in thinking
 * block` 400 when the model looks like an unmarked custom signing proxy
 * (opaque baseUrl, `spec.reasoning: true`, no explicit
 * `compat.replayUnsignedThinking` override). The default is native replay for
 * the 3p reasoning majority (#2005); this hint turns the misconfigured-proxy
 * case into a one-line fix instead of a silent retry loop (#4297).
 */
export function maybeAddReplayUnsignedThinkingHint(model: Model<"anthropic-messages">, message: string): string {
	if (!isInvalidThinkingSignatureError(message)) return message;
	if (model.compat.officialEndpoint) return message;
	if (model.compatConfig?.replayUnsignedThinking !== undefined) return message;
	const hint = `Provider "${model.provider}" looks like an Anthropic-compatible signing proxy: it rejected a replayed unsigned thinking block. Set \`compat.replayUnsignedThinking: false\` under \`providers.${model.provider}\` in your models.yml and retry. See https://github.com/can1357/oh-my-pi/issues/4297.`;
	return `${hint}\n\n${message}`;
}

const streamAnthropicOnce = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		let activeAbortTracker = createAbortSourceTracker(options?.signal);

		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;

		try {
			// Built inside the try so a copilot credential/header failure surfaces as
			// an error event instead of an unhandled rejection that leaves the stream
			// (and any consumer awaiting `result()`) hanging forever.
			const copilotDynamicHeaders =
				model.provider === "github-copilot"
					? buildCopilotDynamicHeaders({
							messages: context.messages,
							hasImages: hasCopilotVisionInput(context.messages),
							premiumMultiplier: model.premiumMultiplier,
							headers: { ...(model.headers ?? {}), ...(options?.headers ?? {}) },
							initiatorOverride: options?.initiatorOverride,
						})
					: undefined;
			if (copilotDynamicHeaders?.premiumRequests !== undefined) {
				output.usage.premiumRequests = copilotDynamicHeaders.premiumRequests;
			}
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? "https://api.anthropic.com";
			const supportsEagerToolInputStreaming = resolveEagerToolInputStreamingSupport(model, baseUrl);
			const providerSessionState = getAnthropicProviderSessionState(
				options?.providerSessionState,
				baseUrl,
				model.id,
			);
			let disableStrictTools =
				(providerSessionState?.strictToolsDisabled ?? false) || (model.compat?.disableStrictTools ?? false);
			let dropFastMode = providerSessionState?.fastModeDisabled ?? false;
			let forceDemoteUnsignedThinking = providerSessionState?.replayUnsignedThinkingDisabled ?? false;
			const mergedCallerHeaders = mergeHeaders(model.headers, options?.headers);
			const umansGatewayWebSearchHeader = getUmansWebSearchHeader(model, mergedCallerHeaders);
			// Keep fallback payloads aligned with the top-level Vertex effort gate:
			// no nested effort field means the fallback scan cannot re-add its beta.
			let fallbacks = options?.fallbacks;
			if (
				model.provider === "google-vertex" &&
				fallbacks?.some(entry => entry.output_config?.effort !== undefined)
			) {
				fallbacks = fallbacks.map(entry => {
					const outputConfig = entry.output_config;
					if (outputConfig?.effort === undefined) return entry;
					return {
						...entry,
						output_config:
							outputConfig.task_budget === undefined ? undefined : { task_budget: outputConfig.task_budget },
					};
				});
			}

			const zeroOutputCacheRefresh = options?.anthropicCacheRefreshRequest === true;
			let client: AnthropicMessagesClientLike;
			let isOAuthToken: boolean;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const extraBetas = normalizeExtraBetas(options?.betas);
				const wantsAnthropicPriority = model.provider === "anthropic" && options?.serviceTier === "priority";
				// Skip the fast-mode beta when this session already learned the
				// endpoint+model rejects fast mode; `speed` is dropped from the params
				// too (dropFastMode), so the request stays a faithful non-fast request.
				if (wantsAnthropicPriority && !dropFastMode && !extraBetas.includes(fastModeBeta)) {
					extraBetas.push(fastModeBeta);
				}
				if (options?.taskBudget && !extraBetas.includes(taskBudgetBeta)) {
					extraBetas.push(taskBudgetBeta);
				}
				// `output_config.effort` ships on thinking-on requests, explicit
				// thinking-off adaptive pins, and forced-tool adaptive pins. The beta
				// must accompany the field even when direct streamAnthropic callers omit
				// thinkingEnabled (#6589). MiniMax uses `thinking.type:"adaptive"` itself
				// as the control surface, so the sentinel "adaptive" value intentionally
				// sends no output_config. Skip Vertex rawPredict: that adapter needs betas
				// in the body (`anthropic_beta`), not as an `anthropic-beta` HTTP header,
				// so the effort field is dropped from the body there too (see buildParams)
				// and advertising the beta would only earn a 400 (#5614).
				const sendsAdaptiveEffortPin =
					isAdaptiveOnlyThinking(model) &&
					(options?.thinkingEnabled === false ||
						(model.compat.supportsForcedToolChoice && isForcedToolChoice(options?.toolChoice)));
				if (
					model.reasoning &&
					model.provider !== "google-vertex" &&
					((options?.thinkingEnabled && options.effort !== "adaptive") || sendsAdaptiveEffortPin) &&
					!extraBetas.includes(effortBeta)
				) {
					extraBetas.push(effortBeta);
				}
				if (model.compat.supportsMidConversationSystem && !extraBetas.includes(midConversationSystemBeta)) {
					// convertAnthropicMessages may upgrade developer turns to the
					// mid-conversation `system` role on these models; API-key requests
					// need the beta alongside the role (OAuth agent requests already
					// carry it in the Claude Code list).
					extraBetas.push(midConversationSystemBeta);
				}
				// `context_management.clear_thinking_20251015` requires this beta. OAuth
				// requests carry it in `claudeCodeAgentBetaDefaults`; API-key requests
				// need it added explicitly so the field is honored instead of rejected
				// (#3288). Skip transports where this package cannot deliver or the
				// provider cannot accept the beta: Copilot strips Anthropic betas;
				// Vertex rawPredict needs betas in the body (`anthropic_beta`), not as
				// an `anthropic-beta` HTTP header; and OpenCode Zen rejects the related
				// `context_management` field (#6510).
				if (
					model.reasoning &&
					options?.thinkingEnabled &&
					model.provider !== "github-copilot" &&
					model.provider !== "google-vertex" &&
					model.provider !== "opencode-zen" &&
					!extraBetas.includes(contextManagementBeta)
				) {
					extraBetas.push(contextManagementBeta);
				}
				// `ttl: "1h"` requires the extended-cache-ttl beta on API-key
				// requests. OAuth requests never add it here: agent requests
				// already carry it in the Claude Code beta list, and utility
				// requests must not deviate from CC's header fingerprint.
				if (
					!(options?.isOAuth ?? isAnthropicOAuthToken(apiKey)) &&
					getCacheControl(model, options?.cacheRetention).cacheControl?.ttl === "1h" &&
					!extraBetas.includes(extendedCacheTtlBeta)
				) {
					extraBetas.push(extendedCacheTtlBeta);
				}
				// Server-side fallback beta chain: opt-in via `options.fallbacks`.
				// Nested overrides (`speed`, `output_config.effort`,
				// `output_config.task_budget`) reuse the same top-level betas
				// Anthropic requires for the primary request, so scan the chain
				// and add every companion beta the fallback entries touch.
				if (fallbacks?.length) {
					if (!extraBetas.includes(serverSideFallbackBeta)) {
						extraBetas.push(serverSideFallbackBeta);
					}
					for (const entry of fallbacks) {
						if (entry.speed === "fast" && !extraBetas.includes(fastModeBeta)) {
							extraBetas.push(fastModeBeta);
						}
						if (entry.output_config?.effort && !extraBetas.includes(effortBeta)) {
							extraBetas.push(effortBeta);
						}
						if (entry.output_config?.task_budget && !extraBetas.includes(taskBudgetBeta)) {
							extraBetas.push(taskBudgetBeta);
						}
					}
				}

				const created = createClient(model, {
					model,
					apiKey,
					extraBetas,
					stream: !zeroOutputCacheRefresh,
					interleavedThinking: options?.interleavedThinking ?? true,
					headers: options?.headers,
					dynamicHeaders: copilotDynamicHeaders?.headers,
					isOAuth: options?.isOAuth,
					hasTools: !!context.tools?.length,
					thinkingEnabled: options?.thinkingEnabled,
					thinkingDisplay: options?.thinkingDisplay,
					fetch: options?.fetch,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					claudeCodeSessionId: options?.sessionId ?? extractClaudeMetadataSessionId(options?.metadata?.user_id),
					disableStrictTools,
				});
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}
			const preparedContext = await prepareAnthropicManyImageContext(context, model.input.includes("image"));
			const prepareParams = async (): Promise<MessageCreateParamsStreaming> => {
				let nextParams = buildParams(model, preparedContext, isOAuthToken, options, {
					disableStrictTools,
					useUmansGatewayWebSearch: umansGatewayWebSearchHeader !== undefined,
					forceDemoteUnsignedThinking,
					supportsEagerToolInputStreaming,
					fallbacks,
				});
				if (disableStrictTools) {
					dropAnthropicStrictTools(nextParams);
				}
				if (dropFastMode) {
					dropAnthropicFastMode(nextParams);
				}
				const replacementPayload = await options?.onPayload?.(nextParams, model);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				nextParams = toWellFormedDeep(nextParams) as typeof nextParams;
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages${isOAuthToken ? "?beta=true" : ""}`,
					body: nextParams,
				};
				return nextParams;
			};
			let params = await prepareParams();
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs);
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;

			if (zeroOutputCacheRefresh) {
				const refreshParams: MessageCreateParams = { ...params, max_tokens: 0, stream: false };
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages${isOAuthToken ? "?beta=true" : ""}`,
					body: refreshParams,
				};
				const { requestSignal } = activeAbortTracker;
				const requestOptions = {
					...createSdkStreamRequestOptions(requestSignal, requestTimeoutMs),
					maxRetries: 0,
				};
				const request: unknown =
					isOAuthToken && client.beta
						? client.beta.messages.create(refreshParams, requestOptions)
						: client.messages.create(refreshParams, requestOptions);
				if (!hasAnthropicRawResponseRequest(request)) {
					throw new AIError.AnthropicStreamEnvelopeError(
						"Anthropic cache refresh request did not expose a raw response",
					);
				}
				const response = await request.asResponse();
				await notifyProviderResponse(options, response, model, response.headers.get("request-id"));
				const body: unknown = await response.json();
				if (!isRecord(body)) {
					throw new AIError.AnthropicStreamEnvelopeError("Anthropic cache refresh returned a malformed response");
				}
				const wireUsage = parseAnthropicWireUsage(body.usage);
				if (!wireUsage) {
					throw new AIError.AnthropicStreamEnvelopeError("Anthropic cache refresh response omitted usage");
				}
				if (typeof body.id === "string") output.responseId = body.id;
				output.usage.input = wireUsage.input_tokens ?? 0;
				output.usage.output = wireUsage.output_tokens ?? 0;
				output.usage.cacheRead = wireUsage.cache_read_input_tokens ?? 0;
				output.usage.cacheWrite = wireUsage.cache_creation_input_tokens ?? 0;
				applyAnthropicUsageExtras(output.usage, wireUsage);
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage);
				output.duration = performance.now() - startTime;
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			// Opt-in flag: the response parser only honors `fallback` content
			// blocks and `usage.iterations` when the current request opted into
			// server-side-fallback beta chain. Leaving `fallbacks` unset preserves
			// the pre-fallback stream shape on every event.
			const serverSideFallback = !!fallbacks?.length;
			type Block = (
				| ThinkingContent
				| RedactedThinkingContent
				| TextContent
				| AnthropicFallbackContent
				| (AnthropicServerToolContent & { [kStreamingPartialJson]?: string })
				| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number })
			) & { [kStreamingBlockIndex]: number };
			const blocks = output.content as Block[];
			const finalizeStreamBlock = (block: Block, contentIndex: number): void => {
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					const unwrappedThinking = unwrapAnthropicThinkingEnvelope(block.thinking);
					if (unwrappedThinking !== undefined) {
						block.thinking = unwrappedThinking;
						block.thinkingSignature = undefined;
					}
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else if (block.type === "anthropicServerTool" && block.block.type === "server_tool_use") {
					const partialJson = block[kStreamingPartialJson];
					if (partialJson) {
						try {
							const input = parseJsonWithRepair(partialJson);
							if (isRecord(input)) {
								block.block.input = input;
							} else {
								reportAnthropicEnvelopeAnomaly("server_tool_use input is not a JSON object");
							}
						} catch (parseError) {
							reportAnthropicEnvelopeAnomaly(
								`server_tool_use ${block.block.id} input is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
							);
						}
					}
					clearStreamingPartialJson(block);
				} else if (block.type === "toolCall") {
					const finalJson =
						block[kStreamingPartialJson].length > 0
							? block[kStreamingPartialJson]
							: JSON.stringify(block.arguments ?? {});
					try {
						block.arguments = parseJsonWithRepair(finalJson) as ToolCall["arguments"];
					} catch (parseError) {
						// Non-fatal: keep the best-effort arguments recovered by the throttled streaming
						// parser instead of failing the turn on malformed/truncated tool-argument JSON.
						reportAnthropicEnvelopeAnomaly(
							`tool_use ${block.id} arguments are not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
						);
						const recoveredKeys = Object.keys(block.arguments ?? {});
						if (recoveredKeys.length === 0) {
							const maxLen = 512;
							const truncatedJson =
								finalJson.length <= maxLen
									? finalJson
									: `${finalJson.slice(0, maxLen)}… [truncated ${finalJson.length - maxLen} chars]`;
							block.arguments = {
								__parseError: parseError instanceof Error ? parseError.message : String(parseError),
								__rawJson: truncatedJson,
							};
						}
					}
					clearStreamingPartialJson(block);
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
			};
			stream.push({ type: "start", partial: output });
			// Retry loop for transient errors from the stream.
			// Provider-level transport/rate-limit failures: only before any streamed content starts.
			// Malformed envelopes/JSON: only before replay-unsafe text/tool events are visible on this stream.
			let providerRetryAttempt = 0;
			const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream timed out while waiting for the first event",
			);
			const idleTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream stalled while waiting for the next event",
			);
			while (true) {
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				const { requestSignal } = activeAbortTracker;
				// The provider loop owns retries: pin the client's internal retry loop
				// to zero even when no watchdog timeout is configured (the helper only
				// pins it alongside a timeout; a client retry budget of 5 would otherwise
				// multiply with PROVIDER_MAX_RETRIES into up to 66 wire attempts).
				// Injected SDK clients (`options.client`) bypass the client-level
				// `anthropic-beta` construction below, so any `output_config.effort` the
				// body carries — the adaptive-only thinking-off / forced-tool pins and
				// enabled-effort turns alike — would reach Anthropic without the required
				// `effort-2025-11-24` beta and 400. `create()` accepts per-request headers
				// (already used for the gateway web-search header), so merge the beta with
				// any caller-provided `anthropic-beta` (deduped) and attach it there. Vertex
				// never carries the effort field (dropped in buildParams), so it is unaffected.
				const injectedClientEffortHeaders =
					options?.client !== undefined &&
					(params.output_config as AnthropicOutputConfig | undefined)?.effort !== undefined
						? mergeAnthropicBetaHeader(mergedCallerHeaders, effortBeta)
						: undefined;
				const perRequestHeaders =
					umansGatewayWebSearchHeader || injectedClientEffortHeaders
						? { ...umansGatewayWebSearchHeader, ...injectedClientEffortHeaders }
						: undefined;
				const requestOptions = {
					...createSdkStreamRequestOptions(requestSignal, requestTimeoutMs),
					maxRetries: 0,
					...(perRequestHeaders ? { headers: perRequestHeaders } : {}),
				};
				const anthropicRequest: unknown =
					isOAuthToken && client.beta
						? client.beta.messages.create({ ...params, stream: true }, requestOptions)
						: client.messages.create({ ...params, stream: true }, requestOptions);
				let streamedReplayUnsafeContent = false;

				try {
					let requestTimeout: NodeJS.Timeout | undefined;
					if (requestTimeoutMs !== undefined) {
						requestTimeout = setTimeout(
							() => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
							requestTimeoutMs,
						);
					}
					let anthropicStream: AsyncIterable<AnthropicStreamEvent>;
					let response: Response;
					let requestId: string | null;
					let recordsRawSseEvents: boolean;
					try {
						({
							events: anthropicStream,
							response,
							requestId,
							recordsRawSseEvents,
						} = await getAnthropicStreamResponse(anthropicRequest, requestSignal, rawSseObserver));
					} catch (error) {
						if (error instanceof AnthropicConnectionTimeoutError && !activeAbortTracker.wasCallerAbort()) {
							throw firstEventTimeoutAbortError;
						}
						throw error;
					} finally {
						if (requestTimeout !== undefined) clearTimeout(requestTimeout);
					}
					await notifyProviderResponse(options, response, model, requestId);
					let sawEvent = false;
					let sawMessageStart = false;
					let sawTerminalEnvelope = false;
					let sawMessageStop = false;
					// Set when a duplicate message_start splices a second envelope onto
					// the stream; closed indexes then refuse to reopen so replayed
					// content cannot duplicate (see content_block_start guard).
					let sawSplicedEnvelope = false;
					const closedBlockIndexes = new Set<number>();
					const openBlocks = new Map<
						number,
						{
							contentIndex: number;
							kind:
								| "text"
								| "thinking"
								| "redactedThinking"
								| "fallback"
								| "anthropicServerTool"
								| "toolCall"
								| "ignored";
						}
					>();

					// Pings keep the idle deadline alive once content is flowing (Anthropic
					// bridges legitimate generation gaps with keepalives), but only within a
					// bounded window: a wedged upstream that pings forever while the model
					// produces nothing must still trip the idle watchdog, otherwise an
					// active tool-call stream hangs unrecoverably with no retry (#4900).
					// A ping before message_start must not consume the first-event watchdog
					// either: it would flip the (retryable) pre-content stall classification
					// into a terminal mid-stream idle timeout.
					let sawNonPingEvent = false;
					let lastNonPingProgressAtMs = 0;
					const pingProgressCapMs =
						idleTimeoutMs !== undefined && idleTimeoutMs > 0
							? idleTimeoutMs * PING_PROGRESS_MAX_IDLE_MULTIPLIER
							: undefined;
					const timedAnthropicStream = iterateWithIdleTimeout(anthropicStream, {
						idleTimeoutMs,
						firstItemTimeoutMs: firstEventTimeoutMs,
						errorMessage: idleTimeoutAbortError.message,
						firstItemErrorMessage: firstEventTimeoutAbortError.message,
						onIdle: () => activeAbortTracker.abortLocally(idleTimeoutAbortError),
						onFirstItemTimeout: () => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
						abortSignal: options?.signal,
						isProgressItem: item => {
							if ((item as AnthropicStreamEvent).type === "ping") {
								if (!sawNonPingEvent) return false;
								if (pingProgressCapMs === undefined) return true;
								return Date.now() - lastNonPingProgressAtMs < pingProgressCapMs;
							}
							sawNonPingEvent = true;
							lastNonPingProgressAtMs = Date.now();
							return true;
						},
					});
					const observedAnthropicStream =
						rawSseObserver && !recordsRawSseEvents
							? observeDecodedAnthropicSdkEvents(timedAnthropicStream, rawSseObserver)
							: timedAnthropicStream;
					for await (const event of observedAnthropicStream) {
						sawEvent = true;

						if (event.type === "message_start") {
							if (sawMessageStart) {
								// Transparent reconnects can splice a fresh envelope onto the same
								// stream; keep the original message but surface the anomaly. Events
								// for blocks still open from the first envelope continue to apply,
								// but replayed blocks are dropped below (see closedBlockIndexes).
								reportAnthropicEnvelopeAnomaly("duplicate message_start event");
								sawSplicedEnvelope = true;
								continue;
							}
							sawMessageStart = true;
							const startMessage = event.message;
							if (startMessage?.id) output.responseId = startMessage.id;
							const startUsage = startMessage?.usage;
							if (startUsage) {
								applyAnthropicUsageExtras(output.usage, startUsage);
								output.usage.input = startUsage.input_tokens || 0;
								output.usage.output = startUsage.output_tokens || 0;
								output.usage.cacheRead = startUsage.cache_read_input_tokens || 0;
								output.usage.cacheWrite = startUsage.cache_creation_input_tokens || 0;
								output.usage.totalTokens =
									output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
								if (serverSideFallback) {
									const served = fallbackServedModelFromUsage(startUsage);
									if (served) output.model = served;
									if (!calculateFallbackTurnCost(model, output.usage, startUsage)) {
										calculateCost(model, output.usage);
									}
								} else {
									calculateCost(model, output.usage);
								}
							} else {
								reportAnthropicEnvelopeAnomaly("message_start missing usage");
							}
							continue;
						}

						if (!sawMessageStart) {
							if (shouldIgnoreAnthropicPreambleEvent(event.type)) {
								continue;
							}
							throw new AIError.AnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
						}

						if (event.type === "content_block_start") {
							if (sawTerminalEnvelope) {
								reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
								continue;
							}
							if (openBlocks.has(event.index)) {
								reportAnthropicEnvelopeAnomaly(`duplicate content_block_start index ${event.index}`);
								continue;
							}
							if (sawSplicedEnvelope && closedBlockIndexes.has(event.index)) {
								// A spliced envelope replaying an index this stream already
								// completed would append duplicate text/tool calls; consume its
								// events silently instead.
								reportAnthropicEnvelopeAnomaly(
									`replayed content_block_start index ${event.index} after duplicate message_start`,
								);
								openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
								continue;
							}
							if (!event.content_block?.type) {
								reportAnthropicEnvelopeAnomaly("content_block_start missing content_block payload");
								continue;
							}
							if (!firstTokenTime) firstTokenTime = performance.now();
							if (event.content_block.type === "fallback") {
								// Fallback boundary is only meaningful when the request
								// opted into the beta chain — silently drop otherwise so
								// unopted-in sessions never see the block persisted or
								// influence downstream converters.
								const fallback = parseAnthropicFallbackWireBlock(event.content_block);
								if (!serverSideFallback || !fallback) {
									if (!fallback) {
										reportAnthropicEnvelopeAnomaly("fallback content_block missing model refs");
									}
									openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
									continue;
								}
								const block: Block = { ...fallback, [kStreamingBlockIndex]: event.index };
								output.content.push(block);
								openBlocks.set(event.index, {
									contentIndex: output.content.length - 1,
									kind: "fallback",
								});
								// A fallback content block is the mid-stream signal that a
								// classifier block on the primary was retried on the
								// fallback model. Adopt the served id immediately so
								// pricing decisions downstream (final usage.iterations may
								// arrive before/after) see the right model.
								output.model = fallback.to.model;
								continue;
							}
							if (event.content_block.type === "text") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "text",
									text: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								const contentIndex = output.content.length - 1;
								openBlocks.set(event.index, { contentIndex, kind: "text" });
								stream.push({
									type: "text_start",
									contentIndex,
									partial: output,
								});
							} else if (event.content_block.type === "thinking") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "thinking",
									thinking: event.content_block.thinking ?? "",
									thinkingSignature: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								const contentIndex = output.content.length - 1;
								openBlocks.set(event.index, { contentIndex, kind: "thinking" });
								stream.push({
									type: "thinking_start",
									contentIndex,
									partial: output,
								});
								if (block.thinking) {
									stream.push({
										type: "thinking_delta",
										contentIndex,
										delta: block.thinking,
										partial: output,
									});
								}
							} else if (event.content_block.type === "redacted_thinking") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								openBlocks.set(event.index, {
									contentIndex: output.content.length - 1,
									kind: "redactedThinking",
								});
							} else if (
								isAnthropicServerToolHistoryBlock(event.content_block) &&
								(umansGatewayWebSearchHeader === undefined ||
									(event.content_block.type === "server_tool_use"
										? event.content_block.name !== "web_search"
										: event.content_block.type !== "web_search_tool_result"))
							) {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "anthropicServerTool",
									block: { ...event.content_block },
									[kStreamingPartialJson]: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								openBlocks.set(event.index, {
									contentIndex: output.content.length - 1,
									kind: "anthropicServerTool",
								});
							} else if (event.content_block.type === "tool_use") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: decodeAnthropicToolName(
										event.content_block.name,
										isOAuthToken,
										model.compat.escapeBuiltinToolNames,
									),
									arguments: event.content_block.input ?? {},
									[kStreamingPartialJson]: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								const contentIndex = output.content.length - 1;
								openBlocks.set(event.index, { contentIndex, kind: "toolCall" });
								stream.push({
									type: "toolcall_start",
									contentIndex,
									partial: output,
								});
							} else {
								openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
							}
						} else if (event.type === "content_block_delta") {
							if (sawTerminalEnvelope) {
								reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
								continue;
							}
							const openBlock = openBlocks.get(event.index);
							if (!openBlock) {
								reportAnthropicEnvelopeAnomaly(
									`received content_block_delta for unopened index ${event.index}`,
								);
								continue;
							}
							if (openBlock.kind === "ignored") continue;
							if (!event.delta?.type) {
								reportAnthropicEnvelopeAnomaly("content_block_delta missing delta payload");
								continue;
							}
							const block = blocks[openBlock.contentIndex];
							if (event.delta.type === "text_delta") {
								if (openBlock.kind !== "text" || block?.type !== "text") {
									reportAnthropicEnvelopeAnomaly(`received text_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: openBlock.contentIndex,
									delta: event.delta.text,
									partial: output,
								});
							} else if (event.delta.type === "thinking_delta") {
								if (openBlock.kind !== "thinking" || block?.type !== "thinking") {
									reportAnthropicEnvelopeAnomaly(`received thinking_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block.thinking += event.delta.thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: openBlock.contentIndex,
									delta: event.delta.thinking,
									partial: output,
								});
							} else if (event.delta.type === "input_json_delta") {
								if (
									openBlock.kind === "anthropicServerTool" &&
									block?.type === "anthropicServerTool" &&
									block.block.type === "server_tool_use"
								) {
									block[kStreamingPartialJson] =
										(block[kStreamingPartialJson] ?? "") + event.delta.partial_json;
									continue;
								}
								if (openBlock.kind !== "toolCall" || block?.type !== "toolCall") {
									reportAnthropicEnvelopeAnomaly(`received input_json_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block[kStreamingPartialJson] += event.delta.partial_json;
								const throttled = parseStreamingJsonThrottled(
									block[kStreamingPartialJson],
									block[kStreamingLastParseLen] ?? 0,
								);
								if (throttled) {
									block.arguments = throttled.value;
									block[kStreamingLastParseLen] = throttled.parsedLen;
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: openBlock.contentIndex,
									delta: event.delta.partial_json,
									partial: output,
								});
							} else if (event.delta.type === "signature_delta") {
								if (openBlock.kind !== "thinking" || block?.type !== "thinking") {
									reportAnthropicEnvelopeAnomaly(`received signature_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block.thinkingSignature = block.thinkingSignature || "";
								block.thinkingSignature += event.delta.signature;
							}
						} else if (event.type === "content_block_stop") {
							if (sawTerminalEnvelope) {
								reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
								continue;
							}
							const openBlock = openBlocks.get(event.index);
							if (!openBlock) {
								reportAnthropicEnvelopeAnomaly(`received content_block_stop for unopened index ${event.index}`);
								continue;
							}
							if (openBlock.kind === "ignored") {
								openBlocks.delete(event.index);
								continue;
							}
							const block = blocks[openBlock.contentIndex];
							if (!block || block.type !== openBlock.kind) {
								reportAnthropicEnvelopeAnomaly(`content_block_stop kind mismatch for index ${event.index}`);
								openBlocks.delete(event.index);
								continue;
							}
							openBlocks.delete(event.index);
							closedBlockIndexes.add(event.index);
							finalizeStreamBlock(block, openBlock.contentIndex);
						} else if (event.type === "message_delta") {
							if (sawTerminalEnvelope) {
								// A spliced reconnect's second envelope must not overwrite the
								// completed message's stop reason or usage.
								reportAnthropicEnvelopeAnomaly("received message_delta after terminal stop signal");
								continue;
							}
							const delta = event.delta;
							const rawStopReason = delta?.stop_reason;
							if (rawStopReason) {
								output.stopReason = mapStopReason(rawStopReason);
								sawTerminalEnvelope = true;
							}
							if (output.stopReason === "error") {
								const stopDetails = delta?.stop_details;
								output.stopDetails = stopDetails ?? (rawStopReason ? { type: rawStopReason } : null);
								if (stopDetails?.type === "refusal") {
									const explanation = stopDetails.explanation?.trim();
									const category = stopDetails.category;
									const label = category ? `Refusal (${category})` : "Refusal";
									output.errorMessage = explanation ? `${label}: ${explanation}` : label;
								} else if (!output.errorMessage) {
									// Anthropic flagged an error-class stop (refusal / sensitive) without
									// populating stop_details. Surface the raw reason instead of falling
									// through to the generic "unknown error" string when we throw below.
									output.errorMessage =
										rawStopReason === "refusal"
											? "Refusal (no details provided)"
											: rawStopReason === "sensitive"
												? "Content flagged by safety filters"
												: `Anthropic stream ended with stop_reason: ${rawStopReason ?? "unknown"}`;
								}
							}
							const deltaUsage = event.usage;
							if (deltaUsage) {
								if (deltaUsage.input_tokens != null) {
									output.usage.input = deltaUsage.input_tokens;
								}
								if (deltaUsage.output_tokens != null) {
									output.usage.output = deltaUsage.output_tokens;
								}
								if (deltaUsage.cache_read_input_tokens != null) {
									output.usage.cacheRead = deltaUsage.cache_read_input_tokens;
								}
								if (deltaUsage.cache_creation_input_tokens != null) {
									output.usage.cacheWrite = deltaUsage.cache_creation_input_tokens;
								}
								applyAnthropicUsageExtras(output.usage, deltaUsage);
								output.usage.totalTokens =
									output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
								if (serverSideFallback) {
									const served = fallbackServedModelFromUsage(deltaUsage);
									if (served) output.model = served;
									if (!calculateFallbackTurnCost(model, output.usage, deltaUsage)) {
										calculateCost(model, output.usage);
									}
								} else {
									calculateCost(model, output.usage);
								}
							}
						} else if (event.type === "message_stop") {
							sawTerminalEnvelope = true;
							sawMessageStop = true;
							// The protocol is complete even if a broken keep-alive leaves the HTTP body open.
							break;
						}
					}

					const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
					if (firstEventTimeoutError) {
						throw firstEventTimeoutError;
					}
					if (activeAbortTracker.wasCallerAbort()) {
						throw new AIError.AbortError();
					}
					if (!sawEvent || !sawMessageStart) {
						throw new AIError.AnthropicStreamEnvelopeError("stream ended before message_start");
					}
					if (!sawTerminalEnvelope) {
						// Neither a message_delta stop_reason nor message_stop arrived: the
						// connection died mid-generation. Finalizing the partial message as
						// a clean "stop" would make the agent loop treat the truncated turn
						// as complete (silent mid-sentence halt), so fail the turn. The
						// envelope error is transparently retried before replay-unsafe
						// content streams; afterwards it surfaces as an error turn whose
						// complete tool calls the agent loop salvages
						// (`recoverTransientErrorToolTurn` recognizes the envelope-error
						// text and `retainCompletedToolCalls` drops half-streamed calls).
						throw new AIError.AnthropicStreamEnvelopeError("stream ended before message_stop");
					}
					if (!sawMessageStop) {
						// A stop_reason arrived via message_delta, so generation finished;
						// only the trailing message_stop frame is missing (non-conforming
						// gateway). Degrade to best-effort instead of discarding the turn.
						reportAnthropicEnvelopeAnomaly("stream ended before message_stop");
					}
					if (openBlocks.size > 0) {
						for (const [openIndex, openBlock] of openBlocks) {
							reportAnthropicEnvelopeAnomaly(
								`stream ended with an unterminated ${openBlock.kind} block at index ${openIndex}`,
							);
							if (openBlock.kind === "ignored" || openBlock.contentIndex < 0) continue;
							const danglingBlock = blocks[openBlock.contentIndex];
							if (danglingBlock) finalizeStreamBlock(danglingBlock, openBlock.contentIndex);
						}
						openBlocks.clear();
					}

					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
							provider: model.provider,
							kind: "output",
						});
					}
					break;
				} catch (streamError) {
					const streamFailure = activeAbortTracker.getLocalAbortReason() ?? streamError;
					if (
						!disableStrictTools &&
						firstTokenTime === undefined &&
						hasStrictAnthropicTools(params) &&
						AIError.isGrammarError(streamFailure)
					) {
						// Log-only: the retried turn must not carry an errorMessage on
						// success (consumers treat its presence as failure).
						logger.warn("anthropic: strict tools rejected, retrying without strict tools", {
							model: model.id,
							error: await finalizeErrorMessage(streamFailure, rawRequestDump),
						});
						if (providerSessionState) {
							providerSessionState.strictToolsDisabled = true;
						}
						disableStrictTools = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.errorMessage = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!forceDemoteUnsignedThinking &&
						firstTokenTime === undefined &&
						!streamedReplayUnsafeContent &&
						isInvalidThinkingSignatureError(
							streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						)
					) {
						logger.warn(
							"anthropic: signing proxy detected (Invalid signature in thinking block), demoting unsigned thinking and retrying",
							{
								provider: model.provider,
								model: model.id,
								baseUrl,
								error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
							},
						);
						if (providerSessionState) {
							providerSessionState.replayUnsignedThinkingDisabled = true;
						}
						forceDemoteUnsignedThinking = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.errorMessage = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!dropFastMode &&
						model.provider === "anthropic" &&
						options?.serviceTier === "priority" &&
						firstTokenTime === undefined &&
						AIError.isFastModeUnsupported(streamFailure)
					) {
						logger.debug("anthropic: fast mode unsupported, retrying without speed", {
							model: model.id,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
						if (providerSessionState) {
							providerSessionState.fastModeDisabled = true;
						}
						dropFastMode = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.errorMessage = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					const isTransientEnvelopeFailure =
						AIError.isTransientStreamParseError(streamFailure) || AIError.isStreamEnvelopeError(streamFailure);
					const isLocalIdleTimeout =
						streamFailure === idleTimeoutAbortError ||
						(streamFailure instanceof Error && streamFailure.message === idleTimeoutAbortError.message);
					const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !streamedReplayUnsafeContent;
					const canRetryProviderFailure =
						!isLocalIdleTimeout &&
						firstTokenTime === undefined &&
						!streamedReplayUnsafeContent &&
						isProviderRetryableError(streamFailure, model.provider);
					if (
						activeAbortTracker.wasCallerAbort() ||
						providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
						(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
					) {
						throw streamFailure;
					}
					providerRetryAttempt++;
					// Copilot's model-availability 400 is a per-request replica reroll, not
					// upstream backpressure — the exponential curve would just add dead
					// time to a coin flip that the next attempt is as likely to win.
					const backoffDelayMs = AIError.isCopilotTransientModelError(streamFailure)
						? COPILOT_MODEL_FLAP_RETRY_DELAY_MS
						: calculateAnthropicRetryDelayMs(providerRetryAttempt - 1);
					// Honor the server's retry hint (`retry-after-ms`/`retry-after`) on
					// 429/529-style failures: retrying sooner than the server asked is a
					// guaranteed failure that just burns the retry budget.
					const headerDelayMs = getRetryAfterMsFromHeaders(getHeadersFromError(streamFailure));
					// Bound the server-directed wait so a multi-hour `retry-after` cannot
					// park the provider stream before higher-level recovery runs. A non-positive cap
					// disables the bound; an over-cap hint surfaces the original error immediately.
					const maxRetryDelayMs = options?.maxRetryDelayMs ?? 60_000;
					if (headerDelayMs !== undefined && maxRetryDelayMs > 0 && headerDelayMs > maxRetryDelayMs) {
						throw streamFailure;
					}
					const delayMs = headerDelayMs !== undefined ? Math.max(headerDelayMs, backoffDelayMs) : backoffDelayMs;
					if (options?.providerRetryWait) {
						await options.providerRetryWait(delayMs, options.signal);
					} else {
						await scheduler.wait(delayMs, { signal: options?.signal });
					}
					output.content.length = 0;
					output.model = model.id;
					output.responseId = undefined;
					output.errorMessage = undefined;
					output.stopDetails = undefined;
					output.providerPayload = undefined;
					output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
					output.stopReason = "stop";
					firstTokenTime = undefined;
				}
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			if (dropFastMode && model.provider === "anthropic" && options?.serviceTier === "priority") {
				output.disabledFeatures = [...(output.disabledFeatures ?? []), "priority"];
			}
			if (forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking) {
				output.disabledFeatures = [...(output.disabledFeatures ?? []), "unsigned-thinking-replay"];
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker: activeAbortTracker,
				rawRequestDump,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = maybeAddReplayUnsignedThinkingHint(model, result.message);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Public entry: retry benign empty completions before they reach the agent
 * loop. The inner attempt owns Anthropic provider-failure retries.
 */
export const streamAnthropic: StreamFunction<"anthropic-messages"> = (model, context, options) =>
	withReplaySafeStreamRetry(model, context, options, streamAnthropicOnce, {
		retryEmptyCompletion: true,
	});

export type AnthropicSystemBlock = {
	type: "text";
	text: string;
};
type SystemBlockOptions = {
	includeClaudeCodeInstruction?: boolean;
	extraInstructions?: string[];
	/** Text of the first user message — used as fingerprint seed for the billing header. */
	firstUserMessageText?: string;
};

export function buildAnthropicSystemBlocks(
	systemPrompt: readonly string[] | undefined,
	options: SystemBlockOptions = {},
): AnthropicSystemBlock[] | undefined {
	const { includeClaudeCodeInstruction = false, extraInstructions = [], firstUserMessageText } = options;
	const sanitizedPrompts = normalizeSystemPrompts(systemPrompt);
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingHeader = sanitizedPrompts.some(prompt => prompt.startsWith(CLAUDE_BILLING_HEADER_PREFIX));

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const blocks: AnthropicSystemBlock[] = [
			{ type: "text", text: createClaudeBillingHeader(firstUserMessageText ?? "") },
			{ type: "text", text: claudeCodeSystemInstruction },
		];

		for (const instruction of trimmedInstructions) {
			blocks.push({ type: "text", text: instruction });
		}
		for (const prompt of sanitizedPrompts) {
			blocks.push({ type: "text", text: prompt });
		}

		return blocks;
	}

	const blocks: AnthropicSystemBlock[] = [];
	for (const instruction of trimmedInstructions) {
		blocks.push({ type: "text", text: instruction });
	}
	for (const prompt of sanitizedPrompts) {
		blocks.push({ type: "text", text: prompt });
	}
	return blocks.length > 0 ? blocks : undefined;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}

export function buildAnthropicClientOptions(args: AnthropicClientOptionsArgs): AnthropicClientOptionsResult {
	const {
		model,
		apiKey,
		extraBetas = [],
		stream = true,
		interleavedThinking = true,
		headers,
		dynamicHeaders,
		hasTools = false,
		thinkingEnabled = false,
		isOAuth,
		maxRetryDelayMs,
		claudeCodeSessionId,
		disableStrictTools: disableStrictToolsOverride,
	} = args;
	const compat = model.compat;
	const disableStrictTools = disableStrictToolsOverride ?? compat.disableStrictTools;
	const baseUrl = resolveAnthropicBaseUrl(model, apiKey);
	// Adaptive models (`supportsDisplay`) get native interleaved thinking on the
	// official API, so only non-official signing routes need the beta (#6717).
	// Two classifications feed the predicate: the effective URL, because Foundry
	// and provider overrides can reroute a model without rebuilding its
	// materialized compat, and non-official `compat.signingEndpoint`, because
	// provider ids (e.g. ZenMux on a mirror URL) and explicit spec overrides on
	// opaque proxies are authoritative even when the URL isn't recognized.
	// Stale-official compat never qualifies: a canonical model rerouted to an
	// unrecognized proxy keeps `officialEndpoint: true` (see
	// resolveEagerToolInputStreamingSupport), and signing there is unknowable.
	// Two signing routes still can't take the beta as this `anthropic-beta` HTTP
	// header, so they're excluded: Vertex rawPredict accepts betas only in the
	// JSON body (`anthropic_beta`) and 400s on the header (#5614), and GitHub
	// Copilot rejects Anthropic betas outright — the `github-copilot` provider
	// branch below strips them, but a custom provider id or a canonical model
	// rerouted to `api.githubcopilot.com` / `copilot-api.*` reaches the generic
	// header builder instead, so exclude those effective URLs here too.
	const needsInterleavedBeta =
		interleavedThinking &&
		(!model.thinking?.supportsDisplay ||
			(!isOfficialAnthropicApiUrl(baseUrl) &&
				(isAnthropicSigningProxyUrl(baseUrl) || (compat.signingEndpoint && !compat.officialEndpoint)) &&
				!isVertexRawPredictUrl(baseUrl ?? "") &&
				!hostMatchesUrl(baseUrl, "githubCopilot")));
	const oauthToken = isOAuth ?? isAnthropicOAuthToken(apiKey);
	const supportsEagerToolInputStreaming = resolveEagerToolInputStreamingSupport(model, baseUrl);
	const needsFineGrainedToolStreamingBeta =
		hasTools && isOfficialAnthropicApiUrl(baseUrl) && !supportsEagerToolInputStreaming;
	const foundryCustomHeaders = resolveAnthropicCustomHeaders(model, baseUrl);
	const tlsFetchOptions = buildCoworkTlsFetchOptions(model, baseUrl);
	// Disable Bun's native ~300s pre-response fetch timeout (issue #2422).
	// `AnthropicMessagesClient` already arms its own DEFAULT_TIMEOUT_MS timer
	// per request, so the native ceiling can only short-circuit slow-prefill
	// streams before the configured watchdog gets to govern them.
	const fetchOptions: AnthropicFetchOptions = { ...(tlsFetchOptions ?? {}), timeout: false };
	const baseFetch = args.fetch ?? fetch;
	// Only OAuth requests inject the CC billing header; no API-key request can ever
	// contain it, so there is no need to install the rewriter for those.
	const cchFetch = oauthToken ? wrapFetchForCch(baseFetch) : baseFetch;
	if (model.provider === "github-copilot") {
		const copilotApiKey = parseGitHubCopilotApiKey(apiKey).accessToken;
		// The GitHub Copilot Anthropic proxy doesn't accept Anthropic beta
		// features. Forward only caller-supplied betas.
		const betaFeatures = [...extraBetas];
		const defaultHeaders = mergeHeaders(
			{
				Accept: stream ? "text/event-stream" : "application/json",
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				"Anthropic-Dangerous-Direct-Browser-Access": "true",
				Authorization: `Bearer ${copilotApiKey}`,
				...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
			},
			model.headers,
			dynamicHeaders,
			headers,
		);

		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: copilotApiKey,
			baseURL: baseUrl,
			maxRetries: 5,
			maxRetryDelayMs,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	const betaFeatures = [...extraBetas];
	if (needsFineGrainedToolStreamingBeta) {
		betaFeatures.push(fineGrainedToolStreamingBeta);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(interleavedThinkingBeta);
	}

	const defaultHeaders = buildAnthropicHeaders({
		apiKey,
		baseUrl,
		isOAuth: oauthToken,
		extraBetas: betaFeatures,
		stream,
		modelHeaders: mergeHeaders(
			model.headers,
			foundryCustomHeaders,
			getUmansWebSearchHeader(model, mergeHeaders(model.headers, headers)),
			headers,
			dynamicHeaders,
		),
		isCloudflareAiGateway: model.provider === "cloudflare-ai-gateway",
		allowAnthropicHeaderOverrides: model.compat.allowAnthropicHeaderOverrides,
		claudeCodeSessionId,
		coworkBetas: oauthToken ? buildCoworkBetas(hasTools || thinkingEnabled, thinkingEnabled, disableStrictTools) : [],
	});

	if (model.provider === "cloudflare-ai-gateway") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			maxRetryDelayMs,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	// OpenCode Go/Zen and Umans validate Anthropic-compatible API-key auth
	// through `X-Api-Key`; bearer-only requests reach the endpoint but fail auth
	// with `401 Missing API key` (#6510). Drop the auto-built `Authorization`
	// header and keep `apiKey` so the client emits `X-Api-Key`.
	if (model.provider === "opencode-go" || model.provider === "opencode-zen" || model.provider === "umans") {
		delete defaultHeaders.Authorization;
		return {
			isOAuthToken: false,
			apiKey,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			maxRetryDelayMs,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	// Suppress the client-level `X-Api-Key` whenever an `Authorization` header
	// already sits in `defaultHeaders` for a non-official, non-OAuth endpoint —
	// either our auto-built `Bearer <apiKey>` or a caller-supplied custom auth
	// scheme via `model.headers` (#3391). Adding a bonus `X-Api-Key` would force
	// the proxy to deal with two competing credentials when the user explicitly
	// asked for one.
	const authorizationHeader = getHeaderCaseInsensitive(defaultHeaders, "Authorization");
	const shouldSuppressClientApiKey =
		!oauthToken && !model.compat.officialEndpoint && typeof authorizationHeader === "string";

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken || shouldSuppressClientApiKey ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: 5,
		maxRetryDelayMs,
		defaultHeaders,
		fetch: cchFetch,
		fetchOptions,
	};
}

function createClient(
	model: Model<"anthropic-messages">,
	args: AnthropicClientOptionsArgs,
): { client: AnthropicMessagesClient; isOAuthToken: boolean } {
	const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
	const client = new AnthropicMessagesClient(clientOptions);
	return { client, isOAuthToken: oauthToken };
}

function disableThinkingIfToolChoiceForced(
	params: MessageCreateParamsStreaming,
	model: Model<"anthropic-messages">,
): void {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return;
	if (toolChoice.type !== "any" && toolChoice.type !== "tool") return;

	delete params.thinking;
	delete params.context_management;

	// Adaptive-only models can't be switched off by omitting `thinking` — a bare
	// omission defaults to adaptive thinking ON, so a forced-tool turn would still
	// reason instead of calling the tool (#6589). Pin the lowest adaptive effort
	// instead of dropping it, mirroring the disable branch in buildParams. Vertex
	// rawPredict is the sole exception: it can only carry the effort beta in the
	// body (dropped there too, see buildParams), so it keeps the delete behavior.
	// The effort beta itself is attached at the request site — including per-request
	// for injected SDK clients that bypass client-level beta construction.
	if (isAdaptiveOnlyThinking(model) && model.provider !== "google-vertex") {
		const outputConfig = (params.output_config as AnthropicOutputConfig | undefined) ?? {};
		outputConfig.effort = "low";
		params.output_config = outputConfig;
		return;
	}

	const outputConfig = params.output_config as AnthropicOutputConfig | undefined;
	if (!outputConfig) return;

	delete outputConfig.effort;
	if (Object.keys(outputConfig).length === 0) {
		delete params.output_config;
	}
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, maxAllowedTokens: number): void {
	const thinking = params.thinking;
	if (thinking?.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const currentMaxTokens = Math.min(params.max_tokens ?? maxAllowedTokens, maxAllowedTokens);
	const raisedMaxTokens = Math.min(
		Math.max(currentMaxTokens, budgetTokens + OUTPUT_FALLBACK_BUFFER),
		maxAllowedTokens,
	);
	params.max_tokens = raisedMaxTokens;

	if (budgetTokens + OUTPUT_FALLBACK_BUFFER <= raisedMaxTokens) return;

	const clampedBudget = raisedMaxTokens - OUTPUT_FALLBACK_BUFFER;
	if (clampedBudget <= 0) {
		throw new AIError.ConfigurationError(
			`Anthropic thinking budget requires max_tokens greater than ${OUTPUT_FALLBACK_BUFFER}; got ${raisedMaxTokens}`,
		);
	}
	thinking.budget_tokens = clampedBudget;
}

function applyCacheControlToLastBlock(blocks: ContentBlockParam[], cacheControl: AnthropicCacheControl): boolean {
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		// Anthropic rejects cache_control on generated reasoning and fallback
		// boundary blocks. Preserve the requested trailing boundary on every
		// ordinary content block, including tool use and tool results.
		if (block.type === "thinking" || block.type === "redacted_thinking" || block.type === "fallback") {
			continue;
		}
		if ("cache_control" in block && block.cache_control != null) return false;
		blocks[index] = { ...block, cache_control: cloneAnthropicCacheControl(cacheControl) };
		return true;
	}
	return false;
}

function applyPromptCaching(params: MessageCreateParamsStreaming, cacheControl?: AnthropicCacheControl): void {
	if (!cacheControl) return;

	// `convertAnthropicMessages` appends this neutral pad after a trailing
	// assistant because Anthropic rejects assistant-prefill endings. It is absent
	// from the next normal turn, so anchor the rolling window on the preceding
	// real assistant instead.
	const trailingIndex = params.messages.length - 1;
	const trailingMessage = params.messages[trailingIndex];
	const hasTrailingAssistantPad =
		trailingMessage?.role === "user" &&
		trailingMessage.content === "Continue." &&
		params.messages[trailingIndex - 1]?.role === "assistant";
	const messageEnd = hasTrailingAssistantPad ? trailingIndex - 1 : trailingIndex;
	const start = Math.max(0, messageEnd - 1);
	for (let index = messageEnd; index >= start; index--) {
		const message = params.messages[index];
		if (!message) continue;
		if (typeof message.content === "string") {
			message.content = [
				{ type: "text", text: message.content, cache_control: cloneAnthropicCacheControl(cacheControl) },
			];
		} else if (Array.isArray(message.content)) {
			applyCacheControlToLastBlock(message.content, cacheControl);
		}
	}
}

function usesAdaptiveThinkingTagOnly(model: Model<"anthropic-messages">): boolean {
	const thinking = model.thinking;
	if (thinking?.mode !== "anthropic-adaptive") return false;
	const effortMap = thinking.effortMap;
	if (!effortMap) return false;
	for (const effort of thinking.efforts) {
		if (effortMap[effort] !== "adaptive") return false;
	}
	return thinking.efforts.length > 0;
}

/**
 * True for adaptive-only Claude models (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5)
 * that reject `thinking.type: "disabled"`. Turning thinking off on these models
 * means omitting the `thinking` field entirely and pinning the lowest adaptive
 * effort — a bare omission defaults to adaptive thinking ON. Excludes MiniMax,
 * which drives adaptive thinking through the `thinking.type: "adaptive"` tag
 * itself rather than `output_config.effort`.
 */
function isAdaptiveOnlyThinking(model: Model<"anthropic-messages">): boolean {
	return (
		model.thinking?.mode === "anthropic-adaptive" &&
		!model.compat.disableAdaptiveThinking &&
		!usesAdaptiveThinkingTagOnly(model)
	);
}

function resolveAnthropicAdaptiveEffort(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
): AnthropicEffort | undefined {
	if (options.effort) return usesAdaptiveThinkingTagOnly(model) ? "adaptive" : options.effort;
	const requestedEffort = options.reasoning;
	if (!requestedEffort) return undefined;
	return mapEffortToAnthropicAdaptiveEffort(model, requestedEffort);
}

function extractClaudeCodeFirstUserMessageText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const { content } = message;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		for (const block of content) {
			if (block.type === "text") return block.text;
		}
		return "";
	}
	return "";
}

type AnthropicParamBuildOptions = {
	disableStrictTools: boolean;
	useUmansGatewayWebSearch: boolean;
	forceDemoteUnsignedThinking: boolean;
	supportsEagerToolInputStreaming: boolean;
	/** Sanitized server-side fallback entries; defaults to `options?.fallbacks` when omitted. */
	fallbacks?: AnthropicOptions["fallbacks"];
};

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options: AnthropicOptions | undefined,
	buildOptions: AnthropicParamBuildOptions,
): MessageCreateParamsStreaming {
	const {
		disableStrictTools,
		useUmansGatewayWebSearch,
		forceDemoteUnsignedThinking,
		supportsEagerToolInputStreaming,
		fallbacks = options?.fallbacks,
	} = buildOptions;
	// A session-scoped auto-demote (learned from a live signing 400) clones the
	// resolved compat with `replayUnsignedThinking: false` so every subsequent
	// downstream read (convertAnthropicMessages, transformMessages) sees the
	// demoted default without mutating the shared `model` reference.
	const effectiveModel =
		forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking
			? { ...model, compat: { ...model.compat, replayUnsignedThinking: false } }
			: model;
	const { cacheControl } = getCacheControl(model, options?.cacheRetention);

	// Pre-compute system blocks so they occupy the right slot in the serialized body.
	const shouldInjectClaudeCodeInstruction = isOAuthToken && !model.id.startsWith("claude-3-5-haiku");
	const firstUserMessageText = shouldInjectClaudeCodeInstruction
		? extractClaudeCodeFirstUserMessageText(context.messages)
		: "";
	const systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt, {
		includeClaudeCodeInstruction: shouldInjectClaudeCodeInstruction,
		firstUserMessageText,
	});

	// Pre-compute tools.
	let tools: AnthropicWireTool[] | undefined;
	if (context.tools) {
		tools = convertTools(
			context.tools,
			isOAuthToken,
			disableStrictTools || model.provider === "github-copilot",
			supportsEagerToolInputStreaming,
			model.compat.escapeBuiltinToolNames,
			useUmansGatewayWebSearch,
		);
	} else if (isOAuthToken) {
		tools = [];
	}

	// Pre-compute metadata.
	const metadataAccountId = readAnthropicMetadataAccountId(options?.metadata);
	const metadataUserId = resolveAnthropicMetadataUserId(
		readMetadataString(options?.metadata, "user_id") ??
			// Deliberately share the normalized affinity identity across Kimi's two transports.
			(model.provider === "kimi-code" ? getOpenAIPromptCacheKey(options) : undefined),
		isOAuthToken,
		options?.sessionId,
		metadataAccountId,
	);
	const metadata = metadataUserId ? { user_id: metadataUserId } : undefined;

	// Pre-compute thinking + output_config effort.
	let thinking: MessageCreateParamsStreaming["thinking"] | undefined;
	let outputConfigEffort: AnthropicOutputEffort | undefined;
	if (model.reasoning) {
		if (options?.thinkingEnabled || model.compat.requiresThinkingEnabled) {
			const thinkingOptions = options ?? {};
			const mode = model.thinking?.mode;
			const effort = resolveAnthropicAdaptiveEffort(model, thinkingOptions);
			const compat = model.compat;
			if (mode === "anthropic-adaptive" && !compat.disableAdaptiveThinking) {
				const adaptive: { type: "adaptive"; display?: AnthropicThinkingDisplay } = { type: "adaptive" };
				// Starting with Claude Opus 4.7 and Claude Fable/Mythos 5, adaptive thinking
				// content is omitted from the response by default. Opt into summarized
				// reasoning so thinking deltas keep streaming with human-readable content for
				// callers that rely on it. The `display` field is gated strictly on model
				// support: Opus 4.6 / Sonnet 4.6+ reject it with a 400, so an explicit
				// `thinkingDisplay` MUST NOT force it onto a model that can't accept it.
				if (model.thinking?.supportsDisplay) {
					adaptive.display = thinkingOptions.thinkingDisplay ?? "summarized";
				}
				thinking = adaptive;
				if (effort && effort !== "adaptive") outputConfigEffort = effort;
			} else {
				thinking = {
					type: "enabled",
					budget_tokens: thinkingOptions.thinkingBudgetTokens || 1024,
					display: thinkingOptions.thinkingDisplay ?? "summarized",
				};
				if (mode === "anthropic-budget-effort" && effort && effort !== "adaptive") outputConfigEffort = effort;
			}
		} else if (options?.thinkingEnabled === false) {
			if (isAdaptiveOnlyThinking(model)) {
				// Adaptive-only Claude models (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5) reject
				// `thinking.type: "disabled"` — adaptive thinking cannot be switched off.
				// Omit the thinking field (the API defaults to adaptive) and pin the
				// lowest effort so "thinking off" calls stay cheap instead of failing
				// the request with a 400 (a hidden-thinking toggle must never break it).
				// The effort field requires the `effort-2025-11-24` beta; it is attached
				// at the request site, including per-request for injected SDK clients.
				outputConfigEffort = "low";
			} else {
				thinking = { type: "disabled" };
			}
		}
	}

	// Pre-compute context_management. Send keep: "all" for every enabled or
	// adaptive thinking request (OAuth + API-key) — not just OAuth. Without
	// this directive Anthropic-compatible backends (Z.AI, Kimi, DeepSeek, …)
	// strip the replayed thinking blocks `replayUnsignedThinking` puts back
	// on the wire, so the model loses the prior reasoning chain across turns
	// and the KV cache misses every turn (#3288). Narrowing this guard back
	// to `isOAuthToken` regresses every API-key thinking provider. Skip
	// injected clients because this code cannot add the required
	// `context-management-2025-06-27` beta to caller-owned SDK clients. Skip
	// Copilot because its proxy strips Anthropic betas and demotes thinking
	// blocks to text upstream, so `keep: "all"` is a no-op that risks proxy
	// rejection of an unrecognized field. Skip Vertex rawPredict because that
	// adapter requires betas in the JSON body (`anthropic_beta`) instead of the
	// Anthropic HTTP beta header this code can add. Skip OpenCode Zen because
	// its Anthropic proxy rejects the unrecognized `context_management` field
	// with `400 Extra inputs are not permitted` on several Claude families
	// (#6510) — same rationale as Copilot.
	const shouldKeepThinkingContext =
		!options?.client &&
		model.provider !== "github-copilot" &&
		model.provider !== "google-vertex" &&
		model.provider !== "opencode-zen" &&
		(thinking?.type === "adaptive" || thinking?.type === "enabled");
	const contextManagement = shouldKeepThinkingContext
		? { edits: [{ type: "clear_thinking_20251015" as const, keep: "all" as const }] }
		: undefined;

	// Pre-compute output_config. Skip `effort` on Vertex rawPredict: it requires
	// the `effort-2025-11-24` beta, which that adapter can only accept in the body
	// (`anthropic_beta`), never as the `anthropic-beta` HTTP header this path sets
	// — so the field is dropped alongside the beta to avoid a 400 (#5614).
	const outputConfigEntries: AnthropicOutputConfig = {};
	if (outputConfigEffort && model.provider !== "google-vertex") outputConfigEntries.effort = outputConfigEffort;
	if (options?.taskBudget) outputConfigEntries.task_budget = options.taskBudget;
	const outputConfig = Object.keys(outputConfigEntries).length ? outputConfigEntries : undefined;

	// Claude Code requests at most 64k output tokens; clamp only OAuth requests,
	// where the wire fingerprint must match. API-key callers keep the full model
	// ceiling (e.g. 128k on Opus 4.8).
	const modelMaxTokens = model.maxTokens ?? CLAUDE_CODE_MAX_OUTPUT_TOKENS;
	const maxOutputTokens = isOAuthToken ? Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, modelMaxTokens) : modelMaxTokens;

	// Build params in the canonical field order: model → messages → system → tools →
	// metadata → max_tokens → thinking → context_management → output_config → stream.
	const params: MessageCreateParamsStreaming = {
		model: options?.requestModelId ?? model.requestModelId ?? model.id,
		messages: convertAnthropicMessages(context.messages, effectiveModel, isOAuthToken, {
			serverSideFallbackEnabled: !!fallbacks?.length,
		}),
		...(systemBlocks && { system: systemBlocks }),
		...(tools !== undefined && { tools }),
		...(metadata && { metadata }),
		max_tokens: Math.min(maxOutputTokens, options?.maxTokens ?? modelMaxTokens),
		...(thinking && { thinking }),
		...(contextManagement && { context_management: contextManagement }),
		...(outputConfig && { output_config: outputConfig }),
		...(fallbacks?.length ? { fallbacks } : {}),
		stream: true,
	};

	// Opus 4.7+ and Fable/Mythos 5 reject non-default sampling parameters with 400 error.
	const thinkingType = params.thinking?.type;
	const allowSamplingParams =
		model.compat.supportsSamplingParams && (thinkingType === undefined || thinkingType === "disabled");
	if (allowSamplingParams && options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (allowSamplingParams && options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (allowSamplingParams && options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		if (seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX && !warnedStopSequencesTrim) {
			warnedStopSequencesTrim = true;
			logger.warn("anthropic: stop_sequences exceeds 4; extra entries dropped", {
				received: seqs.length,
				kept: ANTHROPIC_STOP_SEQUENCES_MAX,
			});
		}
		params.stop_sequences =
			seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX ? seqs.slice(0, ANTHROPIC_STOP_SEQUENCES_MAX) : seqs;
	}

	if (model.provider === "anthropic" && options?.serviceTier === "priority") {
		params.speed = "fast";
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else if (options.toolChoice.name) {
			params.tool_choice = {
				...options.toolChoice,
				name: encodeAnthropicToolName(
					options.toolChoice.name,
					isOAuthToken,
					model.compat.escapeBuiltinToolNames,
					useUmansGatewayWebSearch,
				),
			};
		}
		// Claude Fable/Mythos 5 reject forced tool use outright ("tool_choice forces
		// tool use is not compatible with this model"). Downgrade any/tool → auto so the
		// request succeeds; the tool stays available and the caller's prompt steers
		// the model toward it.
		const choiceType = params.tool_choice?.type;
		if ((choiceType === "any" || choiceType === "tool") && !model.compat.supportsForcedToolChoice) {
			params.tool_choice = { type: "auto" };
		}
	}

	disableThinkingIfToolChoiceForced(params, model);
	ensureMaxTokensForThinking(params, maxOutputTokens);
	applyPromptCaching(params, cacheControl);

	return params;
}

const EMPTY_ERROR_TOOL_RESULT_TEXT = "Tool failed with no output.";

function isEmptyToolResultWireContent(content: AnthropicToolResultContent): boolean {
	if (typeof content === "string") {
		return content.trim().length === 0;
	}
	return content.length === 0;
}

function ensureErrorToolResultWireContent(
	content: AnthropicToolResultContent,
	isError: boolean | undefined,
): AnthropicToolResultContent {
	if (!isError || !isEmptyToolResultWireContent(content)) {
		return content;
	}
	return typeof content === "string"
		? EMPTY_ERROR_TOOL_RESULT_TEXT
		: [{ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT }];
}

function buildToolResultBlock(
	model: Model<"anthropic-messages">,
	msg: ToolResultMessage,
	hoistedImages: ContentBlockParam[],
): ContentBlockParam {
	let content = convertContentBlocks(msg.content, model.input.includes("image"));
	// Anthropic rejects images inside error tool results ("all content must be
	// type `text` if `is_error` is true") — keep the text in the block and
	// hoist the images after the message's tool_result run.
	if (msg.isError && typeof content !== "string" && content.some(block => block.type === "image")) {
		for (const block of content) {
			if (block.type === "image") hoistedImages.push(block);
		}
		content = content.filter(block => block.type === "text");
	}
	// An empty array is valid for the official API, but strict Anthropic-compatible
	// endpoints (Z.AI GLM: 400 code 1213 "The prompt parameter was not received
	// normally") reject it; the empty-string form is accepted by both.
	if (Array.isArray(content) && content.length === 0) {
		content = "";
	}
	content = ensureErrorToolResultWireContent(content, msg.isError);
	const block: ContentBlockParam = {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content,
		is_error: msg.isError,
	};
	if (model.compat.requiresToolResultId) {
		// Z.AI workaround (issue #814): include `id` aliased to `tool_use_id`.
		(block as unknown as Record<string, unknown>).id = msg.toolCallId;
	}
	return block;
}

/**
 * A single Anthropic conversation turn, including the mid-conversation
 * `system` role (Opus 4.8+ and Fable/Mythos 5).
 */
export type AnthropicMessageParam = MessageParam;

/**
 * Recursively replace lone surrogates in string leaves. Identity-preserving:
 * returns the input object/array when nothing changed.
 */
function toWellFormedDeep(value: unknown): unknown {
	if (typeof value === "string") {
		const wellFormed = value.toWellFormed();
		return wellFormed === value ? value : wellFormed;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(entry => {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			return sanitized;
		});
		return changed ? next : value;
	}
	if (isRecord(value)) {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			next[key] = sanitized;
		}
		return changed ? next : value;
	}
	return value;
}

/**
 * Serialize omp {@link Message}s to Anthropic wire messages.
 *
 * `opts.serverSideFallbackEnabled` — when the CURRENT request itself
 * opts into the server-side-fallback beta chain. Only then may a persisted
 * `fallback` content block from a prior turn be replayed on the wire;
 * otherwise the block is dropped to avoid a 400 on non-fallback requests
 * that don't send the beta.
 */
export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	opts?: { serverSideFallbackEnabled?: boolean },
): AnthropicMessageParam[] {
	// Indices of params emitted from `developer` messages. After the main pass,
	// the ones whose placement satisfies Anthropic's mid-conversation rules are
	// upgraded from the `user` role to the authoritative `system` role.
	const developerParamIndices: number[] = [];
	const params: AnthropicMessageParam[] = [];

	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user" || msg.role === "developer") {
			if (!msg.content) continue;

			let content: string | ContentBlockParam[];
			if (typeof msg.content === "string") {
				if (msg.content.trim().length === 0) continue;
				content = msg.content.toWellFormed();
			} else {
				const contentBlocks = convertContentBlocks(msg.content, model.input.includes("image"));
				if (typeof contentBlocks === "string") {
					if (contentBlocks.trim().length === 0) continue;
					content = contentBlocks;
				} else {
					if (contentBlocks.length === 0) continue;
					content = contentBlocks;
				}
			}
			if (msg.role === "developer") developerParamIndices.push(params.length);
			params.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			const hasSignedThinking = msg.content.some(
				block =>
					block.type === "thinking" && !!block.thinkingSignature && block.thinkingSignature.trim().length > 0,
			);

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: block.text.toWellFormed(),
					});
				} else if (block.type === "thinking") {
					if (hasSignedThinking) {
						if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
							if (block.thinking.trim().length === 0) continue;
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						if (model.compat.replayUnsignedThinking) {
							blocks.push({
								type: "thinking",
								thinking: block.thinking.toWellFormed(),
								signature: "",
							});
						} else {
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
						}
					} else {
						blocks.push({
							type: "thinking",
							thinking: block.thinking.toWellFormed(),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "redactedThinking") {
					if (block.data.trim().length === 0) continue;
					blocks.push({
						type: "redacted_thinking",
						data: block.data,
					});
				} else if (block.type === "anthropicServerTool") {
					blocks.push(block.block);
				} else if (block.type === "fallback") {
					// Replay ONLY when both sides are aligned: the current
					// request opted into the beta chain, and the target is
					// official Anthropic (the only endpoint that accepts the
					// block on the wire). `transformMessages` already drops
					// the block for cross-provider / non-official replays, so
					// this is defense-in-depth for direct convert calls.
					if (!opts?.serverSideFallbackEnabled || !model.compat.officialEndpoint) continue;
					blocks.push({
						type: "fallback",
						from: block.from,
						to: block.to,
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: encodeAnthropicToolName(block.name, isOAuthToken, model.compat.escapeBuiltinToolNames),
						// Always sanitize: the model itself can emit lone-surrogate escapes
						// in tool-argument JSON (streamed out fine, rejected with a 400 on
						// replay by Anthropic's strict UTF-8 validation). toWellFormedDeep
						// is identity-preserving, so well-formed arguments stay
						// byte-identical and prompt-cache prefixes are unaffected.
						input: toWellFormedDeep(block.arguments ?? {}),
					});
				}
			}
			// Anthropic's replay validator rejects any non-`tool_use` block that
			// appears after a `tool_use` inside an assistant turn (400:
			// "tool_use ids were found without tool_result blocks immediately
			// after: <id>"). A persisted turn can violate this when a mid-turn
			// server-side fallback handoff lands after the primary model already
			// emitted a tool_use — the replayed content is then e.g.
			// [thinking, text, tool_use, fallback, text, tool_use] — and also for
			// the older cross-provider [text, tool_use, text] shape (issue #544).
			// Stable-partition into [...non-tool_use, ...tool_use], preserving each
			// side's relative order: the non-tool_use chain (thinking → text →
			// fallback → text) carries thinking signatures and the fallback
			// boundary marker whose order Anthropic verifies, while tool_use blocks
			// are unsigned and safe to defer to the tail. Fast-path untouched when
			// already in order so prompt-cache prefixes stay byte-identical.
			let sawToolUse = false;
			let needsPartition = false;
			for (const block of blocks) {
				if (block.type === "tool_use") {
					sawToolUse = true;
				} else if (sawToolUse) {
					needsPartition = true;
					break;
				}
			}
			if (needsPartition) {
				const nonToolUse: ContentBlockParam[] = [];
				const toolUse: ContentBlockParam[] = [];
				for (const block of blocks) {
					if (block.type === "tool_use") toolUse.push(block);
					else nonToolUse.push(block);
				}
				blocks.length = 0;
				blocks.push(...nonToolUse, ...toolUse);
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];
			// Images stripped out of error tool results, re-attached after the run.
			const hoistedImages: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push(buildToolResultBlock(model, msg, hoistedImages));

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push(buildToolResultBlock(model, nextMsg, hoistedImages));
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			if (hoistedImages.length > 0) {
				toolResults.push(
					{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
					...hoistedImages,
				);
			}

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Upgrade developer-origin params to mid-conversation `system` messages where
	// Anthropic's placement rules allow it (Opus 4.8+ / Fable/Mythos 5 on first-party API).
	// Rules: a system message must immediately follow a `user` turn and must be
	// the last entry or be followed by an `assistant` turn — never first, and
	// never consecutive. Requiring the next param to be `assistant` (or absent)
	// covers both the "followed by assistant / last" and "no consecutive system"
	// constraints. Anything that does not qualify stays a `user` message.
	if (developerParamIndices.length > 0 && model.compat.supportsMidConversationSystem) {
		for (const idx of developerParamIndices) {
			const followsUser = idx > 0 && params[idx - 1]?.role === "user";
			const next = params[idx + 1];
			const lastOrBeforeAssistant = idx === params.length - 1 || next?.role === "assistant";
			// System content is text-only on the wire; a developer turn carrying
			// image blocks must stay a `user` message or the API rejects it.
			const content = params[idx].content;
			const textOnly = typeof content === "string" || content.every(block => block.type === "text");
			if (followsUser && lastOrBeforeAssistant && textOnly) {
				params[idx] = { role: "system", content };
			}
		}
	}
	// Dropped empty user/developer turns can leave two assistant params adjacent;
	// the API rejects consecutive assistant messages. Repair with the same neutral
	// nudge used for trailing-assistant prefill below.
	for (let i = params.length - 1; i > 0; i--) {
		if (params[i].role === "assistant" && params[i - 1]?.role === "assistant") {
			params.splice(i, 0, { role: "user", content: "Continue." });
		}
	}
	if (params.length > 0 && params[params.length - 1]?.role === "assistant") {
		params.push({ role: "user", content: "Continue." });
	}

	return params;
}

/**
 * JSON Schema whitelist for Anthropic tool `input_schema` nodes.
 *
 * Tracks the Anthropic Python SDK's `lib/_parse/_transform.py::transform_schema`,
 * with live Messages API guardrails for keywords the SDK preserves but the API rejects.
 * We keep only structural/metadata keywords Anthropic's validator honors, and demote
 * anything else into the node's `description` as `\n\n{key: value, ...}` so the model
 * still sees the constraint as a natural-language hint.
 *
 * `Set` (not `Record<string, true>`) because membership is probed against arbitrary
 * user/Zod-derived schema keys: a literal Record would falsely match prototype names
 * like `"toString"` and silently strip valid properties.
 */
const ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP = new Set([
	"$ref",
	"$defs",
	"$schema",
	"definitions",
	"type",
	"anyOf",
	"allOf",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"nullable",
]);
/** Keys preserved on `type: "object"` nodes (in addition to the universal set). */
const ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP = new Set(["properties", "required", "additionalProperties"]);
/** Keys preserved on `type: "array"` nodes; `minItems` only when its value is 0 or 1. */
const ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP = new Set(["items", "prefixItems", "minItems"]);
/** Keys preserved on `type: "string"` nodes; `format` only when its value is in the supported list. */
const ANTHROPIC_TOOL_SCHEMA_STRING_KEEP = new Set(["format"]);
/**
 * String `format` values Anthropic accepts; everything else (including `pattern`-style
 * format hints) gets demoted into `description`. Matches `SupportedStringFormats` in the
 * Anthropic SDK's `_transform.py`.
 */
const ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);
const ANTHROPIC_STRICT_TOOL_ALLOWLIST = new Set(["bash", "python", "edit", "find"]);
const MAX_ANTHROPIC_STRICT_TOOLS = 20;
const MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_ANTHROPIC_STRICT_UNION_PARAMETERS = 16;

/** `minItems` / `maxItems` apply to arrays; Anthropic rejects them on `type: "object"` (including `minItems: 0`/`1`). */
function isJsonSchemaArrayNode(schema: Record<string, unknown>): boolean {
	const t = schema.type;
	if (t === "array") return true;
	if (Array.isArray(t) && t.includes("array") && !t.includes("object")) return true;
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return true;
	return false;
}

function isJsonSchemaObjectNode(schema: Record<string, unknown>): boolean {
	if (isJsonSchemaArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	if (isRecord(schema.properties)) return true;
	return false;
}

/**
 * Pick the principal non-null scalar type from a `type` keyword. Anthropic accepts
 * `type` as either a single string or an array (e.g. `["number", "null"]` for a
 * nullable value); the SDK whitelist is keyed off the scalar type, with `"null"`
 * ignored so nullable variants are normalized as their underlying type.
 */
function pickAnthropicScalarType(type: unknown): string | undefined {
	if (typeof type === "string") return type;
	if (Array.isArray(type)) {
		for (const entry of type) {
			if (typeof entry === "string" && entry !== "null") return entry;
		}
	}
	return undefined;
}
function pickAnthropicEffectiveScalarType(schema: Record<string, unknown>): string | undefined {
	const explicit = pickAnthropicScalarType(schema.type);
	if (explicit) return explicit;
	if (isRecord(schema.properties)) return "object";
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return "array";
	return undefined;
}

function anthropicPerTypeKeep(scalarType: string | undefined): Set<string> | undefined {
	switch (scalarType) {
		case "object":
			return ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP;
		case "array":
			return ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP;
		case "string":
			return ANTHROPIC_TOOL_SCHEMA_STRING_KEEP;
		default:
			return undefined;
	}
}

/**
 * Normalize a JSON Schema node for Anthropic tool `input_schema`.
 *
 * Applies the full whitelist semantics from the Anthropic Python SDK's
 * `lib/_parse/_transform.py::transform_schema`:
 *
 * 1. Universal keys (`$ref`, `$defs`, `type`, `anyOf`, `allOf`, `enum`, `const`,
 *    `description`, `title`, `default`, `nullable`) are preserved on every node, with
 *    one position-dependent exception: the combinator keys. Root `anyOf`/`allOf` are
 *    spilled (recent Anthropic Messages validators reject combinators at the tool
 *    `input_schema` root) but kept when nested; `oneOf` is spilled at every position
 *    (it is not in the documented supported subset).
 * 2. Per-type keys are kept additively (object → `properties`/`required`/`additionalProperties`,
 *    array → `items`/`prefixItems` plus `minItems` only when 0 or 1, string → `format`
 *    only when in the supported value set).
 * 3. Everything else is demoted into the node's `description` as `\n\n{key: value, ...}`
 *
 * Object nodes default to `additionalProperties: false`, but explicit open-map
 * declarations (`additionalProperties: true` or a schema literal — Zod's
 * `z.record(z.string(), z.unknown())` produces `{}`) are preserved. The strict-mode
 * pass downstream demotes those shapes to non-strict instead of fabricating a closed
 * object, so callers like the resolve tool keep working open-map semantics.
 */
function normalizeAnthropicToolSchemaNode(
	schema: unknown,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
	isRoot = false,
): unknown {
	if (Array.isArray(schema)) return schema.map(entry => normalizeAnthropicToolSchemaNode(entry, cache));
	if (!isRecord(schema)) return schema;

	const existing = cache.get(schema);
	if (existing !== undefined) return existing;

	const result: Record<string, unknown> = {};
	cache.set(schema, result);

	const scalarType = pickAnthropicEffectiveScalarType(schema);
	const perTypeKeep = anthropicPerTypeKeep(scalarType);
	const spill: Array<[string, unknown]> = [];

	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;
		const value = schema[key];
		const isRootCombinator = isRoot && COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]);
		if (!isRootCombinator && (ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has(key) || perTypeKeep?.has(key))) {
			result[key] = value;
		} else {
			spill.push([key, value]);
		}
	}

	// Per-type conditional keys: prune within the kept set.
	if (scalarType === "string") {
		const format = result.format;
		if (typeof format === "string" && !ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has(format)) {
			spill.push(["format", format]);
			delete result.format;
		}
	}
	if (scalarType === "array" && result.minItems !== undefined) {
		const minItems = result.minItems;
		if (!(typeof minItems === "number" && (minItems === 0 || minItems === 1))) {
			spill.push(["minItems", minItems]);
			delete result.minItems;
		}
	}
	if (scalarType === "object" && result.additionalProperties === undefined) {
		result.additionalProperties = false;
	}

	// Recurse on structural keys.
	if (isRecord(result.properties)) {
		const normalizedProperties: Record<string, unknown> = {};
		const sourceProperties = result.properties as Record<string, unknown>;
		for (const propName in sourceProperties) {
			if (!Object.hasOwn(sourceProperties, propName)) continue;
			normalizedProperties[propName] = normalizeAnthropicToolSchemaNode(sourceProperties[propName], cache);
		}
		result.properties = normalizedProperties;
	}
	if (isRecord(result.additionalProperties)) {
		const normalized = normalizeAnthropicToolSchemaNode(result.additionalProperties, cache);
		if (isRecord(normalized) && Object.keys(normalized).length === 0) {
			result.additionalProperties = true;
		} else {
			result.additionalProperties = normalized;
		}
	}
	if (Array.isArray(result.items)) {
		result.items = result.items.map(item => normalizeAnthropicToolSchemaNode(item, cache));
	} else if (isRecord(result.items)) {
		result.items = normalizeAnthropicToolSchemaNode(result.items, cache);
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(item => normalizeAnthropicToolSchemaNode(item, cache));
	}
	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (Array.isArray(variants)) {
			result[key] = variants.map(variant => normalizeAnthropicToolSchemaNode(variant, cache));
		}
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefs: Record<string, unknown> = {};
		const sourceDefs = definitions as Record<string, unknown>;
		for (const name in sourceDefs) {
			if (!Object.hasOwn(sourceDefs, name)) continue;
			normalizedDefs[name] = normalizeAnthropicToolSchemaNode(sourceDefs[name], cache);
		}
		result[defsKey] = normalizedDefs;
	}

	spillToDescription(result, spill);
	return result;
}

export function normalizeAnthropicToolSchema(schema: unknown): unknown {
	return normalizeAnthropicToolSchemaNode(schema, new WeakMap(), true);
}

type AnthropicToolSchemaPlan = {
	inputSchema: AnthropicToolInputSchema;
	strict: boolean;
};

type AnthropicStrictBudget = {
	optionalRemaining: number;
	unionRemaining: number;
	optionalCount: number;
	unionCount: number;
};

function hasAnthropicUnionType(schema: Record<string, unknown>): boolean {
	return Array.isArray(schema.type) || Array.isArray(schema.anyOf);
}

function hasNullVariant(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(variant => isRecord(variant) && variant.type === "null");
}
function hasAnthropicSchemaDefiningKeyword(schema: Record<string, unknown>): boolean {
	if (
		schema.type !== undefined ||
		schema.properties !== undefined ||
		schema.additionalProperties !== undefined ||
		schema.items !== undefined ||
		schema.prefixItems !== undefined ||
		schema.enum !== undefined ||
		schema.const !== undefined ||
		schema.$ref !== undefined
	) {
		return true;
	}
	for (const key of COMBINATOR_KEYS) {
		if (schema[key] !== undefined) return true;
	}
	return schema.$defs !== undefined || schema.definitions !== undefined;
}

function makeAnthropicNullableSchema(schema: unknown, budget: AnthropicStrictBudget): unknown | undefined {
	if (isRecord(schema)) {
		if (hasNullVariant(schema)) return schema;
		if (Array.isArray(schema.anyOf)) {
			return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
		}
		if (Array.isArray(schema.type)) {
			return { ...schema, type: [...schema.type, "null"] };
		}
	}

	if (budget.unionRemaining <= 0) return undefined;
	budget.unionRemaining--;
	budget.unionCount++;
	return { anyOf: [schema, { type: "null" }] };
}

function normalizeAnthropicStrictSchemaNode(
	schema: unknown,
	budget: AnthropicStrictBudget,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): unknown | undefined {
	if (Array.isArray(schema)) {
		const result: unknown[] = [];
		for (const entry of schema) {
			const normalized = normalizeAnthropicStrictSchemaNode(entry, budget, cache);
			if (normalized === undefined) return undefined;
			result.push(normalized);
		}
		return result;
	}

	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached) return cached;

	if (!hasAnthropicSchemaDefiningKeyword(schema)) return undefined;

	// Strict tool use only supports closed objects. Open maps stay available on
	// the non-strict schema plan instead of producing an Anthropic 400.
	if (isJsonSchemaObjectNode(schema) && schema.additionalProperties !== false) {
		return undefined;
	}

	const result: Record<string, unknown> = { ...schema };
	cache.set(schema, result);

	if (hasAnthropicUnionType(result)) {
		if (budget.unionRemaining <= 0) return undefined;
		budget.unionRemaining--;
		budget.unionCount++;
	}

	if (isRecord(result.properties)) {
		const originalRequired = new Set(
			Array.isArray(result.required)
				? result.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		for (const [propertyName, propertySchema] of Object.entries(result.properties)) {
			const normalizedProperty = normalizeAnthropicStrictSchemaNode(propertySchema, budget, cache);
			if (normalizedProperty === undefined) return undefined;

			if (originalRequired.has(propertyName)) {
				properties[propertyName] = normalizedProperty;
				required.push(propertyName);
				continue;
			}

			if (budget.optionalRemaining > 0) {
				budget.optionalRemaining--;
				budget.optionalCount++;
				properties[propertyName] = normalizedProperty;
				continue;
			}

			const nullableProperty = makeAnthropicNullableSchema(normalizedProperty, budget);
			if (nullableProperty === undefined) return undefined;
			properties[propertyName] = nullableProperty;
			required.push(propertyName);
		}

		result.properties = properties;
		result.required = required;
	}

	if (Array.isArray(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	} else if (isRecord(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	}
	if (Array.isArray(result.prefixItems)) {
		const prefixItems = normalizeAnthropicStrictSchemaNode(result.prefixItems, budget, cache);
		if (prefixItems === undefined) return undefined;
		result.prefixItems = prefixItems;
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (!Array.isArray(variants)) continue;
		const normalizedVariants = normalizeAnthropicStrictSchemaNode(variants, budget, cache);
		if (normalizedVariants === undefined) return undefined;
		result[key] = normalizedVariants;
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefinitions: Record<string, unknown> = {};
		for (const [definitionName, definitionSchema] of Object.entries(definitions)) {
			const normalizedDefinition = normalizeAnthropicStrictSchemaNode(definitionSchema, budget, cache);
			if (normalizedDefinition === undefined) return undefined;
			normalizedDefinitions[definitionName] = normalizedDefinition;
		}
		result[defsKey] = normalizedDefinitions;
	}

	return result;
}

const ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS = [
	"oneOf",
	"allOf",
	"$ref",
	"patternProperties",
	"propertyNames",
] as const;

/**
 * Anthropic's strict grammar subset supports anyOf/type-array unions only.
 * oneOf/allOf/$ref compile unpredictably (rejections arrive as 400s the
 * grammar-too-large fallback does not recognize, so they would hard-fail the
 * turn), and patternProperties/propertyNames describe open key sets that the
 * strict pipeline's injected `additionalProperties: false` would contradict.
 * Runs against the raw wire schema — the base normalizer spills several of
 * these keywords into the description, erasing the evidence.
 */
function hasAnthropicStrictIncompatibleKeyword(schema: unknown, seen = new Set<object>()): boolean {
	if (Array.isArray(schema)) {
		if (seen.has(schema)) return false;
		seen.add(schema);
		return schema.some(entry => hasAnthropicStrictIncompatibleKeyword(entry, seen));
	}
	if (!isRecord(schema)) return false;
	if (seen.has(schema)) return false;
	seen.add(schema);
	for (const keyword of ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS) {
		if (schema[keyword] !== undefined) return true;
	}
	return Object.values(schema).some(value => hasAnthropicStrictIncompatibleKeyword(value, seen));
}

function normalizeAnthropicStrictSchema(
	schema: Record<string, unknown>,
	optionalRemaining: number,
	unionRemaining: number,
): { schema: Record<string, unknown>; optionalCount: number; unionCount: number } | undefined {
	const budget: AnthropicStrictBudget = {
		optionalRemaining,
		unionRemaining,
		optionalCount: 0,
		unionCount: 0,
	};
	const normalized = normalizeAnthropicStrictSchemaNode(schema, budget, new WeakMap());
	if (!isRecord(normalized)) return undefined;
	return { schema: normalized, optionalCount: budget.optionalCount, unionCount: budget.unionCount };
}

function buildAnthropicBaseToolInputSchema(tool: Tool): Record<string, unknown> {
	const jsonSchema = toolWireSchema(tool);
	return normalizeAnthropicToolSchema({
		...jsonSchema,
		type: "object",
		properties: isRecord(jsonSchema.properties) ? jsonSchema.properties : {},
		required: Array.isArray(jsonSchema.required)
			? jsonSchema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	}) as Record<string, unknown>;
}

function buildAnthropicToolSchemaPlans(tools: Tool[], disableStrictTools = false): AnthropicToolSchemaPlan[] {
	const plans = tools.map(
		(tool): AnthropicToolSchemaPlan => ({
			inputSchema: buildAnthropicBaseToolInputSchema(tool) as AnthropicToolInputSchema,
			strict: false,
		}),
	);
	if (NO_STRICT || disableStrictTools) return plans;

	const candidateIndexes = tools.flatMap((tool, index) => {
		if (!ANTHROPIC_STRICT_TOOL_ALLOWLIST.has(tool.name)) return [];
		if (tool.strict === false) return [];
		if (hasAnthropicStrictIncompatibleKeyword(toolWireSchema(tool))) return [];
		return [index];
	});

	let strictToolCount = 0;
	let strictOptionalParameterCount = 0;
	let strictUnionParameterCount = 0;
	for (const index of candidateIndexes) {
		if (strictToolCount >= MAX_ANTHROPIC_STRICT_TOOLS) break;

		const strictResult = normalizeAnthropicStrictSchema(
			plans[index].inputSchema as Record<string, unknown>,
			MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS - strictOptionalParameterCount,
			MAX_ANTHROPIC_STRICT_UNION_PARAMETERS - strictUnionParameterCount,
		);
		if (!strictResult) continue;

		plans[index] = {
			inputSchema: strictResult.schema as AnthropicToolInputSchema,
			strict: true,
		};
		strictToolCount++;
		strictOptionalParameterCount += strictResult.optionalCount;
		strictUnionParameterCount += strictResult.unionCount;
	}

	return plans;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	disableStrictTools = false,
	supportsEagerToolInputStreaming = true,
	escapeBuiltinToolNames = false,
	useUmansGatewayWebSearch = false,
): AnthropicWireTool[] {
	if (!tools) return [];
	const schemaPlans = buildAnthropicToolSchemaPlans(tools, disableStrictTools);

	return tools.map((tool, index) => {
		const plan = schemaPlans[index];
		const baseTool = {
			name: encodeAnthropicToolName(tool.name, isOAuthToken, escapeBuiltinToolNames, useUmansGatewayWebSearch),
			description: tool.description || "",
			input_schema: plan.inputSchema,
		};
		return {
			...baseTool,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(plan.strict ? { strict: true } : {}),
		};
	});
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		// Generation ran into the model's context window (default behavior on
		// Sonnet 4.5+); the streamed content is valid, just truncated.
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // A caller-supplied stop_sequences entry matched; the turn completed normally.
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// New stop reasons ship server-side first ("sensitive",
			// "model_context_window_exceeded") and arrive on the trailing
			// message_delta after all content has streamed. Degrade to a normal
			// stop instead of failing the fully streamed turn.
			reportAnthropicEnvelopeAnomaly(`unhandled stop reason: ${reason}`);
			return "stop";
	}
}
