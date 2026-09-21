/**
 * Request preparation for Amazon Bedrock's OpenAI-compatible Chat Completions
 * API (`bedrock-runtime` `/openai/v1/chat/completions`). Auth is resolved
 * exactly like the Converse/Mantle transports: a configured bearer token wins
 * (providerOptions.bearerToken > apiKey > AWS_BEARER_TOKEN_BEDROCK), otherwise
 * the request is SigV4-signed with the standard AWS credential chain (service
 * `bedrock`). The AWS registry's `<authenticated>` keyless marker is consumed
 * here and never sent as a bearer value.
 */
import { NO_AUTH_SENTINEL } from "../auth-retry";
import { ConfigurationError } from "../error";
import type { AwsBedrockProviderOptions } from "../registry/aws";
import type { Model } from "../types";
import { getHeaderCaseInsensitive } from "../utils";
import { AWS_REGIONAL_BEDROCK_HOST, resolveBedrockRegion } from "../utils/aws-bedrock-region";
import { createAwsAuthenticatedFetch, resolveAwsAuthenticatedBearerToken } from "./aws-authenticated-fetch";
import type { OpenAICompletionsOptions } from "./openai-completions";

/** SigV4 service name for bedrock-runtime requests, including /openai/v1. */
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

/** Headers model/caller header maps must not override; the resolved guardrail pair stays coherent. */
function dropBedrockGuardrailHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!GUARDRAIL_HEADERS[name.toLowerCase()]) kept[name] = value;
	}
	return kept;
}

export interface BedrockOpenAIOptions extends OpenAICompletionsOptions {
	providerOptions?: AwsBedrockProviderOptions;
	/** Explicit per-request Guardrail id or ARN; model-level config wins over it. */
	guardrailIdentifier?: string;
	/** Guardrail version to apply. Defaults to `"DRAFT"` when a guardrail is set. */
	guardrailVersion?: string;
	/** Guardrail trace verbosity. Left unset (Bedrock default) unless provided. */
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}

interface EffectiveGuardrail {
	guardrailIdentifier?: string;
	guardrailVersion?: string;
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}

/**
 * Resolve guardrails once with model-wins precedence (matching the Converse
 * pi-native merge in stream.ts). Raw `X-Amzn-Bedrock-*` headers supply values
 * only when neither the model nor the caller configured the field; they are
 * then emitted as the resolved headers rather than overriding them.
 */
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

/** Translate the resolved guardrails into the documented Chat wire headers. */
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
		// The Chat route documents the uppercase form; Converse `trace` lowercase values differ.
		headers[GUARDRAIL_TRACE_HEADER] = guardrailTrace.toUpperCase();
	}
	return headers;
}

/**
 * Resolve the Chat base URL for endpoint, wire, and signing: AWS's own regional
 * host (the catalog template `https://bedrock-runtime.{region}.amazonaws.com/openai/v1`,
 * substituted or not) is re-pointed at the resolved region and ends in the
 * `/openai/v1` prefix the OpenAI builder appends `/chat/completions` onto.
 * Custom endpoints (VPC, gateway) keep their configured host and path prefix,
 * with a query string relocated behind the `/chat/completions` suffix.
 */
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

export interface PreparedBedrockOpenAIRequest {
	model: Model<"openai-completions">;
	options: OpenAICompletionsOptions;
}

/**
 * Prepare an `openai-completions` request against amazon-bedrock: resolve the
 * region with the shared Converse geo logic (endpoint host and SigV4 scope use
 * the same value), translate model/caller guardrail settings to their
 * documented headers, then hand OpenAI either a real bearer token or a keyless
 * request whose fetch SigV4-signs every request. On custom gateways with a
 * query string, the configured query is restored onto the final request URL
 * after the OpenAI builder appends `/chat/completions`.
 */
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
	// Guardrail id/version/trace are resolved once, so raw `X-Amzn-Bedrock-*`
	// header copies (consumed as advisory inputs above) must not re-override the
	// translated pair and desync id from version; every other header merges on.
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

/** Restore a custom baseUrl's configured query onto the final `/chat/completions` request URL. */
function createChatCompletionsUrlFetch(fetchUrlPrefix: string, baseFetch?: OpenAICompletionsOptions["fetch"]) {
	const inner = baseFetch ?? (globalThis.fetch as NonNullable<OpenAICompletionsOptions["fetch"]>);
	const urlFetch: typeof inner = (input, init) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		url.search = new URL(fetchUrlPrefix).search;
		return inner(input instanceof Request ? new Request(url.href, input) : url.href, init);
	};
	return Object.assign(urlFetch, inner.preconnect ? { preconnect: inner.preconnect } : {});
}
