import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginOpper = createApiKeyLogin({
	providerLabel: "Opper",
	authUrl: "https://platform.opper.ai/",
	instructions: "Create or copy your Opper API key",
	promptMessage: "Paste your Opper API key",
	placeholder: "opper-...",
	validation: {
		kind: "chat-completions",
		provider: "Opper",
		baseUrl: "https://api.opper.ai/v3/compat",
		model: "mistral/devstral-2512",
	},
});

export const opperProvider = {
	id: "opper",
	name: "Opper",
	login: (cb: OAuthLoginCallbacks) => loginOpper(cb),
} as const satisfies ProviderDefinition;
