import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { apiRouteFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	parseCloudflareAiGatewayCredential,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { $env } from "@oh-my-pi/pi-utils";
import { NO_AUTH_SENTINEL } from "../auth-retry";
import * as AIError from "../error";
import type { Api, Model } from "../types";
import type { ProviderTransport } from "./build";

/**
 * `prepareModel` runs per request, and the OpenAI-compat route rebuilds the
 * model through the full compat engine. The rebuilt route is kept per source
 * object together with a shallow snapshot of the source's fields; any field
 * replaced in place since (headers, compatConfig, id, baseUrl, ...) misses the
 * snapshot check and rebuilds.
 */
const compatRouteModels = new WeakMap<Model<Api>, { source: Model<Api>; prepared: Model<Api> }>();

function sameOwnFields(a: object, b: object): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const key of aKeys) {
		if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
	}
	return true;
}

/** Cloudflare AI Gateway model/request shaping; login lives in `oauth/cloudflare-ai-gateway.ts` + its auth rule. */
export const cloudflareAiGatewayTransport: ProviderTransport = {
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
			const cached = compatRouteModels.get(model);
			if (cached && sameOwnFields(cached.source, model)) return cached.prepared;
			const prepared = buildModel({
				...model,
				api: "openai-completions",
				baseUrl,
				compat: model.compatConfig,
				...(route.requestModelId !== undefined ? { requestModelId: route.requestModelId } : {}),
			});
			compatRouteModels.set(model, { source: { ...model }, prepared });
			return prepared;
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
};
