/**
 * Modal Endpoints default gateway: the shared per-region host that proxies
 * every workspace's inference endpoints. Dedicated deployments override it
 * via `MODAL_BASE_URL`.
 */
export const MODAL_GATEWAY_BASE_URL = "https://inference.us-west.modal.direct/v1";

/**
 * Normalize a Modal inference base URL: trim, drop trailing slashes, and
 * append `/v1` when the caller gave a bare endpoint origin.
 */
export function normalizeModalBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim().replace(/\/+$/, "");
	if (!value) return MODAL_GATEWAY_BASE_URL;
	return value.endsWith("/v1") ? value : `${value}/v1`;
}
