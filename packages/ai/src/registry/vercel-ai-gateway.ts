import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys";

export const loginVercelAiGateway = createApiKeyLogin({
	providerLabel: "Vercel AI Gateway",
	authUrl: AUTH_URL,
	instructions: "Copy your Vercel AI Gateway API key from the Vercel dashboard",
	promptMessage: "Paste your Vercel AI Gateway API key",
	placeholder: "vck_...",
	validation: null,
});

export const vercelAiGatewayProvider = {
	id: "vercel-ai-gateway",
	name: "Vercel AI Gateway",
	login: (cb: OAuthLoginCallbacks) => loginVercelAiGateway(cb),
} as const satisfies ProviderDefinition;
