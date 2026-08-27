import { QWEN_CLOUD_OPENAI_BASE_URL } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://home.qwencloud.com/";

export const loginQwenCloud = createApiKeyLogin({
	providerLabel: "Qwen Cloud (Alibaba Model Studio)",
	authUrl: AUTH_URL,
	instructions: "Create an API key in the Alibaba Cloud Model Studio (DashScope) console",
	promptMessage: "Paste your Qwen Cloud API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Qwen Cloud",
		modelsUrl: `${QWEN_CLOUD_OPENAI_BASE_URL}/models`,
	},
});

export const qwenCloudProvider = {
	id: "qwen-cloud",
	name: "Qwen Cloud (Alibaba Model Studio)",
	login: loginQwenCloud,
} as const satisfies ProviderDefinition;
