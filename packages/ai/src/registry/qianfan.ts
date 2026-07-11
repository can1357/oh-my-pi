import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://console.bce.baidu.com/qianfan/ais/console/apiKey";
const API_BASE_URL = "https://qianfan.baidubce.com/v2";
const VALIDATION_MODEL = "deepseek-v3.2";

export const loginQianfan = createApiKeyLogin({
	providerLabel: "Qianfan",
	authUrl: AUTH_URL,
	instructions: "Copy your Qianfan API key from the console",
	promptMessage: "Paste your Qianfan API key",
	placeholder: "bce-v3/ALTAK-...",
	validation: {
		kind: "chat-completions",
		provider: "qianfan",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const qianfanProvider = {
	id: "qianfan",
	name: "Qianfan",
	login: (cb: OAuthLoginCallbacks) => loginQianfan(cb),
} as const satisfies ProviderDefinition;
