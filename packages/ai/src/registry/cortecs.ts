import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginCortecs = createApiKeyLogin({
	providerLabel: "Cortecs",
	authUrl: "https://cortecs.ai",
	instructions: "Create or copy your Cortecs API key",
	promptMessage: "Paste your Cortecs API key",
	placeholder: "cortecs-...",
	validation: {
		kind: "chat-completions",
		provider: "Cortecs",
		baseUrl: "https://api.cortecs.ai/v1",
		model: "gpt-oss-120b",
	},
});

export const cortecsProvider = {
	id: "cortecs",
	name: "Cortecs",
	login: (cb: OAuthLoginCallbacks) => loginCortecs(cb),
} as const satisfies ProviderDefinition;
