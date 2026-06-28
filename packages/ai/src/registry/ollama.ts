import * as AIError from "../error";
import type { OAuthController } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const OLLAMA_DOCS_URL = "https://github.com/ollama/ollama/blob/main/docs/api.md";

/**
 * Login to Ollama.
 *
 * Returns a trimmed API key/token string. Empty string means local no-auth mode.
 */
export async function loginOllama(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	if (!options.onPrompt) {
		return "";
	}

	options.onAuth?.({
		url: OLLAMA_DOCS_URL,
		instructions:
			"Optional: paste an Ollama API key/token for authenticated hosts. Leave empty for local no-auth mode.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Ollama API key/token (optional)",
		placeholder: "ollama-local",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	return apiKey.trim();
}

export const ollamaProvider = {
	id: "ollama",
	name: "Ollama (Local OpenAI-compatible)",
	login: loginOllama,
} as const satisfies ProviderDefinition;
