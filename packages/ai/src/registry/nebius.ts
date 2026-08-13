import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginNebius = createApiKeyLogin({
	providerLabel: "Nebius Token Factory",
	authUrl: "https://tokenfactory.nebius.com",
	instructions: "Create or copy your Nebius Token Factory API key",
	promptMessage: "Paste your Nebius Token Factory API key",
	placeholder: "nebius-...",
	validation: {
		kind: "models-endpoint",
		provider: "Nebius Token Factory",
		modelsUrl: "https://api.tokenfactory.nebius.com/v1/models",
	},
});

export const nebiusProvider = {
	id: "nebius",
	name: "Nebius Token Factory",
	login: (cb: OAuthLoginCallbacks) => loginNebius(cb),
} as const satisfies ProviderDefinition;
