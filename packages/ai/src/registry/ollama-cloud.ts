import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const OLLAMA_CLOUD_KEYS_URL = "https://ollama.com/settings/keys";

export async function loginOllamaCloud(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	if (!options.onPrompt) {
		throw new AIError.ConfigurationError("Interactive prompt is required for Ollama Cloud login");
	}
	options.onAuth?.({
		url: OLLAMA_CLOUD_KEYS_URL,
		instructions: "Create an Ollama Cloud API key, then paste it here.",
	});
	const apiKey = await options.onPrompt({
		message: "Paste your Ollama Cloud API key",
		placeholder: "ollama-cloud-api-key",
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError("Ollama Cloud API key is required");
	}
	return trimmed;
}

export const ollamaCloudProvider = {
	id: "ollama-cloud",
	name: "Ollama Cloud",
	login: (cb: OAuthLoginCallbacks) => loginOllamaCloud(cb),
} as const satisfies ProviderDefinition;
