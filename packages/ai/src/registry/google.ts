import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginGoogle = createApiKeyLogin({
	providerLabel: "Google AI Studio",
	authUrl: "https://aistudio.google.com/apikey",
	instructions: "Create or copy your API key from Google AI Studio (Get API key \u2192 Create API key)",
	promptMessage: "Paste your Google AI Studio API key",
	placeholder: "AIza...",
	validation: {
		kind: "google-generative",
		provider: "Google AI Studio",
	},
});

export const googleProvider = {
	id: "google",
	name: "Google AI Studio",
	login: (cb: OAuthLoginCallbacks) => loginGoogle(cb),
} as const satisfies ProviderDefinition;
