import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginAkiIo = createApiKeyLogin({
	providerLabel: "AKI.IO",
	authUrl: "https://aki.io/",
	instructions: "Create or copy your AKI.IO API key",
	promptMessage: "Paste your AKI.IO API key",
	placeholder: "aki-...",
	validation: {
		kind: "chat-completions",
		provider: "AKI.IO",
		baseUrl: "https://aki.io/openai/v1",
		model: "kimi-k2.7-code-1100b",
	},
});

export const akiIoProvider = {
	id: "aki-io",
	name: "AKI.IO",
	login: (cb: OAuthLoginCallbacks) => loginAkiIo(cb),
} as const satisfies ProviderDefinition;
