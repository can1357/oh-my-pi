import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** Collect the Workers AI API token and account id used by CLI, setup-wizard, and TUI login callers. */
export async function loginCloudflareWorkersAi(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Cloudflare Workers AI");
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Create an API token with Workers AI Read and Edit permissions, then copy it here.",
	});

	const token = await options.onPrompt({
		message: "Paste your Cloudflare API token",
		placeholder: "Workers AI API token",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!token.trim()) throw new AIError.ApiKeyRequiredError();

	const accountId = await options.onPrompt({
		message: "Enter your Cloudflare account ID",
		placeholder: "32-character account ID",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!accountId.trim()) throw new AIError.ConfigurationError("Cloudflare account ID is required");

	return serializeCloudflareCredential({ token, accountId });
}
