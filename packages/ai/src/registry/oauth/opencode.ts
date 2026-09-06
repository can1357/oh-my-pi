/**
 * OpenCode login flow, shared by the OpenCode Zen and OpenCode Go providers.
 *
 * Both are subscription services whose API keys are issued from the same
 * OpenCode Zen console at https://opencode.ai/auth — OpenCode Go keys are
 * minted there after subscribing to Go (see https://opencode.ai/docs/go).
 * This is not OAuth; it's a simple paste-the-API-key flow:
 * 1. Open browser to https://opencode.ai/auth
 * 2. User logs in (and subscribes to Go, for OpenCode Go) and copies the key
 * 3. User pastes the API key back into the CLI
 */

import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://opencode.ai/auth";

/** Fallback display name when a provider doesn't pass its own. */
const DEFAULT_PROVIDER_NAME = "OpenCode Zen";

/**
 * Log in to an OpenCode subscription provider.
 *
 * Opens the browser to the OpenCode Zen console, prompts the user to paste
 * their API key, and returns it directly (not OAuthCredentials — this isn't
 * OAuth).
 *
 * @param providerName Display name of the provider being connected
 *   ("OpenCode Zen" or "OpenCode Go"). Used verbatim in the paste prompt so
 *   the CLI reflects the provider the user actually selected instead of always
 *   asking for a Zen key.
 */
export async function loginOpenCode(
	options: OAuthController,
	providerName: string = DEFAULT_PROVIDER_NAME,
): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(providerName);
	}

	// Open browser to auth page. Go keys are minted from the same Zen console
	// after subscribing to Go, so the URL is identical for both providers.
	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Log in to the OpenCode Zen console and copy your ${providerName} API key`,
	});

	// Prompt user to paste their API key
	const apiKey = await options.onPrompt({
		message: `Paste your ${providerName} API key`,
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
