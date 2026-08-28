import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginTogether = createApiKeyLogin({
	providerLabel: "Together",
	authUrl: "https://api.together.xyz/settings/api-keys",
	instructions: "Copy your API key from the Together dashboard",
	promptMessage: "Paste your Together API key",
	placeholder: "sk-...",
	validation: {
		// Validate against the authenticated models listing, not a chat
		// completion: Together rejects models that only exist behind a dedicated
		// endpoint (e.g. `moonshotai/Kimi-K2.5`) with an HTTP 400
		// `model_not_available`, which failed key validation for every valid key
		// (issue #8328). The `/v1/models` listing is model-agnostic.
		kind: "models-endpoint",
		provider: "together",
		modelsUrl: "https://api.together.xyz/v1/models",
	},
});

export const togetherProvider = {
	id: "together",
	name: "Together",
	login: (cb: Parameters<typeof loginTogether>[0]) => loginTogether(cb),
} as const satisfies ProviderDefinition;
