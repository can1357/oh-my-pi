import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginVolcengineAgentPlan = createApiKeyLogin({
	providerLabel: "Volcengine Agent Plan",
	authUrl: "https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan",
	instructions: "Create or copy your API key from the Volcengine Agent Plan dashboard",
	promptMessage: "Paste your Volcengine Agent Plan API key",
	placeholder: "ark-...",
	validation: {
		kind: "chat-completions",
		provider: "Volcengine Agent Plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
		model: "ark-code-latest",
	},
});

export const volcengineAgentPlanProvider = {
	id: "volcengine-agent-plan",
	name: "Volcengine Agent Plan",
	login: (cb: OAuthLoginCallbacks) => loginVolcengineAgentPlan(cb),
} as const satisfies ProviderDefinition;
