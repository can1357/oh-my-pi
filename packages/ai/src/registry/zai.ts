import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://z.ai/manage-apikey/apikey-list";
const API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const VALIDATION_MODEL = "glm-5.2";

export const loginZai = createApiKeyLogin({
	providerLabel: "Z.AI",
	authUrl: AUTH_URL,
	instructions: "Copy your API key from the dashboard",
	promptMessage: "Paste your Z.AI API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "Z.AI",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const zaiProvider = {
	id: "zai",
	name: "Z.AI (GLM Coding Plan)",
	login: (cb: OAuthLoginCallbacks) => loginZai(cb),
} as const satisfies ProviderDefinition;
