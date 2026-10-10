/**
 * Experiential Labs hosted gateway, shared so a host migration — or a
 * self-hosted gateway override — touches a single module.
 */
export const EXPERIENTIAL_API_BASE_URL = "https://api.experientiallabs.ai/v1";

/**
 * Resolve a configured Experiential base URL onto the gateway's `/v1` surface.
 *
 * Discovery and the model-cache namespace both key off the result, and
 * `ModelRegistry` hashes the raw configured value while the model-manager
 * options hash the normalized one, so both must pass through here or the
 * authoritative roster would be written to a namespace the registry never
 * reads. A blank value resolves to the hosted gateway; any other value keeps
 * its host and gains `/v1` if it omits one.
 */
export function normalizeExperientialBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return EXPERIENTIAL_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
