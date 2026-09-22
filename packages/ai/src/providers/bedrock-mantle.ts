import { NO_AUTH_SENTINEL } from "../auth-retry";
import type { AwsBedrockProviderOptions } from "../registry/aws";
import type { FetchImpl, Model } from "../types";
import { resolveAwsRegion } from "../utils/aws-profile";
import { createAwsAuthenticatedFetch, resolveAwsAuthenticatedBearerToken } from "./aws-authenticated-fetch";
import type { OpenAIResponsesOptions } from "./openai-responses";

const BEDROCK_MANTLE_SERVICE = "bedrock-mantle";

export type BedrockMantleProviderOptions = AwsBedrockProviderOptions;

export interface BedrockMantleOptions extends OpenAIResponsesOptions {
	providerOptions?: BedrockMantleProviderOptions;
}

export function createBedrockMantleAuthenticatedFetch(options: BedrockMantleOptions = {}): FetchImpl {
	return createAwsAuthenticatedFetch(BEDROCK_MANTLE_SERVICE, options);
}

export interface PreparedBedrockMantleRequest {
	model: Model<"openai-responses">;
	options: OpenAIResponsesOptions;
}

export function prepareBedrockMantleRequest(
	model: Model<"openai-responses">,
	options: BedrockMantleOptions,
): PreparedBedrockMantleRequest {
	const region = resolveAwsRegion(options.providerOptions?.region, options.providerOptions?.profile);
	const resolvedModel = { ...model, baseUrl: model.baseUrl.replaceAll("{region}", encodeURIComponent(region)) };
	const bearerToken = resolveAwsAuthenticatedBearerToken(options);
	if (bearerToken) {
		return { model: resolvedModel, options: { ...options, apiKey: bearerToken } };
	}
	return {
		model: resolvedModel,
		options: {
			...options,
			apiKey: NO_AUTH_SENTINEL,
			fetch: createBedrockMantleAuthenticatedFetch(options),
		},
	};
}
