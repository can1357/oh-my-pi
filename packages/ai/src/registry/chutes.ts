import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginChutes = createApiKeyLogin({
	providerLabel: "Chutes",
	authUrl: "https://chutes.ai/app/settings/api-keys",
	instructions: "Create or copy your API key from the Chutes dashboard",
	promptMessage: "Paste your Chutes API key",
	placeholder: "cpk_...",
	validation: {
		kind: "models-endpoint",
		provider: "Chutes",
		modelsUrl: "https://llm.chutes.ai/v1/models",
	},
});

export const chutesProvider = {
	id: "chutes",
	name: "Chutes",
	login: (cb: OAuthLoginCallbacks) => loginChutes(cb),
} as const satisfies ProviderDefinition;
