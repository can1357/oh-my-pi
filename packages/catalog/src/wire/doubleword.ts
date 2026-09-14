/**
 * Doubleword inference endpoint, shared so a host migration — or a self-hosted
 * proxy override — touches a single module.
 */
export const DOUBLEWORD_API_BASE_URL = "https://api.doubleword.ai/v1";

/**
 * Resolve a configured Doubleword base URL onto the gateway's `/v1` surface.
 *
 * Every consumer must agree on this, because they key different things off the
 * result: inference and discovery target it, and the model cache namespace is
 * hashed from it. A blank or whitespace-only value therefore means "not
 * configured" and resolves to the canonical host; anything else keeps its host
 * and gains the `/v1` segment if it omits one.
 */
export function normalizeDoublewordBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return DOUBLEWORD_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
