import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://kagi.com/settings/api";

/**
 * Login to Kagi.
 *
 * Opens browser to API settings and prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginKagi(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Kagi");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions:
			"Copy your Kagi Search API key from Kagi API settings. Search API access is beta-only; if unavailable, email support@kagi.com.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Kagi API key",
		placeholder: "KG_...",
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

export const kagiProvider = {
	id: "kagi",
	name: "Kagi",
	envKeys: "KAGI_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginKagi(cb),
} as const satisfies ProviderDefinition;
