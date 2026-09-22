/**
 * SingularityAPI gateway endpoint, shared so a host migration — or a
 * self-hosted proxy override — touches a single module.
 */
export const SINGULARITYAPI_API_BASE_URL = "https://api.singularityapi.dev/v1";

/**
 * Resolve a configured SingularityAPI base URL onto the gateway's `/v1`
 * surface.
 *
 * Every consumer must agree on this, because they key different things off the
 * result: discovery and inference target it, and the model-cache namespace is
 * hashed from it. `ModelRegistry` hashes the raw configured value while
 * `singularityApiModelManagerOptions` hashes a `/v1`-suffixed one, so a
 * disagreement would split the namespace discovery writes from the one the
 * registry reads and the authoritative roster would never come back.
 *
 * A blank or whitespace-only value therefore means "not configured" and
 * resolves to the canonical host; anything else keeps its host and gains the
 * `/v1` segment if it omits one.
 */
export function normalizeSingularityApiBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return SINGULARITYAPI_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
