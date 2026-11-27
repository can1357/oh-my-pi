import { normalizeV1GatewayBaseUrl } from "./charm-hyper";

/**
 * TrustedRouter gateway endpoint, shared so regional hosts (such as EU) or
 * custom proxy overrides normalize onto one `/v1` root across discovery,
 * inference, and model-cache scoping.
 */
export const TRUSTEDROUTER_API_BASE_URL = "https://api.trustedrouter.com/v1";

/**
 * Resolve a configured TrustedRouter base URL onto the gateway's `/v1` root.
 *
 * Delegates to {@link normalizeV1GatewayBaseUrl} with
 * {@link TRUSTEDROUTER_API_BASE_URL} as the canonical default.
 */
export function normalizeTrustedRouterBaseUrl(baseUrl?: string): string {
	return normalizeV1GatewayBaseUrl(baseUrl, TRUSTEDROUTER_API_BASE_URL);
}
