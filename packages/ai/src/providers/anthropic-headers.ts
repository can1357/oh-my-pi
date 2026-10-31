import { isOfficialAnthropicApiUrl, resolveAnthropicApiVersion } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { NO_AUTH_SENTINEL } from "../auth-retry";
import { getHeaderCaseInsensitive } from "../utils";
import { isFoundryEnabled } from "../utils/foundry";
import { claudeCodeSdkVersion, getClaudeCodeUserAgent } from "./claude-code-fingerprint";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
	isCloudflareAiGateway?: boolean;
	claudeCodeSessionId?: string;
	claudeCodeBetas?: readonly string[];
	/** Allow explicit fingerprint headers to replace OAuth defaults on non-official endpoints. */
	allowAnthropicHeaderOverrides?: boolean;
};

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
export function mergeAnthropicBetaHeader(callerHeaders: Record<string, string>, beta: string): Record<string, string> {
	for (const key in callerHeaders) {
		if (key.toLowerCase() === "anthropic-beta") {
			return { [key]: buildBetaHeader(normalizeExtraBetas(callerHeaders[key]), [beta]) };
		}
	}
	return { "anthropic-beta": beta };
}
const oauthAuthBeta = "oauth-2025-04-20";
const midConversationSystemBeta = "mid-conversation-system-2026-04-07";
export const midConversationSystemClearAtBeta = "mid-conversation-system-clear-at-2026-08-21";
export const midConversationToolChangesBeta = "mid-conversation-tool-changes-2026-07-01";
export const midConversationOutputConfigBeta = "mid-conversation-output-config-2026-07-01";
export const contextManagementBeta = "context-management-2025-06-27";
export const structuredOutputsBeta = "structured-outputs-2025-12-15";
const thinkingTokenCountBeta = "thinking-token-count-2026-05-13";
export const fallbackCreditBeta = "fallback-credit-2026-06-01";
export const promptCachingScopeBeta = "prompt-caching-scope-2026-01-05";
const claudeCodeUtilityBetaDefaults = [
	oauthAuthBeta,
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	promptCachingScopeBeta,
	structuredOutputsBeta,
] as const;
const claudeCodeAgentBetaDefaults = [
	"claude-code-20250219",
	oauthAuthBeta,
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	promptCachingScopeBeta,
	midConversationSystemBeta,
] as const;
export const extendedCacheTtlBeta = "extended-cache-ttl-2025-04-11";
export const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
export const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
export const fastModeBeta = "fast-mode-2026-02-01";
export const taskBudgetBeta = "task-budgets-2026-03-13";
export const effortBeta = "effort-2025-11-24";
export const serverSideFallbackBeta = "server-side-fallback-2026-06-01";

export function buildClaudeCodeBetas({
	agentRequest,
	thinkingRequest,
	disableStrictTools = false,
	supportsContextManagement = true,
	dropPromptCacheBetas = false,
}: {
	agentRequest: boolean;
	thinkingRequest: boolean;
	disableStrictTools?: boolean;
	supportsContextManagement?: boolean;
	/**
	 * Withhold the prompt-cache betas: this endpoint rejected `cache_control`,
	 * so a request that carries no breakpoint must not advertise caching it
	 * cannot use. This deviates from Claude Code's header fingerprint, which is
	 * acceptable here precisely because an endpoint that refuses the field is
	 * not the first-party API the fingerprint exists to match.
	 */
	dropPromptCacheBetas?: boolean;
}): readonly string[] {
	// `context-1m-2025-08-07` is intentionally never advertised. OAuth
	// subscription credentials have no long-context credit balance, so Anthropic
	// hard-429s ("Usage credits are required for long context requests") on any
	// beta-gated 1M model regardless of prompt size (#7238). Natively-1M models
	// (e.g. claude-sonnet-5) serve their full window without the beta anyway.
	if (!agentRequest && !disableStrictTools && supportsContextManagement && !dropPromptCacheBetas) {
		return claudeCodeUtilityBetaDefaults;
	}
	const betas: string[] = [];
	for (const beta of agentRequest ? claudeCodeAgentBetaDefaults : claudeCodeUtilityBetaDefaults) {
		if (disableStrictTools && beta === structuredOutputsBeta) continue;
		if (!supportsContextManagement && beta === contextManagementBeta) continue;
		if (dropPromptCacheBetas && beta === promptCachingScopeBeta) continue;
		betas.push(beta);
	}
	if (!agentRequest) return betas;
	if (thinkingRequest) betas.push(effortBeta);
	betas.push(fallbackCreditBeta);
	return betas;
}

