/**
 * TrustedRouter gateway endpoint, shared so regional hosts (such as EU) or
 * custom proxy overrides normalize onto one `/v1` root across discovery,
 * inference, and model-cache scoping.
 */
export const TRUSTEDROUTER_API_BASE_URL = "https://api.trustedrouter.com/v1";

/**
 * Resolve a configured TrustedRouter base URL onto the gateway's `/v1` root.
 *
 * A blank or whitespace-only value is treated as absent and resolves to
 * {@link TRUSTEDROUTER_API_BASE_URL}; otherwise trailing slashes are trimmed
 * and `/v1` is appended when omitted.
 */
export function normalizeTrustedRouterBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return TRUSTEDROUTER_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
