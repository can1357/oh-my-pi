import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks, OAuthProvider } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID: OAuthProvider = "vllm";
const AUTH_URL = "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_LOCAL_TOKEN = "vllm-local";

export async function loginVllm(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(PROVIDER_ID);
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Paste your vLLM API key if your server requires auth. Leave empty for local no-auth mode (default base URL: ${DEFAULT_LOCAL_BASE_URL}).`,
	});
	const apiKey = await options.onPrompt({
		message: "Paste your vLLM API key (optional for local no-auth)",
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}

export const vllmProvider = {
	id: "vllm",
	name: "vLLM (Local OpenAI-compatible)",
	login: (cb: OAuthLoginCallbacks) => loginVllm(cb),
} as const satisfies ProviderDefinition;
