/** AWS authentication and endpoint setup for Bedrock Chat Completions. */
import { NO_AUTH_SENTINEL } from "../auth-retry";
import { ConfigurationError } from "../error";
import type { AwsBedrockProviderOptions } from "../registry/aws";
import type { Model } from "../types";
import { getHeaderCaseInsensitive } from "../utils";
import { AWS_REGIONAL_BEDROCK_HOST, resolveBedrockRegion } from "../utils/aws-bedrock-region";
import { createAwsAuthenticatedFetch, resolveAwsAuthenticatedBearerToken } from "./aws-authenticated-fetch";
import type { OpenAICompletionsOptions } from "./openai-completions";

const BEDROCK_SERVICE = "bedrock";

// https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html
const GUARDRAIL_IDENTIFIER_HEADER = "X-Amzn-Bedrock-GuardrailIdentifier";
const GUARDRAIL_VERSION_HEADER = "X-Amzn-Bedrock-GuardrailVersion";
const GUARDRAIL_TRACE_HEADER = "X-Amzn-Bedrock-Trace";

const GUARDRAIL_HEADERS: Record<string, true> = {
	[GUARDRAIL_IDENTIFIER_HEADER.toLowerCase()]: true,
	[GUARDRAIL_VERSION_HEADER.toLowerCase()]: true,
	[GUARDRAIL_TRACE_HEADER.toLowerCase()]: true,
};

function dropBedrockGuardrailHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!GUARDRAIL_HEADERS[name.toLowerCase()]) kept[name] = value;
	}
	return kept;
}

/** Options for Bedrock Chat Completions: OpenAI-completions streaming options extended with AWS provider settings and guardrails. */
export interface BedrockOpenAIOptions extends OpenAICompletionsOptions {
	providerOptions?: AwsBedrockProviderOptions;
	/** Guardrail id or ARN. Model-level settings take precedence. */
	guardrailIdentifier?: string;
	/** Defaults to "DRAFT" when a guardrail is configured. */
	guardrailVersion?: string;
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}

interface EffectiveGuardrail {
	guardrailIdentifier?: string;
	guardrailVersion?: string;
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}

/** Structured guardrail settings take precedence over request headers. */
function resolveBedrockGuardrailConfig(
	model: Model<"openai-completions">,
	options: BedrockOpenAIOptions,
): EffectiveGuardrail {
	const modelHeaders = model.headers;
	const optionHeaders = options.headers;
	const advisory = (key: string): string | undefined =>
		getHeaderCaseInsensitive(modelHeaders, key) ?? getHeaderCaseInsensitive(optionHeaders, key);
	return {
		guardrailIdentifier:
			model.guardrailIdentifier ?? options.guardrailIdentifier ?? advisory(GUARDRAIL_IDENTIFIER_HEADER),
		guardrailVersion: model.guardrailVersion ?? options.guardrailVersion ?? advisory(GUARDRAIL_VERSION_HEADER),
		guardrailTrace:
			model.guardrailTrace ??
			options.guardrailTrace ??
			(advisory(GUARDRAIL_TRACE_HEADER)?.toLowerCase() as "enabled" | "disabled" | undefined),
	};
}

function translateBedrockGuardrailHeaders(guardrail: EffectiveGuardrail): Record<string, string> | undefined {
	const { guardrailIdentifier, guardrailVersion, guardrailTrace } = guardrail;
	if (guardrailTrace === "enabled_full") {
		throw new ConfigurationError(
			'guardrailTrace "enabled_full" is Converse-only; the Chat Completions endpoint accepts only "enabled" or "disabled"',
		);
	}
	if (guardrailIdentifier === undefined) {
		if (guardrailVersion !== undefined) {
			throw new ConfigurationError("guardrailVersion requires guardrailIdentifier on Bedrock Chat Completions");
		}
		if (guardrailTrace === undefined) return undefined;
	}
	const headers: Record<string, string> = {};
	if (guardrailIdentifier !== undefined) {
		headers[GUARDRAIL_IDENTIFIER_HEADER] = guardrailIdentifier;
		headers[GUARDRAIL_VERSION_HEADER] = guardrailVersion ?? "DRAFT";
	}
	if (guardrailTrace !== undefined) {
		headers[GUARDRAIL_TRACE_HEADER] = guardrailTrace.toUpperCase();
	}
	return headers;
}

