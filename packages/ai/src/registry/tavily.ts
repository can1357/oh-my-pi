import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://app.tavily.com/home";

/**
 * Login to Tavily.
 *
 * Opens browser to API keys page and prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginTavily = createApiKeyLogin({
	providerLabel: "Tavily",
	authUrl: AUTH_URL,
	instructions: "Copy your Tavily API key from the API Keys page.",
	promptMessage: "Paste your Tavily API key",
	placeholder: "tvly-...",
	validation: null,
});

export const tavilyProvider = {
	id: "tavily",
	name: "Tavily",
	envKeys: "TAVILY_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginTavily(cb),
} as const satisfies ProviderDefinition;
