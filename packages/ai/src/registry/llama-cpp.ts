import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID = "llama.cpp";
const AUTH_URL = "https://github.com/ggml-org/llama.cpp#quick-start";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_LOCAL_TOKEN = "llama-cpp-local";

export async function loginLlamaCpp(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(PROVIDER_ID);
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Paste your llama.cpp API key if your server requires auth. Leave empty for local no-auth mode (default base URL: ${DEFAULT_LOCAL_BASE_URL}; set LLAMA_CPP_BASE_URL to customize).`,
	});
	const apiKey = await options.onPrompt({
		message: "Paste your llama.cpp API key (optional for local no-auth)",
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}

export const llamaCppProvider = {
	id: PROVIDER_ID,
	name: "llama.cpp (Local OpenAI-compatible)",
	envKeys: "LLAMA_CPP_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginLlamaCpp(cb),
} as const satisfies ProviderDefinition;
