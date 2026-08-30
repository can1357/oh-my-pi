import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginDigitalOcean = createApiKeyLogin({
	providerLabel: "DigitalOcean Serverless Inference",
	authUrl: "https://cloud.digitalocean.com/model-studio/manage-keys",
	instructions: "Create a model access key in the DigitalOcean Control Panel under INFERENCE → Manage",
	promptMessage: "Paste your DigitalOcean model access key",
	placeholder: "doo_...",
	validation: {
		kind: "models-endpoint",
		provider: "DigitalOcean Serverless Inference",
		modelsUrl: "https://inference.do-ai.run/v1/models",
	},
});

export const digitalOceanProvider = {
	id: "digitalocean",
	name: "DigitalOcean Serverless Inference",
	login: (cb: OAuthLoginCallbacks) => loginDigitalOcean(cb),
} as const satisfies ProviderDefinition;
