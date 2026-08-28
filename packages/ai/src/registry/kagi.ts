import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://kagi.com/settings/api";

/**
 * Login to Kagi.
 *
 * Opens browser to API settings and prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginKagi = createApiKeyLogin({
	providerLabel: "Kagi",
	authUrl: AUTH_URL,
	instructions:
		"Copy your Kagi Search API key from Kagi API settings. Search API access is beta-only; if unavailable, email support@kagi.com.",
	promptMessage: "Paste your Kagi API key",
	placeholder: "KG_...",
	validation: null,
});

export const kagiProvider = {
	id: "kagi",
	name: "Kagi",
	envKeys: "KAGI_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginKagi(cb),
} as const satisfies ProviderDefinition;
