import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginVolcengineCodingPlan = createApiKeyLogin({
	providerLabel: "Volcengine Coding Plan",
	authUrl: "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan",
	instructions: "Create or copy your API key from the Volcengine Coding Plan dashboard",
	promptMessage: "Paste your Volcengine Coding Plan API key",
	placeholder: "ark-...",
	validation: {
		kind: "chat-completions",
		provider: "Volcengine Coding Plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
		model: "ark-code-latest",
	},
});

export const volcengineCodingPlanProvider = {
	id: "volcengine-coding-plan",
	name: "Volcengine Coding Plan",
	login: (cb: OAuthLoginCallbacks) => loginVolcengineCodingPlan(cb),
} as const satisfies ProviderDefinition;
