import { prepareBedrockOpenAIRequest, type BedrockOpenAIOptions } from "../providers/bedrock-openai";
import type { Model } from "../types";
import type { AwsBedrockProviderOptions } from "./aws";
import type { ProviderTransport } from "./build";

interface AwsFetchCarrierOptions {
	signal?: AbortSignal;
}

/** Amazon Bedrock request shaping; auth policy lives in `rules/auth/amazon-bedrock.kdl`. */
export const amazonBedrockTransport: ProviderTransport = {
	prepareRequest: (model, options) => {
		if (model.api !== "openai-completions") return { model, options };
		return prepareBedrockOpenAIRequest(
			model as Model<"openai-completions">,
			options as BedrockOpenAIOptions & AwsFetchCarrierOptions,
		);
	},
	mapSimpleOptions: options => {
		// Converse reads flat options; Chat Completions reads providerOptions.
		const awsOptions = options.providerOptions as AwsBedrockProviderOptions | undefined;
		const mapped: Record<string, unknown> = { providerOptions: options.providerOptions };
		if (awsOptions?.region !== undefined) mapped.region = awsOptions.region;
		if (awsOptions?.profile !== undefined) mapped.profile = awsOptions.profile;
		if (awsOptions?.bearerToken !== undefined) mapped.bearerToken = awsOptions.bearerToken;
		if (options.guardrailIdentifier !== undefined) mapped.guardrailIdentifier = options.guardrailIdentifier;
		if (options.guardrailVersion !== undefined) mapped.guardrailVersion = options.guardrailVersion;
		if (options.guardrailTrace !== undefined) mapped.guardrailTrace = options.guardrailTrace;
		return mapped;
	},
};
