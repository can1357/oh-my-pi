import { getClaudeCodeUserAgent } from "../providers/claude-code-fingerprint";

/** Canonical host for Claude's first-party account API. */
export const DEFAULT_CLAUDE_API_BASE_URL = "https://api.anthropic.com";
/** Canonical subscription usage and profile endpoint. */
export const DEFAULT_CLAUDE_OAUTH_BASE_URL = `${DEFAULT_CLAUDE_API_BASE_URL}/api/oauth`;
/** OAuth protocol beta required by Claude's account routes. */
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

/**
 * Normalize Messages (`/v1`) and OAuth (`/api/oauth`) endpoints to the common
 * API root used by both usage and reset routes. Custom path prefixes survive.
 */
export function normalizeClaudeApiBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_CLAUDE_API_BASE_URL;
	let url: URL;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		return DEFAULT_CLAUDE_API_BASE_URL;
	}
	let path = url.pathname.replace(/\/+$/, "");
	if (path === "/") path = "";
	const lower = path.toLowerCase();
	if (lower.endsWith("/api/oauth")) {
		path = path.slice(0, -"/api/oauth".length);
	} else if (lower.endsWith("/v1")) {
		path = path.slice(0, -"/v1".length);
	}
	return `${url.origin}${path}`;
}

/** Resolve the OAuth API base while retaining a configured proxy path prefix. */
export function claudeOAuthBaseUrl(baseUrl?: string): string {
	return `${normalizeClaudeApiBaseUrl(baseUrl)}/api/oauth`;
}

/** Configured OAuth endpoint followed by canonical fallback, without duplicates. */
export function claudeOAuthBaseUrls(baseUrl?: string): readonly string[] {
	const configured = claudeOAuthBaseUrl(baseUrl);
	return configured === DEFAULT_CLAUDE_OAUTH_BASE_URL
		? [DEFAULT_CLAUDE_OAUTH_BASE_URL]
		: [configured, DEFAULT_CLAUDE_OAUTH_BASE_URL];
}

/** Resolve a first-party account route against the configured Claude API root. */
export function claudeApiUrl(baseUrl: string | undefined, path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${normalizeClaudeApiBaseUrl(baseUrl)}${suffix}`;
}

/** Shared OAuth and CLI identity headers for Claude usage, profile, and resets. */
export function buildClaudeOAuthHeaders(
	accessToken: string,
	options: { beta?: string; json?: boolean } = {},
): Record<string, string> {
	return {
		accept: "application/json, text/plain, */*",
		"accept-encoding": "gzip, compress, deflate, br",
		"anthropic-beta": options.beta ?? CLAUDE_OAUTH_BETA,
		...(options.json === false ? {} : { "content-type": "application/json" }),
		connection: "keep-alive",
		"user-agent": getClaudeCodeUserAgent(),
		authorization: `Bearer ${accessToken}`,
	};
}
