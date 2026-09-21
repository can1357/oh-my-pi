import { prepareBedrockOpenAIRequest, type BedrockOpenAIOptions } from "../providers/bedrock-openai";
import type { Model } from "../types";
import type { AwsBedrockProviderOptions } from "./aws";
import type { ProviderTransport } from "./build";

/** Amazon Bedrock request shaping; auth policy lives in `rules/auth/amazon-bedrock.kdl`. */
export const amazonBedrockTransport: ProviderTransport = {
	prepareRequest: (model, options) => {
		// Only the OpenAI-compatible Chat Completions route needs preparation;
		// Converse authenticates inside its own provider stream function.
		if (model.api !== "openai-completions") return { model, options };
		return prepareBedrockOpenAIRequest(model as Model<"openai-completions">, options as BedrockOpenAIOptions);
	},
	mapSimpleOptions: options => {
		const awsOptions = options.providerOptions as AwsBedrockProviderOptions | undefined;
		const mapped: Record<string, unknown> = {
			region: awsOptions?.region,
			profile: awsOptions?.profile,
			bearerToken: awsOptions?.bearerToken,
		};
		// Guardrails must not be silently dropped on the Chat route: model-level
		// fields are enforced by the Chat preparer itself, but per-call settings
		// arrive through SimpleStreamOptions and would otherwise vanish here.
		if (options.guardrailIdentifier !== undefined) mapped.guardrailIdentifier = options.guardrailIdentifier;
		if (options.guardrailVersion !== undefined) mapped.guardrailVersion = options.guardrailVersion;
		if (options.guardrailTrace !== undefined) mapped.guardrailTrace = options.guardrailTrace;
		return mapped;
	},
};
