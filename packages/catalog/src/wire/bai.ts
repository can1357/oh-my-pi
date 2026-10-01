/**
 * B.AI (`api.b.ai`) gateway, shared so a host migration — or a self-hosted
 * proxy override — touches a single module.
 */
export const BAI_API_BASE_URL = "https://api.b.ai/v1";

/**
 * Resolve a configured B.AI base URL onto the gateway's `/v1` surface.
 *
 * Every consumer must agree on this, because they key different things off the
 * result: discovery and inference target it, and the model-cache namespace is
 * hashed from it. `ModelRegistry` hashes the raw configured value while the
 * model-manager options hash a `/v1`-suffixed one, so a disagreement would
 * split the namespace discovery writes from the one the registry reads and the
 * authoritative roster would never come back.
 *
 * A blank or whitespace-only value means "not configured" and resolves to the
 * canonical host; anything else keeps its host and gains the `/v1` segment if
 * it omits one.
 */
export function normalizeBaiBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return BAI_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
