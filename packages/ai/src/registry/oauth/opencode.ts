/**
 * OpenCode Zen login flow.
 *
 * OpenCode Zen is a subscription service that provides access to various AI models
 * (GPT-5.x, Claude 4.x, Gemini 3, etc.) through a unified API at opencode.ai/zen.
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to https://opencode.ai/auth
 * 2. User logs in and copies their API key
 * 3. User pastes the API key back into the CLI
 */

import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://opencode.ai/auth";

/**
 * Login to OpenCode Zen.
 *
 * Opens browser to auth page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginOpenCode(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("OpenCode Zen");
	}

	// Open browser to auth page
	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Log in and copy your API key",
	});

	// Prompt user to paste their API key
	const apiKey = await options.onPrompt({
		message: "Paste your OpenCode Zen API key",
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
