import { $env } from "@oh-my-pi/pi-utils";
import { OTARI_BASE_URL, OTARI_EU_BASE_URL, serializeOtariCredential } from "@oh-my-pi/pi-catalog/wire/otari";
import * as AIError from "../../error";
import { validateApiKeyAgainstModelsEndpoint } from "../api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://app.otari.ai/settings/api-keys";

/**
 * Log in to Otari.
 *
 * Hosted workspaces live in one region (US or EU) and their keys only
 * authenticate there, so login selects the region, or a self-hosted API root,
 * before pasting the key. `OTARI_BASE_URL`, when set, is used as is and skips
 * the prompt. A non-US endpoint is stored in the credential so discovery and
 * inference both target it.
 */
export async function loginOtari(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Otari");
	}

	let baseUrl = $env.OTARI_BASE_URL?.trim().replace(/\/+$/, "");
	if (!baseUrl) {
		const choice = (
			await options.onPrompt({
				message: "Select Otari region: 1=US (default), 2=EU, 3=Custom (self-hosted) — enter 1, 2, or 3",
				placeholder: "1",
			})
		).trim();
		if (options.signal?.aborted) throw new AIError.LoginCancelledError();
		if (choice === "2") {
			baseUrl = OTARI_EU_BASE_URL;
		} else if (choice === "3") {
			const customUrl = await options.onPrompt({
				message: "Enter your Otari API root, including its prefix",
				placeholder: "https://host.example.com/api/v1",
			});
			if (options.signal?.aborted) throw new AIError.LoginCancelledError();
			baseUrl = customUrl.trim().replace(/\/+$/, "");
			if (!baseUrl) throw new AIError.ConfigurationError("Custom URL is required for option 3");
		} else {
			baseUrl = OTARI_BASE_URL;
		}
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Create a workspace API key in Otari (Settings → API keys) and paste it here",
	});

	const apiKeyInput = await options.onPrompt({
		message: "Paste your Otari workspace API key",
		placeholder: "tk_...",
	});
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	const apiKey = apiKeyInput.trim();
	if (!apiKey) throw new AIError.ApiKeyRequiredError();

	// Key-protected (401 without a key and with a bad one), so the probe
	// validates the key against its own region and bills nothing.
	options.onProgress?.("Validating API key...");
	await validateApiKeyAgainstModelsEndpoint({
		provider: "Otari",
		apiKey,
		modelsUrl: `${baseUrl}/models`,
		signal: options.signal,
		fetch: options.fetch,
	});

	return serializeOtariCredential({ token: apiKey, baseUrl });
}
