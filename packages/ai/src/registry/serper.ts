import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginSerper = createApiKeyLogin({
	providerLabel: "Serper",
	authUrl: "https://serper.dev/playground",
	instructions: "Copy your API key from the Serper playground.",
	promptMessage: "Paste your Serper API key",
	placeholder: "API key",
	validation: null,
});

export const serperProvider = {
	id: "serper",
	name: "Serper",
	envKeys: "SERPER_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginSerper(cb),
} as const satisfies ProviderDefinition;
