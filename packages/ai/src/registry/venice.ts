import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://venice.ai/settings/api";
const API_BASE_URL = "https://api.venice.ai/api/v1";
const VALIDATION_MODEL = "qwen3-4b";

/**
 * Login to Venice.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginVenice = createApiKeyLogin({
	providerLabel: "Venice",
	authUrl: AUTH_URL,
	instructions: "Copy your API key from the Venice dashboard",
	promptMessage: "Paste your Venice API key",
	placeholder: "vapi_...",
	validation: {
		kind: "chat-completions",
		provider: "Venice",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const veniceProvider = {
	id: "venice",
	name: "Venice",
	login: (cb: OAuthLoginCallbacks) => loginVenice(cb),
} as const satisfies ProviderDefinition;
