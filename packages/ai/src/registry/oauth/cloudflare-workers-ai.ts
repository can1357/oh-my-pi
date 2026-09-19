import { serializeCloudflareWorkersAiCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare-workers-ai";
import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://developers.cloudflare.com/workers-ai/get-started/rest-api/";

export async function loginCloudflareWorkersAi(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Cloudflare Workers AI");
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Create a Workers AI API token (Workers AI: Read + Edit), then copy it and your account ID here.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Cloudflare Workers AI API token",
		placeholder: "Workers AI API token",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!apiKey.trim()) throw new AIError.ApiKeyRequiredError();

	const accountId = await options.onPrompt({
		message: "Enter your Cloudflare account ID",
		placeholder: "32-character account ID",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!accountId.trim()) throw new AIError.ConfigurationError("Cloudflare account ID is required");

	return serializeCloudflareWorkersAiCredential(apiKey, accountId);
}
