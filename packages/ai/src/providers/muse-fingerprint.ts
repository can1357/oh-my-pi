/**
 * Muse inference-fingerprint constants, kept in a leaf module so the generic
 * OpenAI request setup stays free of inline client strings.
 *
 * The captured Muse User-Agent enables Contributor `max` in live tests
 * against the direct Meta Model API. That is observed wire behavior, not a
 * claim that no other header is accepted.
 */

const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";

/** User-Agent captured from the Muse CLI inference entrypoint. */
export const MUSE_USER_AGENT =
	"muse-build/1.3.0 (non-interactive; linux-x86_64; build ac7280f2aca67769d1455a8847bb502b617d50f6)";

/**
 * True for the first-party Meta Model API endpoint. Exact match (trailing
 * slashes ignored); custom base URLs never receive the Muse fingerprint.
 */
export function isDirectMetaModelEndpoint(baseUrl: string | undefined): boolean {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	return normalized === META_MODEL_API_BASE_URL;
}
