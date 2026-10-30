import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
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
		instructions: __ompTranslate("Create an AI Gateway token with Run permission, then copy it here."),
	});

	const apiKey = await options.onPrompt({
		message: __ompTranslate("Paste your Cloudflare AI Gateway token/API key"),
		placeholder: "cfut_...",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!apiKey.trim()) throw new AIError.ApiKeyRequiredError();

	const accountId = await options.onPrompt({
		message: __ompTranslate("Enter your Cloudflare account ID"),
		placeholder: __ompTranslate("32-character account ID"),
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!accountId.trim()) throw new AIError.ConfigurationError(__ompTranslate("Cloudflare account ID is required"));

	const gatewayId = await options.onPrompt({
		message: __ompTranslate("Enter your Cloudflare AI Gateway ID"),
		placeholder: "default",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!gatewayId.trim()) throw new AIError.ConfigurationError(__ompTranslate("Cloudflare AI Gateway ID is required"));

	return serializeCloudflareCredential({ token: apiKey, accountId, gatewayId });
}
