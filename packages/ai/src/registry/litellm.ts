import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://docs.litellm.ai/docs/proxy/deploy";

/**
 * Login to LiteLLM.
 *
 * Opens browser to LiteLLM setup docs, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginLiteLLM = createApiKeyLogin({
	providerLabel: "LiteLLM",
	authUrl: AUTH_URL,
	instructions:
		"Run LiteLLM proxy (default http://localhost:4000/v1; set LITELLM_BASE_URL to customize it), then copy your master key or virtual key",
	promptMessage: "Paste your LiteLLM API key (master key or virtual key)",
	placeholder: "sk-...",
	validation: null,
});

export const litellmProvider = {
	id: "litellm",
	name: "LiteLLM",
	login: (cb: OAuthLoginCallbacks) => loginLiteLLM(cb),
} as const satisfies ProviderDefinition;
