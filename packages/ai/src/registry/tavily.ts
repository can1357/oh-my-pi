import * as AIError from "../error";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://app.tavily.com/home";

/**
 * Login to Tavily.
 *
 * Opens browser to API keys page and prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginTavily(options: OAuthLoginCallbacks): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Tavily");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Tavily API key from the API Keys page.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Tavily API key",
		placeholder: "tvly-...",
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

export const tavilyProvider = {
	id: "tavily",
	name: "Tavily",
	envKeys: "TAVILY_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginTavily(cb),
} as const satisfies ProviderDefinition;
