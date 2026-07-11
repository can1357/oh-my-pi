import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://platform.parallel.ai/settings?tab=api-keys";

/**
 * Login to Parallel.
 *
 * Opens browser to the API keys page, prompts the user to paste their API key,
 * and returns the API key directly.
 */
export async function loginParallel(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Parallel");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Parallel API key from the Parallel settings page.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Parallel API key",
		placeholder: "sk_...",
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

export const parallelProvider = {
	id: "parallel",
	name: "Parallel",
	envKeys: "PARALLEL_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginParallel(cb),
} as const satisfies ProviderDefinition;
