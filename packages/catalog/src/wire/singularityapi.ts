/**
 * SingularityAPI gateways, shared so a host migration — or a self-hosted
 * proxy override — touches a single module.
 *
 * SingularityAPI ships two unrelated products behind one brand: the
 * pay-as-you-go universal gateway (`singularityapi-dev`) and the
 * slot-reserved DeepSeek lanes (`singularityapi-tech`). They accept disjoint
 * keys, so each provider resolves its own canonical endpoint from here.
 */
export const SINGULARITYAPI_DEV_API_BASE_URL = "https://api.singularityapi.dev/v1";
export const SINGULARITYAPI_TECH_API_BASE_URL = "https://api.singularityapi.tech/v1";

/**
 * Resolve a configured SingularityAPI base URL onto its gateway's `/v1`
 * surface.
 *
 * Every consumer must agree on this, because they key different things off the
 * result: discovery and inference target it, and the model-cache namespace is
 * hashed from it. `ModelRegistry` hashes the raw configured value while the
 * model-manager options hash a `/v1`-suffixed one, so a disagreement would
 * split the namespace discovery writes from the one the registry reads and the
 * authoritative roster would never come back.
 *
 * `canonical` names the product the caller belongs to: a blank or
 * whitespace-only value means "not configured" and resolves to that canonical
 * host, while anything else keeps its host and gains the `/v1` segment if it
 * omits one. Passing the wrong product's canonical URL would silently point a
 * provider at the other gateway, so there is no default.
 */
export function normalizeSingularityApiBaseUrl(baseUrl: string | undefined, canonical: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return canonical;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
