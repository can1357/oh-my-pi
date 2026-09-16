/**
 * Captured Muse User-Agent, kept in a leaf module so the generic OpenAI
 * request setup stays free of inline client strings.
 *
 * Sending it enables Contributor `max` in live tests against the direct Meta
 * Model API. That is observed wire behavior, not a claim that no other
 * header is accepted. Policy (which providers want it) lives in the KDL
 * `muse-fingerprint` axis; endpoint matching lives in
 * `@oh-my-pi/pi-catalog/hosts`.
 */

/** User-Agent captured from the Muse CLI inference entrypoint. */
export const MUSE_USER_AGENT =
	"muse-build/1.3.0 (non-interactive; linux-x86_64; build ac7280f2aca67769d1455a8847bb502b617d50f6)";
