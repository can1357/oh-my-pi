/**
 * Resolve a configured `/v1` OpenAI-compatible gateway base URL against its
 * canonical default.
 *
 * Every consumer must agree on this, because they key different things off the
 * result: inference and discovery target it, usage/key probes send a bearer
 * token to it, and the model-cache namespace is hashed from it. A blank or
 * whitespace-only value means "not configured" and resolves to `canonical`;
 * anything else trims trailing slashes and appends `/v1` when omitted.
 */
export function normalizeV1GatewayBaseUrl(baseUrl: string | undefined, canonical: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return canonical;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Charm Hyper gateway endpoint, shared so a host migration — or a self-hosted
 * proxy override — touches a single module.
 */
export const CHARM_HYPER_API_BASE_URL = "https://hyper.charm.land/v1";

/**
 * Resolve a configured Charm Hyper base URL onto the gateway's `/v1` surface.
 *
 * Delegates to {@link normalizeV1GatewayBaseUrl} with
 * {@link CHARM_HYPER_API_BASE_URL} as the canonical default.
 */
export function normalizeCharmHyperBaseUrl(baseUrl?: string): string {
	return normalizeV1GatewayBaseUrl(baseUrl, CHARM_HYPER_API_BASE_URL);
}
