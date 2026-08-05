import { VOLCENGINE_AGENT_PLAN_BASE_URL } from "@oh-my-pi/pi-catalog/wire/volcengine-agent-plan";
import type { OpenAIResponsesOptions } from "../providers/openai-responses";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginVolcengineAgentPlanInner = createApiKeyLogin({
	providerLabel: "Volcengine Ark Agent Plan",
	authUrl:
		"https://console.volcengine.com/ark/region:cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentPlan",
	instructions: "Copy the dedicated Agent Plan API key; regular Ark and Coding Plan keys are not interchangeable",
	promptMessage: "Paste your Volcengine Agent Plan API key",
	placeholder: "Enter Agent Plan API key",
	validation: {
		kind: "responses",
		provider: "Volcengine Ark Agent Plan",
		baseUrl: VOLCENGINE_AGENT_PLAN_BASE_URL,
		acceptedErrorCode: "MissingParameter",
	},
});

export const loginVolcengineAgentPlan = loginVolcengineAgentPlanInner;

export const volcengineAgentPlanProvider = {
	id: "volcengine-agent-plan",
	name: "Volcengine Ark Agent Plan",
	login: (cb: OAuthLoginCallbacks) => loginVolcengineAgentPlan(cb),
	prepareRequest: (model, options) => {
		if (model.api !== "openai-responses" || model.id !== "minimax-m2.7") {
			return { model, options };
		}
		const responseOptions = options as OpenAIResponsesOptions;
		const include = responseOptions.include?.filter(item => item !== "reasoning.encrypted_content");
		return {
			model,
			options: {
				...responseOptions,
				include: include?.length ? include : undefined,
				omitReasoningEffort: true,
				includeEncryptedReasoning: false,
				extraBody: {
					...responseOptions.extraBody,
					thinking: {
						type:
							responseOptions.reasoning !== undefined && !responseOptions.disableReasoning
								? "enabled"
								: "disabled",
					},
				},
			},
		};
	},
} as const satisfies ProviderDefinition;
