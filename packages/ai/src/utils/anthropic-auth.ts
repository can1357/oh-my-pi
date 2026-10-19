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
import { buildAnthropicHeaders, mergeHeaders, resolveAnthropicCustomHeadersForBaseUrl } from "../providers/anthropic";
import { normalizeAnthropicBaseUrl } from "../providers/anthropic-state";
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

/** Optional request-shaping overrides for an already-resolved Anthropic credential. */
export interface AnthropicAuthOptions {
	/** Override token detection; false explicitly disables OAuth-style request shaping. */
	isOAuth?: boolean;
}

/**
 * Build an {@link AnthropicAuthConfig} from an already-resolved API key.
 *
 * `apiKey` is whatever the caller chose for `Authorization`/`x-api-key` —
 * usually `authStorage.getApiKey("anthropic")`. `baseUrl` overrides the
 * env-derived base; pass `undefined` to fall back to FOUNDRY/ANTHROPIC env
 * resolution and finally `DEFAULT_BASE_URL`.
 *
 * `options.isOAuth` defaults to token detection. Pass the selected model's
 * `isOAuth` to match the streaming path, which lets the model override the
 * prefix (custom `anthropic-messages` providers default to OAuth shaping).
 */
export function buildAnthropicAuthConfig(
	apiKey: string,
	baseUrl?: string,
	options: AnthropicAuthOptions = {},
): AnthropicAuthConfig {
	return {
		apiKey,
		baseUrl: normalizeBaseUrl(baseUrl) ?? resolveAnthropicBaseUrlFromEnv() ?? DEFAULT_BASE_URL,
		isOAuth: options.isOAuth ?? isOAuthToken(apiKey),
	};
}

/** Configured headers and fingerprint override policy for Anthropic hosted web search. */
export interface AnthropicSearchHeaderOptions {
	/** The selected model's configured headers (`ModelRegistry.resolveModelHeaders`). */
	modelHeaders?: Record<string, string>;
	/** The selected model's `compat.allowAnthropicHeaderOverrides`. */
	allowAnthropicHeaderOverrides?: boolean;
}

/**
 * Builds HTTP headers for Anthropic API requests (search variant).
 *
 * Model headers and `ANTHROPIC_CUSTOM_HEADERS` (when the resolver deems them
 * applicable: Foundry mode, or a non-Anthropic base URL such as an enterprise
 * gateway) go through the same case-insensitive merge and enforced-header
 * filtering as the streaming path, so web search behaves identically.
 */
export function buildAnthropicSearchHeaders(
	auth: AnthropicAuthConfig,
	options: AnthropicSearchHeaderOptions = {},
): Record<string, string> {
	return buildAnthropicHeaders({
		apiKey: auth.apiKey,
		baseUrl: auth.baseUrl,
		isOAuth: auth.isOAuth,
		extraBetas: ["web-search-2025-03-05"],
		stream: false,
		modelHeaders: mergeHeaders(options.modelHeaders, resolveAnthropicCustomHeadersForBaseUrl(auth.baseUrl)),
		allowAnthropicHeaderOverrides: options.allowAnthropicHeaderOverrides,
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
