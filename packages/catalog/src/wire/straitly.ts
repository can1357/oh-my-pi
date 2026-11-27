/**
 * Straitly gateway endpoint, shared across discovery, cache namespace hashing,
 * and tests so custom proxy overrides resolve onto a single normalized URL.
 */
export const STRAITLY_API_BASE_URL = "https://api.straitly.ai/v1";

/**
 * Resolve a configured Straitly base URL onto the gateway's `/v1` surface.
 * Blank or whitespace-only values resolve to the canonical host; other values
 * drop trailing slashes and append `/v1` when omitted.
 */
export function normalizeStraitlyBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return STRAITLY_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
