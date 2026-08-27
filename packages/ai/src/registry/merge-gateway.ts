import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginMergeGateway = createApiKeyLogin({
	providerLabel: "Merge Gateway",
	authUrl: "https://gateway.merge.dev/api-keys",
	instructions: "Copy your Merge Gateway API key from the Gateway dashboard",
	promptMessage: "Paste your Merge Gateway API key",
	placeholder: "mg_...",
	validation: {
		kind: "models-endpoint",
		provider: "Merge Gateway",
		modelsUrl: "https://api-gateway.merge.dev/v1/models?limit=1",
	},
});

export const mergeGatewayProvider = {
	id: "merge-gateway",
	name: "Merge Gateway",
	login: (cb: OAuthLoginCallbacks) => loginMergeGateway(cb),
} as const satisfies ProviderDefinition;
