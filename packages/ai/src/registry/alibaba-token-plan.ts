import {
	ALIBABA_TOKEN_PLAN_BASE_URL,
	ALIBABA_TOKEN_PLAN_CN_BASE_URL,
	serializeAlibabaTokenPlanCredential,
} from "@pk-nerdsaver-ai/pi-catalog/wire/alibaba-token-plan";
import * as AIError from "../error";
import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const INTERNATIONAL_AUTH_URL = "https://home.qwencloud.com/billing/subscription/token-plan-individual";
const CHINA_AUTH_URL = "https://www.aliyun.com/benefit/scene/tokenplan";

/**
 * Log in to the QwenCloud Token Plan provider.
 *
 * Token Plan keys (`sk-sp-…`) and base URLs are isolated from Coding Plan and
 * pay-as-you-go. Login selects International (Singapore), China (Beijing), or a
 * custom OpenAI-compatible base URL, validates against that region's `/models`
 * endpoint, and stores a diverging region in the credential for inference and
 * discovery.
 */
export async function loginAlibabaTokenPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("QwenCloud Token Plan");
	}

	const endpointChoice = await options.onPrompt({
		message:
			"Select QwenCloud Token Plan region: 1=International (default), 2=China (Beijing), 3=Custom — enter 1, 2, or 3",
		placeholder: "1",
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const choice = endpointChoice.trim();
	let baseUrl: string;
	let authUrl: string;
	let instructions: string;
	if (choice === "2") {
		baseUrl = ALIBABA_TOKEN_PLAN_CN_BASE_URL;
		authUrl = CHINA_AUTH_URL;
		instructions = "Subscribe to the China (Beijing) 百炼 Token Plan and copy its dedicated API key (sk-sp-...)";
	} else if (choice === "3") {
		const customUrl = await options.onPrompt({
			message: "Enter custom Token Plan base URL",
			placeholder: "https://token-plan.<region>.maas.aliyuncs.com/compatible-mode/v1",
		});
		const trimmedUrl = customUrl.trim().replace(/\/+$/, "");
		if (!trimmedUrl) {
			throw new AIError.ConfigurationError("Custom URL is required for option 3");
		}
		baseUrl = trimmedUrl;
		authUrl = INTERNATIONAL_AUTH_URL;
		instructions = "Copy your Token Plan API key (sk-sp-...) for the custom endpoint";
	} else {
		baseUrl = ALIBABA_TOKEN_PLAN_BASE_URL;
		authUrl = INTERNATIONAL_AUTH_URL;
		instructions =
			"Subscribe to Token Plan Personal/Individual Edition and copy its dedicated API key (sk-sp-...). Keep this page open; the next prompt explains how to enable optional quota reporting.";
	}

	options.onAuth?.({ url: authUrl, instructions });

	const apiKeyInput = await options.onPrompt({
		message: "Paste your QwenCloud Token Plan API key (sk-sp-...)",
		placeholder: "sk-sp-...",
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const apiKey = apiKeyInput.trim();
	if (!apiKey) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.("Validating API key...");
	await validateApiKeyAgainstModelsEndpoint({
		provider: "QwenCloud Token Plan",
		apiKey,
		modelsUrl: `${baseUrl}/models`,
		signal: options.signal,
		fetch: options.fetch,
	});

	const rawCookie = await options.onPrompt({
		message:
			"Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter for api.json, and select the cs-data.qwencloud.com/data/api.json request whose api query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete name=value; ... value here, or press Enter to skip.",
		placeholder: "name=value; name=value; ...",
		allowEmpty: true,
	});
	const cookie = rawCookie
		.trim()
		.replace(/^Cookie:\s*/i, "")
		.trim();
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	if (
		cookie.length > 0 &&
		!cookie.split(";").some(segment => {
			const separator = segment.indexOf("=");
			return separator > 0 && Boolean(segment.slice(0, separator).trim() && segment.slice(separator + 1).trim());
		})
	) {
		throw new AIError.ConfigurationError(
			"Invalid QwenCloud Cookie header. Copy the complete Cookie request header from the cs-data.qwencloud.com usage request, not a single cookie value.",
		);
	}

	// International (default) logins keep their existing bare/cookie credential
	// form; only a diverging region is persisted so it can override the catalog
	// base URL at inference and discovery time.
	const regionUrl = baseUrl === ALIBABA_TOKEN_PLAN_BASE_URL ? undefined : baseUrl;
	return serializeAlibabaTokenPlanCredential(apiKey, cookie, regionUrl);
}

export const alibabaTokenPlanProvider = {
	id: "alibaba-token-plan",
	name: "QwenCloud Token Plan",
	login: (cb: OAuthLoginCallbacks) => loginAlibabaTokenPlan(cb),
} as const satisfies ProviderDefinition;
