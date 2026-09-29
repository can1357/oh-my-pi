import { $env } from "@oh-my-pi/pi-utils";
import { parseXAIAccessTokenPayload } from "../registry/oauth/xai-oauth";

/** Bundled xAI API endpoint for the `xai` and `xai-oauth` providers. */
export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";

/**
 * Resolve the base URL for an xAI request (`xai` / `xai-oauth` chat, image
 * generation, web search, and HTTP tools).
 *
 * `XAI_BASE_URL` redirects traffic that targets the bundled default endpoint
 * (or has no base URL); trailing slashes on the override are stripped. A
 * custom `baseUrl` (models.yml, provider config) always wins.
 *
 * The override never receives official xAI OAuth credentials: an `xai-oauth`
 * request whose bearer is an xAI OAuth access token (a JWT, whether stored,
 * from `XAI_OAUTH_TOKEN`, or unknown because no bearer was supplied) stays on
 * the bundled endpoint. API keys, including command-backed ones, follow the
 * override.
 */
export function resolveXaiBaseUrl(
	provider: string,
	baseUrl: string | undefined,
	bearer: string | undefined,
): string | undefined {
	if (baseUrl && baseUrl.replace(/\/+$/, "") !== XAI_DEFAULT_BASE_URL) return baseUrl;
	if (provider === "xai-oauth" && (bearer === undefined || parseXAIAccessTokenPayload(bearer) !== null)) {
		return baseUrl;
	}
	const override = $env.XAI_BASE_URL?.trim().replace(/\/+$/, "");
	return override || baseUrl;
}