function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
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
	// Claude Code's beta profile is part of the OAuth fingerprint; API-key
	// requests default to extras only, matching the streaming path.
	const betaHeader = buildBetaHeader(
		options.claudeCodeBetas ??
			(oauthToken ? buildClaudeCodeBetas({ agentRequest: true, thinkingRequest: true }) : []),
		extraBetas,
	);
	const apiVersion = resolveAnthropicApiVersion(options.baseUrl);
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
			if (enforcedHeaderKeys.has(lowerKey) && (oauthToken || !coworkHeaderKeys.has(lowerKey))) {
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
			"anthropic-version": apiVersion,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			"cf-aig-authorization": `Bearer ${options.apiKey}`,
		};
	}

	if (oauthToken) {
		const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent) ? incomingUserAgent : getClaudeCodeUserAgent();
		const headers = {
			...modelHeaders,
			Accept: acceptHeader,
			"Content-Type": "application/json",
			"User-Agent": userAgent,
			...(options.claudeCodeSessionId ? { "X-Claude-Code-Session-Id": options.claudeCodeSessionId } : {}),
			...claudeCodeHeaders,
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-version": apiVersion,
			Authorization: `Bearer ${options.apiKey}`,
			"x-app": "cli",
			Connection: "keep-alive",
			"Accept-Encoding": "gzip, deflate, br, zstd",
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
		return allowAnthropicHeaderOverrides ? mergeHeaders(headers, anthropicHeaderOverrides) : headers;
	} else if (!isOfficialAnthropicApiUrl(options.baseUrl)) {
		// A keyless provider (`auth: none`) resolves to the `N/A` sentinel
		// rather than a real key; custom endpoints that authenticate via their
		// own headers may reject a bogus bearer, so send no Authorization —
		// same sentinel guard as the openai transports. A caller-supplied
		// Authorization in `model.headers` still wins.
		const bearer =
			incomingAuthorization ?? (options.apiKey !== NO_AUTH_SENTINEL ? `Bearer ${options.apiKey}` : undefined);
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...(bearer ? { Authorization: bearer } : {}),
			...sharedHeaders,
			"anthropic-version": apiVersion,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
	} else {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			"anthropic-version": apiVersion,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingAuthorization ? { Authorization: incomingAuthorization } : {}),
			"X-Api-Key": incomingApiKey ?? options.apiKey,
		};
	}
}

/** Maps Node's platform identifier to the Stainless wire value. */
export function mapStainlessOs(platform: string): "MacOS" | "Windows" | "Linux" | "FreeBSD" | `Other::${string}` {
	switch (platform.toLowerCase()) {
		case "darwin":
			return "MacOS";
		case "windows":
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${platform.toLowerCase()}`;
	}
}

/** Maps Node's architecture identifier to the Stainless wire value. */
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

/** Static headers emitted by Claude Code's CLI runtime. */
export const claudeCodeHeaders = {
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-Lang": "js",
	"X-Stainless-OS": mapStainlessOs(process.platform),
	"X-Stainless-Package-Version": claudeCodeSdkVersion,
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": "v26.3.0",
	"X-Stainless-Timeout": "600",
};

/**
 * Cowork's fingerprint keys. Only the OAuth branch re-emits them, so only that
 * branch may enforce them: everywhere else nothing would fill the gap and
 * filtering would silently delete a client identity the caller built on
 * purpose (Factory Droid mirrors droid's Anthropic SDK fingerprint on this
 * wire, right down to the 600s client timeout).
 */
const coworkHeaderKeys = new Set(Object.keys(claudeCodeHeaders).map(key => key.toLowerCase()));

const enforcedHeaderKeys = new Set(
	[
		...Object.keys(claudeCodeHeaders),
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
	[...Object.keys(claudeCodeHeaders), "anthropic-beta", "User-Agent", "x-app"].map(key => key.toLowerCase()),
);

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

/**
 * Merge headers case-insensitively; later sources win and preserve their key casing.
 * Undefined sources are ignored. Differently cased duplicates are removed so the
 * Headers constructor cannot join competing values comma-separated on the wire.
 */
export function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
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

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}
