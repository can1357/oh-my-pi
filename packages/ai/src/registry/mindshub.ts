import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginMindsHub = createApiKeyLogin({
	providerLabel: "MindsHub",
	authUrl: "https://console.mindshub.ai",
	instructions: "Create or copy your MindsHub API key",
	promptMessage: "Paste your MindsHub API key",
	placeholder: "mdb_...",
	validation: {
		kind: "models-endpoint",
		provider: "MindsHub",
		modelsUrl: "https://api.mindshub.ai/v1/models",
	},
});

export const mindshubProvider = {
	id: "mindshub",
	name: "MindsHub",
	login: (cb: OAuthLoginCallbacks) => loginMindsHub(cb),
} as const satisfies ProviderDefinition;
