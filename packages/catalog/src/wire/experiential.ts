/**
 * Experiential Labs hosted gateway, shared so a host migration — or a
 * self-hosted gateway override — touches a single module. Configured base
 * URLs resolve through `normalizeV1BaseUrl` with this as the canonical host.
 */
export const EXPERIENTIAL_API_BASE_URL = "https://api.experientiallabs.ai/v1";
