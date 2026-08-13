import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginOvhcloud = createApiKeyLogin({
	providerLabel: "OVHcloud AI Endpoints",
	authUrl: "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/",
	instructions: "Create or copy your OVHcloud AI Endpoints access token",
	promptMessage: "Paste your OVHcloud AI Endpoints access token",
	placeholder: "ovh-...",
	validation: {
		kind: "chat-completions",
		provider: "OVHcloud AI Endpoints",
		baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
		model: "gpt-oss-120b",
	},
});

export const ovhcloudProvider = {
	id: "ovhcloud",
	name: "OVHcloud AI Endpoints",
	login: (cb: OAuthLoginCallbacks) => loginOvhcloud(cb),
} as const satisfies ProviderDefinition;
