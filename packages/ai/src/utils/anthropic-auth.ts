/**
 * Anthropic Authentication
 *
 * Thin helper for turning an already-resolved API key into the request-shaping
 * config consumed by {@link buildAnthropicSearchHeaders} / {@link buildAnthropicUrl}.
 *
 * Credential storage and refresh live in `AuthStorage` — call
 * `authStorage.getApiKey("anthropic", sessionId)` first, then pass the result
 * through {@link buildAnthropicAuthConfig} for header/URL shaping.
 */
import { $env } from "@oh-my-pi/pi-utils";
import {
	buildAnthropicHeaders as buildProviderAnthropicHeaders,
	normalizeAnthropicBaseUrl,
	resolveAnthropicCustomHeadersForBaseUrl,
} from "../providers/anthropic";
import { isFoundryEnabled } from "./foundry";

/** Auth configuration for Anthropic */
export interface AnthropicAuthConfig {
	apiKey: string;
	baseUrl: string;
	isOAuth: boolean;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
	const trimmed = baseUrl?.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

export function resolveAnthropicBaseUrlFromEnv(): string | undefined {
	if (isFoundryEnabled()) {
		const foundryBaseUrl = normalizeBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) return foundryBaseUrl;
	}
	const anthropicBaseUrl = normalizeBaseUrl($env.ANTHROPIC_BASE_URL);
	return anthropicBaseUrl || undefined;
}

/**
 * Checks if a token is an OAuth token by looking for sk-ant-oat prefix.
 */
export function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

/**
 * Build an {@link AnthropicAuthConfig} from an already-resolved API key.
 *
 * `apiKey` is whatever the caller chose for `Authorization`/`x-api-key` —
 * usually `authStorage.getApiKey("anthropic")`. `baseUrl` overrides the
 * env-derived base; pass `undefined` to fall back to FOUNDRY/ANTHROPIC env
 * resolution and finally `DEFAULT_BASE_URL`.
 *
 * `isOAuth` is derived from the token prefix so the helper stays pure: callers
 * never have to thread the OAuth flag through their own resolution logic.
 */
export function buildAnthropicAuthConfig(apiKey: string, baseUrl?: string): AnthropicAuthConfig {
	return {
		apiKey,
		baseUrl: normalizeBaseUrl(baseUrl) ?? resolveAnthropicBaseUrlFromEnv() ?? DEFAULT_BASE_URL,
		isOAuth: isOAuthToken(apiKey),
	};
}

/**
 * Builds HTTP headers for Anthropic API requests (search variant).
 *
 * Forwards `ANTHROPIC_CUSTOM_HEADERS` when the resolver deems them applicable
 * (Foundry mode, or a non-Anthropic base URL — typically an enterprise
 * gateway), matching the streaming path so web search behaves identically.
 */
export function buildAnthropicSearchHeaders(auth: AnthropicAuthConfig): Record<string, string> {
	return buildProviderAnthropicHeaders({
		apiKey: auth.apiKey,
		baseUrl: auth.baseUrl,
		isOAuth: auth.isOAuth,
		extraBetas: ["web-search-2025-03-05"],
		stream: false,
		modelHeaders: resolveAnthropicCustomHeadersForBaseUrl(auth.baseUrl),
	});
}

/**
 * Builds the full API URL for Anthropic messages endpoint.
 */
export function buildAnthropicUrl(auth: AnthropicAuthConfig): string {
	const normalizedBaseUrl = normalizeAnthropicBaseUrl(auth.baseUrl);
	const base = `${normalizedBaseUrl}/v1/messages`;
	return `${base}?beta=true`;
}
