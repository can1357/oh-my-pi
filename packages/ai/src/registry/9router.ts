import { $env } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const DEFAULT_9ROUTER_BASE_URL = "http://127.0.0.1:20128/v1";
export const DEFAULT_9ROUTER_DASHBOARD_URL = "http://127.0.0.1:20128/dashboard";

export function get9RouterBaseUrl(): string {
	return $env["9ROUTER_BASE_URL"]?.trim() || $env.NINEROUTER_BASE_URL?.trim() || DEFAULT_9ROUTER_BASE_URL;
}

export function get9RouterDashboardUrl(baseUrl = get9RouterBaseUrl()): string {
	try {
		const parsed = new URL(baseUrl);
		return `${parsed.protocol}//${parsed.host}/dashboard`;
	} catch {
		return DEFAULT_9ROUTER_DASHBOARD_URL;
	}
}

/**
 * Login flow for 9router (local or remote gateway).
 *
 * Prompts user for 9router API key, opens the 9router dashboard, and validates
 * the key against the authed `/api/auth/verify` endpoint (falling back to
 * `${baseUrl}/models` on gateways without the verify route).
 */
export async function login9Router(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("9router");
	}

	const baseUrl = get9RouterBaseUrl().replace(/\/+$/, "");
	const dashboardUrl = get9RouterDashboardUrl(baseUrl);

	options.onAuth?.({
		url: dashboardUrl,
		instructions: `Open 9router dashboard (${dashboardUrl}) to view or generate your API key. (Set 9ROUTER_BASE_URL to customize gateway URL, default: ${DEFAULT_9ROUTER_BASE_URL})`,
	});

	const apiKey = await options.onPrompt({
		message: "Paste your 9router API key",
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
	await validate9RouterApiKey({
		apiKey: trimmed,
		baseUrl,
		signal: options.signal,
		fetch: options.fetch,
	});

	return trimmed;
}

export function get9RouterVerifyUrl(baseUrl = get9RouterBaseUrl()): string {
	try {
		const parsed = new URL(baseUrl.replace(/\/+$/, ""));
		return `${parsed.protocol}//${parsed.host}/api/auth/verify`;
	} catch {
		return "http://127.0.0.1:20128/api/auth/verify";
	}
}

async function validate9RouterApiKey(options: {
	apiKey: string;
	baseUrl: string;
	signal?: AbortSignal;
	fetch?: OAuthController["fetch"];
}): Promise<void> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(get9RouterVerifyUrl(options.baseUrl), {
		method: "GET",
		headers: { Authorization: `Bearer ${options.apiKey}` },
		signal: options.signal,
	});

	if (response.ok) {
		return;
	}

	// Older gateways without the verify route: fall back to the models endpoint,
	// which is open and only proves reachability (not key validity).
	if (response.status === 404 || response.status === 405) {
		await validateApiKeyAgainstModelsEndpoint({
			provider: "9router",
			apiKey: options.apiKey,
			modelsUrl: `${options.baseUrl}/models`,
			signal: options.signal,
			fetch: options.fetch,
		});
		return;
	}

	let details = "";
	try {
		details = (await response.text()).trim();
	} catch {
		// status is enough
	}

	throw new AIError.ApiKeyRequiredError(
		details
			? `9router API key validation failed (${response.status}): ${details}`
			: `9router API key validation failed (${response.status})`,
	);
}

export const nineRouterProvider = {
	id: "9router",
	name: "9router",
	envKeys: () => $env["9ROUTER_API_KEY"]?.trim() || $env.NINEROUTER_API_KEY?.trim() || undefined,
	login: (cb: OAuthLoginCallbacks) => login9Router(cb),
} as const satisfies ProviderDefinition;
