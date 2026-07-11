import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://docs.litellm.ai/docs/proxy/deploy";

/**
 * Login to LiteLLM.
 *
 * Opens browser to LiteLLM setup docs, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginLiteLLM(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("LiteLLM");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions:
			"Run LiteLLM proxy (default http://localhost:4000/v1; set LITELLM_BASE_URL to customize it), then copy your master key or virtual key",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your LiteLLM API key (master key or virtual key)",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	return trimmed;
}

export const litellmProvider = {
	id: "litellm",
	name: "LiteLLM",
	login: (cb: OAuthLoginCallbacks) => loginLiteLLM(cb),
} as const satisfies ProviderDefinition;
