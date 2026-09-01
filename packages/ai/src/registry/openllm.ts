import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://openllm.sh/keys";

/**
 * Login to OpenLLM.
 *
 * Opens browser to the OpenLLM dashboard, prompts user to paste their gateway
 * key. Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginOpenLLM = createApiKeyLogin({
	providerLabel: "OpenLLM",
	authUrl: AUTH_URL,
	instructions:
		"Copy a gateway key from the OpenLLM dashboard (default https://openllm.sh/v1; set OPENLLM_BASE_URL to route through a local daemon instead)",
	promptMessage: "Paste your OpenLLM API key",
	placeholder: "sk-llm-...",
	validation: null,
});

export const openllmProvider = {
	id: "openllm",
	name: "OpenLLM",
	login: (cb: OAuthLoginCallbacks) => loginOpenLLM(cb),
} as const satisfies ProviderDefinition;
