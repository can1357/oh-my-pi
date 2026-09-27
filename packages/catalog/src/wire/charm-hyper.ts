/**
 * Charm Hyper gateway endpoint, shared so a host migration — or a self-hosted
 * proxy override — touches a single module.
 */
export const CHARM_HYPER_API_BASE_URL = "https://hyper.charm.land/v1";

/**
 * Resolve a configured Charm Hyper base URL onto the gateway's `/v1` surface.
 *
 * Every consumer must agree on this, because they key different things off the
 * result: inference and discovery target it, `/usage` sends a bearer token to
 * it, and the model cache namespace is hashed from it. Three separate copies
 * previously disagreed for a blank value — the model manager treated it as
 * absent and used the canonical host, while the others produced a bare `/v1` —
 * so a whitespace-only override silently split inference, balance checks and
 * caching across different endpoints.
 *
 * A blank or whitespace-only value therefore means "not configured" and
 * resolves to the canonical host; anything else keeps its host and gains the
 * `/v1` segment if it omits one.
 */
export function normalizeCharmHyperBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return CHARM_HYPER_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
