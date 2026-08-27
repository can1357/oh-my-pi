import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * OpenRouter login: Sign in with OpenRouter (OAuth PKCE) that mints a durable
 * `sk-or-…` API key, with the manual-input race accepting a pasted existing
 * key (validated via `/api/v1/auth/key`). Either path resolves to a plain API
 * key string, stored as an `api_key` credential.
 */
export const openrouterProvider = {
	id: "openrouter",
	name: "OpenRouter",
	// Lazy import: keep the OAuth flow module out of the eager registry graph.
	// Both browser sign-in and key paste yield creds.access = the durable key.
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginOpenRouterOAuth } = await import("./oauth/openrouter");
		const credentials = await loginOpenRouterOAuth(cb);
		return credentials.access;
	},
	// Loopback callback server on this port, plus the manual paste fallback
	// (PASTE_CODE_LOGIN_PROVIDERS) for redirect URLs, codes, and raw API keys.
	callbackPort: 54549,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
