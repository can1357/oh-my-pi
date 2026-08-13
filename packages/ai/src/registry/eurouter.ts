import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginEURouter = createApiKeyLogin({
	providerLabel: "EUrouter",
	authUrl: "https://www.eurouter.ai/sign-up",
	instructions: "Create or copy your EUrouter API key",
	promptMessage: "Paste your EUrouter API key",
	placeholder: "eur_...",
	validation: {
		kind: "chat-completions",
		provider: "EUrouter",
		baseUrl: "https://api.eurouter.ai/api/v1",
		model: "mistral-large-3",
	},
});

export const eurouterProvider = {
	id: "eurouter",
	name: "EUrouter",
	login: (cb: OAuthLoginCallbacks) => loginEURouter(cb),
} as const satisfies ProviderDefinition;
