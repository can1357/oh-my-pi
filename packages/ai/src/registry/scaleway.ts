import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginScaleway = createApiKeyLogin({
	providerLabel: "Scaleway Generative APIs",
	authUrl: "https://console.scaleway.com/iam/api-keys",
	instructions: "Create or copy your Scaleway secret key",
	promptMessage: "Paste your Scaleway secret key",
	placeholder: "scw-...",
	validation: {
		kind: "chat-completions",
		provider: "Scaleway Generative APIs",
		baseUrl: "https://api.scaleway.ai/v1",
		model: "glm-5.2",
	},
});

export const scalewayProvider = {
	id: "scaleway",
	name: "Scaleway Generative APIs",
	login: (cb: OAuthLoginCallbacks) => loginScaleway(cb),
} as const satisfies ProviderDefinition;
