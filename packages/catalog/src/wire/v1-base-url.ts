/**
 * Resolve a configured OpenAI-compatible gateway base URL onto its `/v1`
 * surface.
 *
 * Every consumer of one provider must agree on this, because they key
 * different things off the result: discovery and inference target it, and the
 * model-cache namespace is hashed from it. `ModelRegistry` hashes the raw
 * configured value while the model-manager options hash a `/v1`-suffixed one,
 * so a disagreement would split the namespace discovery writes from the one
 * the registry reads and an authoritative roster would never come back.
 *
 * `canonical` names the product the caller belongs to: a blank or
 * whitespace-only value means "not configured" and resolves to that canonical
 * host, while anything else keeps its host and gains the `/v1` segment if it
 * omits one. Passing the wrong product's canonical URL would silently point a
 * provider at another gateway, so there is no default.
 */
export function normalizeV1BaseUrl(baseUrl: string | undefined, canonical: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return canonical;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
