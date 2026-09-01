import { loginMetaMuse, refreshMetaMuseToken } from "./oauth/meta-muse";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginMeta = createApiKeyLogin({
	providerLabel: "Meta Model API",
	authUrl: "https://developer.meta.com/ai/",
	instructions: "Create or copy your key from the Meta Model API dashboard",
	promptMessage: "Paste your Meta Model API key",
	placeholder: "Model API key",
	validation: {
		kind: "models-endpoint",
		provider: "Meta Model API",
		modelsUrl: "https://api.meta.ai/v1/models",
	},
});

export const metaProvider = {
	id: "meta",
	name: "Meta Model API",
	login: (cb: OAuthLoginCallbacks) => loginMeta(cb),
	refreshToken: (credentials, signal) => refreshMetaMuseToken(credentials, undefined, signal),
	getApiKey: credentials => {
		if (!credentials.apiKey) throw new Error("Muse Code OAuth credential is missing its Model API key");
		return credentials.apiKey;
	},
} as const satisfies ProviderDefinition;

export const museCodeProvider = {
	id: "muse-code",
	name: "Muse Code subscription (Meta account)",
	login: (cb: OAuthLoginCallbacks) => loginMetaMuse(cb),
	storeCredentialsAs: "meta",
	matchesStoredCredential: credentials => Boolean(credentials.apiKey),
} as const satisfies ProviderDefinition;
