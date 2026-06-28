import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginSakana = createApiKeyLogin({
	providerLabel: "Sakana AI",
	authUrl: "https://console.sakana.ai/api-keys",
	instructions: "Copy your API key from the Sakana AI console",
	promptMessage: "Paste your Sakana AI API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Sakana AI",
		modelsUrl: "https://api.sakana.ai/v1/models",
	},
});

export const sakanaProvider = {
	id: "sakana",
	name: "Sakana AI",
	login: (cb: OAuthLoginCallbacks) => loginSakana(cb),
} as const satisfies ProviderDefinition;
