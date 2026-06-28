import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID = "lm-studio";
export const DEFAULT_LOCAL_TOKEN = "lm-studio-local";

export async function loginLmStudio(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(PROVIDER_ID);
	}

	const apiKey = await options.onPrompt({
		message: "Optional: Paste LM Studio API key (to customize endpoint URL, set LM_STUDIO_BASE_URL env var)",
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}

export const lmStudioProvider = {
	id: "lm-studio",
	name: "LM Studio (Local OpenAI-compatible)",
	login: (cb: OAuthLoginCallbacks) => loginLmStudio(cb),
} as const satisfies ProviderDefinition;
