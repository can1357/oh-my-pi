import { CLINEPASS_API_BASE_URL, clinePassClientHeaders } from "@oh-my-pi/pi-catalog/wire/cline-pass";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginClinePass = createApiKeyLogin({
	providerLabel: "ClinePass",
	authUrl: "https://app.cline.bot/dashboard/account",
	instructions: "Create an API key in the Cline dashboard under Settings → API Keys",
	promptMessage: "Paste your Cline API key",
	placeholder: "sk_...",
	// Validate against the account identity route, not a probe completion: login
	// must not couple to any roster model (roster churn can retire the probe's
	// target) and must not consume subscription quota on a ping.
	validation: {
		kind: "models-endpoint",
		provider: "ClinePass",
		modelsUrl: `${CLINEPASS_API_BASE_URL}/users/me`,
		headers: clinePassClientHeaders,
	},
});

export const clinePassProvider = {
	id: "cline-pass",
	name: "ClinePass",
	login: (callbacks: OAuthLoginCallbacks) => loginClinePass(callbacks),
} as const satisfies ProviderDefinition;
