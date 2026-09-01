import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginQuerit = createApiKeyLogin({
	providerLabel: "Querit",
	authUrl: "https://www.querit.ai/en/dashboard/api-keys",
	instructions: "Create or copy your API key from the Querit dashboard.",
	promptMessage: "Paste your Querit API key",
	placeholder: "API key",
	validation: null,
});

export const queritProvider = {
	id: "querit",
	name: "Querit",
	envKeys: "QUERIT_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginQuerit(cb),
} as const satisfies ProviderDefinition;
