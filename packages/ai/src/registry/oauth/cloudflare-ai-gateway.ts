import { serializeCloudflareAiGatewayCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://developers.cloudflare.com/ai-gateway/configuration/authentication/";

/** Collect the gateway credential used by CLI, setup-wizard, and TUI login callers. */
export async function loginCloudflareAiGateway(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Cloudflare AI Gateway");
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Create an AI Gateway token with Run permission, then copy it here.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Cloudflare AI Gateway token/API key",
		placeholder: "cfut_...",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!apiKey.trim()) throw new AIError.ApiKeyRequiredError();

	const accountId = await options.onPrompt({
		message: "Enter your Cloudflare account ID",
		placeholder: "32-character account ID",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!accountId.trim()) throw new AIError.ConfigurationError("Cloudflare account ID is required");

	const gatewayId = await options.onPrompt({
		message: "Enter your Cloudflare AI Gateway ID",
		placeholder: "default",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!gatewayId.trim()) throw new AIError.ConfigurationError("Cloudflare AI Gateway ID is required");

	return serializeCloudflareAiGatewayCredential(apiKey, accountId, gatewayId);
}
