import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID = "llama.cpp";
const AUTH_URL = "https://github.com/ggml-org/llama.cpp#quick-start";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_LOCAL_TOKEN = "llama-cpp-local";

export const loginLlamaCpp = createApiKeyLogin({
	providerLabel: PROVIDER_ID,
	authUrl: AUTH_URL,
	instructions: `Paste your llama.cpp API key if your server requires auth. Leave empty for local no-auth mode (default base URL: ${DEFAULT_LOCAL_BASE_URL}; set LLAMA_CPP_BASE_URL to customize).`,
	promptMessage: "Paste your llama.cpp API key (optional for local no-auth)",
	placeholder: DEFAULT_LOCAL_TOKEN,
	validation: null,
	emptyKeyFallback: DEFAULT_LOCAL_TOKEN,
});

export const llamaCppProvider = {
	id: PROVIDER_ID,
	name: "llama.cpp (Local OpenAI-compatible)",
	envKeys: "LLAMA_CPP_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginLlamaCpp(cb),
} as const satisfies ProviderDefinition;
