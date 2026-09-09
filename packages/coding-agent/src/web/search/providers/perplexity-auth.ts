import type { AuthStorage, OAuthAccess } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";

export const PERPLEXITY_CHAT_BASE_URL = "https://api.perplexity.ai";
export const PERPLEXITY_RESPONSES_BASE_URL = "https://api.perplexity.ai/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface ApiConfig {
	type: "api_key";
	apiKey: string;
	provider: "perplexity" | "openrouter";
	chatBaseUrl: string;
	responsesBaseUrl: string;
	modelPrefix: string;
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

/** Detect API-key endpoints to try in priority order (Perplexity direct, then OpenRouter). */
export async function getApiConfigs(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options?: PerplexityAuthOptions,
): Promise<ApiConfig[]> {
	const useResponses = $env.PI_PERPLEXITY_RESPONSES === "1";
	const configs: ApiConfig[] = [];

	// A Perplexity OAuth session and a real API key are mutually exclusive here:
	// when the active credential origin is OAuth, `getApiKey("perplexity")`
	// returns the OAuth session JWT (OAuth wins in AuthStorage.getApiKey), not an
	// api.perplexity.ai key. Emitting it as a direct api-key config makes the
	// search loop send the session token as a Bearer to the direct API endpoint,
	// which rejects it with 401 and masks the real (transport) failure — see #5315.
	// Skip the direct config in that case; the OAuth ask-endpoint method covers it.
	if (authStorage.getCredentialOrigin("perplexity")?.kind !== "oauth") {
		const perplexityKey = await authStorage.getApiKey("perplexity", sessionId, options);
		if (perplexityKey) {
			configs.push({
				type: "api_key",
				apiKey: perplexityKey,
				provider: "perplexity",
				chatBaseUrl: PERPLEXITY_CHAT_BASE_URL,
				responsesBaseUrl: PERPLEXITY_RESPONSES_BASE_URL,
				modelPrefix: "",
				useResponses,
			});
		}
	}

	const openrouterKey = await authStorage.getApiKey("openrouter", sessionId, options);
	if (openrouterKey) {
		configs.push({
			type: "api_key",
			apiKey: openrouterKey,
			provider: "openrouter",
			chatBaseUrl: OPENROUTER_BASE_URL,
			responsesBaseUrl: OPENROUTER_BASE_URL,
			modelPrefix: "perplexity/",
			useResponses,
		});
	}

	return configs;
}

/**
 * Decode a Perplexity JWT's `exp` claim, in ms. Returns `undefined` when the
 * token has no `exp` (which is the common case — Perplexity sessions are
 * server-side and effectively non-expiring from the client's POV).
 */
export function jwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000;
	} catch {
		return undefined;
	}
}

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
		const access = await authStorage.getOAuthAccess("perplexity", sessionId, options);
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

	// 3. API key configs (direct, then openrouter)
	const apiConfigs = await getApiConfigs(authStorage, sessionId, options);
	methods.push(...apiConfigs);

	// 4. Fallback to Perplexity free (anonymous)
	if (methods.length === 0) {
		methods.push({ type: "anonymous" });
	}

	return methods;
}
