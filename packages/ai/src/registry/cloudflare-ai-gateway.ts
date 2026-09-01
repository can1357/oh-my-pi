import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { apiRouteFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	parseCloudflareAiGatewayCredential,
	serializeCloudflareAiGatewayCredential,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { NO_AUTH_SENTINEL } from "../providers/openai-shared";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

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

export const cloudflareAiGatewayProvider = {
	id: "cloudflare-ai-gateway",
	name: "Cloudflare AI Gateway",
	prepareModel: model => {
		const hasGatewayPlaceholders = model.baseUrl.includes("<account>") || model.baseUrl.includes("<gateway>");
		const route = apiRouteFor("cloudflare-ai-gateway", model.id);
		if (!route) return model;
		if (route.api === "anthropic-messages") {
			const requestModelId = (route.requestModelId ?? model.id).replaceAll(".", "-");
			const baseUrl = hasGatewayPlaceholders ? CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL : model.baseUrl;
			if (
				model.api === "anthropic-messages" &&
				model.baseUrl === baseUrl &&
				model.requestModelId === requestModelId
			) {
				return model;
			}
			return {
				...model,
				api: "anthropic-messages",
				baseUrl,
				requestModelId,
			};
		}
		if (route.api === "openai-completions") {
			const isOpenAIRoute = route.requestModelId !== undefined;
			const baseUrl = hasGatewayPlaceholders
				? isOpenAIRoute
					? CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL
					: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL
				: model.baseUrl;
			if (
				model.api === "openai-completions" &&
				model.baseUrl === baseUrl &&
				model.requestModelId === route.requestModelId
			) {
				return model;
			}
			return buildModel({
				...model,
				api: "openai-completions",
				baseUrl,
				compat: model.compatConfig,
				...(route.requestModelId !== undefined ? { requestModelId: route.requestModelId } : {}),
			});
		}
		return model;
	},
	prepareRequest: (model, options) => {
		const credential = parseCloudflareAiGatewayCredential(options.apiKey ?? $env.CLOUDFLARE_AI_GATEWAY_API_KEY ?? "");
		if (!credential) return { model, options };
		const accountId = credential.accountId ?? $env.CLOUDFLARE_ACCOUNT_ID;
		const gatewayId = credential.gatewayId ?? $env.CLOUDFLARE_GATEWAY_ID;
		let baseUrl = model.baseUrl;
		if (baseUrl.startsWith(CLOUDFLARE_AI_GATEWAY_BASE_URL)) {
			if (!accountId) throw new AIError.ConfigurationError("Cloudflare account ID is required");
			if (!gatewayId) throw new AIError.ConfigurationError("Cloudflare AI Gateway ID is required");
			baseUrl = baseUrl.replace("<account>", accountId).replace("<gateway>", gatewayId);
		}

		const isAnthropic = model.api === "anthropic-messages";
		let headers = model.headers;
		if (!isAnthropic) {
			headers = { ...headers };
			for (const name in headers) {
				const normalized = name.toLowerCase();
				if (normalized === "authorization" || normalized === "x-api-key") delete headers[name];
			}
			headers["cf-aig-authorization"] = `Bearer ${credential.token}`;
		}
		return {
			model: { ...model, baseUrl, headers },
			options: { ...options, apiKey: isAnthropic ? credential.token : NO_AUTH_SENTINEL },
		};
	},
	login: (cb: OAuthLoginCallbacks) => loginCloudflareAiGateway(cb),
} as const satisfies ProviderDefinition;
