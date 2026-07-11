import * as AIError from "../error";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys";

export async function loginVercelAiGateway(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Vercel AI Gateway");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Vercel AI Gateway API key from the Vercel dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Vercel AI Gateway API key",
		placeholder: "vck_...",
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

export const vercelAiGatewayProvider = {
	id: "vercel-ai-gateway",
	name: "Vercel AI Gateway",
	login: (cb: OAuthLoginCallbacks) => loginVercelAiGateway(cb),
} as const satisfies ProviderDefinition;
