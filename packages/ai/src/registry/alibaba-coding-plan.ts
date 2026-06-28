import * as AIError from "../error";
import * as apiKeyValidation from "./api-key-validation";
import type { OAuthController, OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const DEFAULT_AUTH_URL = "https://modelstudio.console.alibabacloud.com/";
const CHINA_AUTH_URL = "https://dashscope.console.aliyun.com/";
const DEFAULT_API_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
const CHINA_API_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
const VALIDATION_MODEL = "qwen3.5-plus";

export async function loginAlibabaCodingPlan(options: OAuthController): Promise<OAuthCredentials> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Alibaba Coding Plan");
	}

	// Ask which endpoint to use
	const endpointChoice = await options.onPrompt({
		message: "Select Alibaba Coding Plan endpoint: 1=International (default), 2=China, 3=Custom — enter 1, 2, or 3",
		placeholder: "1",
	});

	// Check for abort after endpoint selection (Escape returns "")
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const choice = endpointChoice.trim();
	let baseUrl: string;
	let authUrl: string;
	let instructions: string;
	if (choice === "2") {
		baseUrl = CHINA_API_BASE_URL;
		authUrl = CHINA_AUTH_URL;
		instructions = "Copy your API key from the Alibaba Cloud DashScope console (China mainland)";
	} else if (choice === "3") {
		const customUrl = await options.onPrompt({
			message: "Enter custom base URL",
			placeholder: "https://your-proxy.com/v1",
		});
		const trimmedUrl = customUrl.trim().replace(/\/+$/, "");
		if (!trimmedUrl) {
			throw new AIError.ConfigurationError("Custom URL is required for option 3");
		}
		baseUrl = trimmedUrl;
		authUrl = DEFAULT_AUTH_URL;
		instructions = "Copy your API key from the Alibaba Cloud DashScope console";
	} else {
		baseUrl = DEFAULT_API_BASE_URL;
		authUrl = DEFAULT_AUTH_URL;
		instructions = "Copy your API key from the Alibaba Cloud DashScope console (International)";
	}

	options.onAuth?.({
		url: authUrl,
		instructions,
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Alibaba Coding Plan API key",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.("Validating API key...");
	await apiKeyValidation.validateOpenAICompatibleApiKey({
		provider: "Alibaba Coding Plan",
		apiKey: trimmed,
		baseUrl,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return {
		access: trimmed,
		refresh: trimmed,
		expires: Number.MAX_SAFE_INTEGER,
		enterpriseUrl: baseUrl,
	};
}

export const alibabaCodingPlanProvider = {
	id: "alibaba-coding-plan",
	name: "Alibaba Coding Plan",
	login: (cb: OAuthLoginCallbacks) => loginAlibabaCodingPlan(cb),
	getApiKey: credentials => credentials.access,
} as const satisfies ProviderDefinition;