/** Separate the endpoint query from the base URL before the OpenAI API appends its path. */
function resolveBedrockOpenAIUrls(
	baseUrl: string | undefined,
	region: string,
): { builderBaseUrl: string; fetchUrlPrefix: string } {
	let url: URL;
	try {
		url = new URL(
			(baseUrl || "https://bedrock-runtime.{region}.amazonaws.com/openai/v1").replaceAll(
				"{region}",
				encodeURIComponent(region),
			),
		);
	} catch (cause) {
		throw new ConfigurationError("Invalid Bedrock Chat Completions base URL", { cause });
	}
	if (AWS_REGIONAL_BEDROCK_HOST.test(url.host)) {
		url.host = `bedrock-runtime.${region}.amazonaws.com`;
		if (url.pathname === "/") url.pathname = "/openai/v1";
	}
	const builderBaseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
	return {
		builderBaseUrl,
		fetchUrlPrefix: url.search ? `${builderBaseUrl}/chat/completions${url.search}` : builderBaseUrl,
	};
}

/** Fully resolved model and streaming options for a Bedrock Chat Completions request (endpoint, guardrail headers, authenticated fetch). */
export interface PreparedBedrockOpenAIRequest {
	model: Model<"openai-completions">;
	options: OpenAICompletionsOptions;
}

/** Prepare the Bedrock endpoint and authenticate with a bearer token or SigV4. */
export function prepareBedrockOpenAIRequest(
	model: Model<"openai-completions">,
	options: BedrockOpenAIOptions,
): PreparedBedrockOpenAIRequest {
	const providerOptions = options.providerOptions;
	const guardrail = resolveBedrockGuardrailConfig(model, options);
	const region = resolveBedrockRegion(model.id, {
		region: providerOptions?.region,
		profile: providerOptions?.profile,
		guardrailIdentifier: guardrail.guardrailIdentifier,
	});
	const { builderBaseUrl, fetchUrlPrefix } = resolveBedrockOpenAIUrls(model.baseUrl, region);
	const guardrailHeaders = translateBedrockGuardrailHeaders(guardrail);
	const headers: Record<string, string> = {
		...dropBedrockGuardrailHeaders(model.headers as Record<string, string> | undefined),
		...dropBedrockGuardrailHeaders(options.headers as Record<string, string> | undefined),
		...guardrailHeaders,
	};
	const resolvedModel: Model<"openai-completions"> = { ...model, baseUrl: builderBaseUrl, headers };
	const effectiveProviderOptions: AwsBedrockProviderOptions = { ...providerOptions, region };
	const fetchOptions: BedrockOpenAIOptions = {
		...options,
		providerOptions: effectiveProviderOptions,
		headers,
	};
	const bearerToken = resolveAwsAuthenticatedBearerToken(fetchOptions);
	const authenticatedFetch = bearerToken ? options.fetch : createAwsAuthenticatedFetch(BEDROCK_SERVICE, fetchOptions);
	const fetch =
		fetchUrlPrefix === builderBaseUrl
			? authenticatedFetch
			: createChatCompletionsUrlFetch(fetchUrlPrefix, authenticatedFetch);
	return {
		model: resolvedModel,
		options: { ...fetchOptions, apiKey: bearerToken ?? NO_AUTH_SENTINEL, fetch },
	};
}

/** Restore the endpoint query before authentication signs the final URL. */
function createChatCompletionsUrlFetch(fetchUrlPrefix: string, baseFetch?: OpenAICompletionsOptions["fetch"]) {
	const inner = baseFetch ?? (globalThis.fetch as NonNullable<OpenAICompletionsOptions["fetch"]>);
	const urlFetch: typeof inner = (input, init) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		url.search = new URL(fetchUrlPrefix).search;
		return inner(input instanceof Request ? new Request(url.href, input) : url.href, init);
	};
	return Object.assign(urlFetch, inner.preconnect ? { preconnect: inner.preconnect } : {});
}
