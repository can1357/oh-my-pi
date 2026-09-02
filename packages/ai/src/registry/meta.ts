import * as AIError from "../error";
import metaLoginPrompt from "./meta-login.md" with { type: "text" };
import { loginMetaMuse, refreshMetaMuseToken } from "./oauth/meta-muse";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginMetaApiKey = createApiKeyLogin({
	providerLabel: "Meta Model API",
	authUrl: "https://developer.meta.com/ai/",
	instructions: "Create or copy your key from the Meta Model API dashboard",
	promptMessage: "Paste your Meta Model API key",
	placeholder: "Model API key",
	validation: {
		kind: "models-endpoint",
		provider: "Meta Model API",
		modelsUrl: "https://api.meta.ai/v1/models",
	},
});
export async function loginMeta(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string> {
	const method =
		callbacks.authMethod ??
		(
			await callbacks.onPrompt({
				message: metaLoginPrompt,
				placeholder: "1 or 2",
			})
		).trim();
	if (callbacks.signal?.aborted || method.length === 0) throw new AIError.LoginCancelledError();
	if (method === "muse" || method === "1") return loginMetaMuse(callbacks);
	if (method === "api-key" || method === "2") return loginMetaApiKey(callbacks);
	throw new AIError.ConfigurationError("Choose 1 for Muse Code or 2 for a Model API key");
}

export const metaProvider = {
	id: "meta",
	name: "Meta",
	login: (cb: OAuthLoginCallbacks) => loginMeta(cb),
	refreshToken: (credentials, signal) => refreshMetaMuseToken(credentials, undefined, signal),
	getApiKey: credentials => {
		if (!credentials.apiKey) throw new Error("Muse Code OAuth credential is missing its Model API key");
		return credentials.apiKey;
	},
} as const satisfies ProviderDefinition;
