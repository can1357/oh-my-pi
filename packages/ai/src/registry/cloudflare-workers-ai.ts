import {
	CLOUDFLARE_WORKERS_AI_BASE_URL,
	parseCloudflareWorkersAiCredential,
	resolveCloudflareWorkersAiBaseUrl,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-workers-ai";
import { $env, $pickenv } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { ProviderTransport } from "./build";

interface ResolvedWorkersAiCredential {
	token: string;
	accountId?: string;
}

function resolveWorkersAiCredential(apiKey: string | undefined): ResolvedWorkersAiCredential | null {
	const credential = parseCloudflareWorkersAiCredential(
		apiKey || $pickenv("CLOUDFLARE_WORKERS_AI_API_KEY", "CLOUDFLARE_API_TOKEN") || "",
	);
	if (!credential) return null;
	const accountId = (credential.accountId ?? $env.CLOUDFLARE_ACCOUNT_ID)?.trim();
	return { token: credential.token, ...(accountId ? { accountId } : {}) };
}

/**
 * Unwraps the stored credential and substitutes the account into the base URL.
 * `x-session-affinity` comes from the KDL `prompt-cache-session-header` axis, not from here.
 */
export const cloudflareWorkersAiTransport: ProviderTransport = {
	prepareRequest: (model, options) => {
		const credential = resolveWorkersAiCredential(options.apiKey);
		if (!credential) return { model, options };
		let baseUrl = model.baseUrl;
		if (baseUrl.includes("<account>")) {
			if (!credential.accountId) throw new AIError.ConfigurationError("Cloudflare account ID is required");
			baseUrl = resolveCloudflareWorkersAiBaseUrl(baseUrl, credential.accountId);
		}
		return {
			model: baseUrl === model.baseUrl ? model : { ...model, baseUrl },
			options: { ...options, apiKey: credential.token },
		};
	},
	prepareModelDiscovery: config => {
		const credential = resolveWorkersAiCredential(config.apiKey);
		if (!credential?.accountId) return { ...config, apiKey: undefined, authenticated: false };
		return {
			...config,
			apiKey: credential.token,
			baseUrl: resolveCloudflareWorkersAiBaseUrl(
				config.baseUrl ?? CLOUDFLARE_WORKERS_AI_BASE_URL,
				credential.accountId,
			),
			authenticated: true,
		};
	},
};
