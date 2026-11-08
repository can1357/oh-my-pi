import type { AuthStorage, OAuthAccess } from "@oh-my-pi/pi-ai";
import { jwtExpiryMs } from "@oh-my-pi/pi-ai/utils/jwt";
import { $env } from "@oh-my-pi/pi-utils";

export const PERPLEXITY_CHAT_BASE_URL = "https://api.perplexity.ai";
export const PERPLEXITY_RESPONSES_BASE_URL = "https://api.perplexity.ai/v1";
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface ApiConfig {
	type: "api_key";
	apiKey: string;
	useResponses: boolean;
}

export type PerplexityAuth =
	| ApiConfig
	| {
			type: "oauth";
			access: OAuthAccess;
	  }
	| {
			type: "cookies";
			cookies: string;
	  }
	| {
			type: "anonymous";
	  };

export interface PerplexityAuthOptions {
	signal?: AbortSignal;
	forceRefresh?: boolean;
}

/**
 * Resolve the direct Perplexity API-key endpoint. OpenRouter keys are never
 * borrowed: OpenRouter-hosted Perplexity runs only through an explicit
 * `openrouter/perplexity/…` selector.
 */
async function getApiConfig(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options?: PerplexityAuthOptions,
): Promise<ApiConfig | undefined> {
	// A Perplexity OAuth session and a real API key are mutually exclusive here:
	// when the active credential origin is OAuth, `getApiKey("perplexity")`
	// returns the OAuth session JWT (OAuth wins in AuthStorage.keys.get), not an
	// api.perplexity.ai key. Emitting it as a direct api-key config makes the
	// search loop send the session token as a Bearer to the direct API endpoint,
	// which rejects it with 401 and masks the real (transport) failure — see #5315.
	// Skip the direct config in that case; the OAuth ask-endpoint method covers it.
	if (authStorage.keys.source("perplexity")?.kind === "oauth") return undefined;
	const apiKey = await authStorage.keys.get("perplexity", sessionId, options);
	return apiKey ? { type: "api_key", apiKey, useResponses: $env.PI_PERPLEXITY_RESPONSES === "1" } : undefined;
}

/**
 * A Perplexity session JWT usually carries no `exp` — the sessions are
 * server-side and effectively non-expiring from the client's point of view —
 * so {@link jwtExpiryMs} returning undefined is the common case here.
 */
export { jwtExpiryMs };

/** Collect all available auth methods to try in priority order */
export async function getAvailableAuthMethods(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options?: PerplexityAuthOptions,
): Promise<PerplexityAuth[]> {
	const methods: PerplexityAuth[] = [];

	// 1. Cookies take precedence over OAuth as noted in comments/docs
	const cookies = $env.PERPLEXITY_COOKIES?.trim();
	if (cookies) {
		methods.push({ type: "cookies", cookies });
	}

	// 2. Perplexity OAuth (session bearer)
	try {
		const access = await authStorage.oauth.access("perplexity", sessionId, options);
		const token = access?.accessToken;
		if (access && token) {
			const jwtExpiry = jwtExpiryMs(token);
			if (jwtExpiry === undefined || jwtExpiry > Date.now() + OAUTH_EXPIRY_BUFFER_MS) {
				methods.push({ type: "oauth", access });
			}
		}
	} catch {
		// ignored
	}

	// 3. Direct API key
	const apiConfig = await getApiConfig(authStorage, sessionId, options);
	if (apiConfig) methods.push(apiConfig);

	// 4. Fallback to Perplexity free (anonymous)
	if (methods.length === 0) {
		methods.push({ type: "anonymous" });
	}

	return methods;
}
