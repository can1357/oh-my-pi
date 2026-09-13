/**
 * AI/ML API base shared by inference and roster discovery. One constant so a
 * host migration touches a single module.
 */
export const AIMLAPI_API_BASE_URL = "https://api.aimlapi.com/v1";

/**
 * Origin the attribution headers below are scoped to.
 *
 * Both halves matter. The host keeps the partner id from travelling to somebody
 * else's gateway when a user repoints the provider's base URL — the id names a
 * revenue-attribution row, so sending it elsewhere hands a third party our
 * client identity. The scheme keeps it, and the Authorization bearer beside it,
 * off a plaintext connection: a name resolving to `http://api.aimlapi.com:1234`
 * inside a container's DNS would otherwise be handed both.
 */
const AIMLAPI_ORIGIN = "https://api.aimlapi.com";

/**
 * Client-identity headers for AI/ML API. The gateway reads them to attribute
 * traffic to the integration it came from; a request without them is served
 * identically, so nothing surfaces at runtime when they are missing, and
 * nothing surfaces when the partner id is wrong either — an unknown id is
 * accepted and silently unattributed.
 *
 * Returns an empty set unless the request is bound for our own origin, so a
 * user who points this provider at a different host sends no client identity at
 * all.
 */
export function aimlapiClientHeaders(baseUrl?: string): Record<string, string> {
	if (!isAimlapiOrigin(baseUrl)) return {};
	return {
		"HTTP-Referer": "https://github.com/can1357/oh-my-pi",
		"X-Title": "oh-my-pi",
		"X-AIMLAPI-Source": "agent/oh-my-pi",
		"X-AIMLAPI-Partner-ID": "part_esrFuB5coroCvy4ri4dDqbCX",
	};
}

/** True only for our own origin; a suffix look-alike is rejected because the comparison is on the parsed origin. */
export function isAimlapiOrigin(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).origin === AIMLAPI_ORIGIN;
	} catch {
		return false;
	}
}
