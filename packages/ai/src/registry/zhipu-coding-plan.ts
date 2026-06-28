import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://bigmodel.cn/coding-plan/personal/overview";
const API_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const VALIDATION_MODEL = "glm-5.1";

export const loginZhipuCodingPlan = createApiKeyLogin({
	providerLabel: "Zhipu Coding Plan",
	authUrl: AUTH_URL,
	instructions: "Copy your API key from the Coding Plan dashboard",
	promptMessage: "Paste your Zhipu API key",
	placeholder: "<id>.<secret>",
	validation: {
		kind: "chat-completions",
		provider: "Zhipu",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const zhipuCodingPlanProvider = {
	id: "zhipu-coding-plan",
	name: "Zhipu Coding Plan (智谱)",
	login: (cb: OAuthLoginCallbacks) => loginZhipuCodingPlan(cb),
} as const satisfies ProviderDefinition;
