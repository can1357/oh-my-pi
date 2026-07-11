import * as AIError from "../error";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthController, OAuthLoginCallbacks, OAuthPrompt } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const innerLogin = createApiKeyLogin({
	providerLabel: "DeepSeek",
	authUrl: "https://platform.deepseek.com/api_keys",
	instructions: "Create or copy your API key from the DeepSeek dashboard",
	promptMessage: "Paste your DeepSeek API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "deepseek",
		modelsUrl: "https://api.deepseek.com/v1/models",
	},
});

export function normalizeDeepSeekApiKey(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return trimmed;
	}
	const stripped = trimmed.replace(/^bearer\b\s*/i, "");
	if (!stripped) {
		throw new AIError.ApiKeyRequiredError("DeepSeek API key is empty after stripping Bearer prefix");
	}
	return stripped;
}

export const loginDeepSeek = async (options: OAuthController): Promise<string> => {
	const userOnPrompt = options.onPrompt;
	const wrapped: OAuthController = userOnPrompt
		? {
				...options,
				onPrompt: async (prompt: OAuthPrompt) => normalizeDeepSeekApiKey(await userOnPrompt(prompt)),
			}
		: options;
	return innerLogin(wrapped);
};

export const deepseekProvider = {
	id: "deepseek",
	name: "DeepSeek",
	login: (cb: OAuthLoginCallbacks) => loginDeepSeek(cb),
} as const satisfies ProviderDefinition;
