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
import {
	AWS_REGIONAL_BEDROCK_HOST,
	type BedrockRegionSource,
	resolveBedrockRegion,
} from "../utils/aws-bedrock-region";
import { createAwsAuthenticatedFetch, resolveAwsAuthenticatedBearerToken } from "./aws-authenticated-fetch";
import type { OpenAICompletionsOptions } from "./openai-completions";

/** SigV4 service name for bedrock-runtime requests, including /openai/v1. */
const BEDROCK_SERVICE = "bedrock";

const GUARDRAIL_IDENTIFIER_HEADER = "X-Amzn-Bedrock-GuardrailIdentifier";
const GUARDRAIL_VERSION_HEADER = "X-Amzn-Bedrock-GuardrailVersion";
const GUARDRAIL_TRACE_HEADER = "X-Amzn-Bedrock-GuardrailTrace";

/** Wire value for a guardrail trace setting; `enabled_full` has no Chat form. */
function guardrailTraceHeaderValue(trace: "enabled" | "disabled" | "enabled_full"): "enabled" | "disabled" {
	if (trace === "enabled_full") {
		throw new ConfigurationError(
			'guardrailTrace "enabled_full" is Converse-only; the Chat Completions endpoint accepts only "enabled" or "disabled"',
		);
	}
	return trace;
}

export interface BedrockOpenAIProviderOptions extends AwsBedrockProviderOptions {}

export interface BedrockOpenAIOptions extends OpenAICompletionsOptions {
	providerOptions?: BedrockOpenAIProviderOptions;
	/** Explicit per-request Guardrail id or ARN; mirrors Converse `BedrockOptions`. */
	guardrailIdentifier?: string;
	/** Guardrail version to apply. Defaults to `"DRAFT"` when a guardrail is set. */
	guardrailVersion?: string;
	/** Guardrail trace verbosity. Left unset (Bedrock default) unless provided. */
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}

/**
 * Whether `baseUrl` is AWS's own regional Bedrock host with no routing of its
 * own — the bundled catalog template `https://bedrock-runtime.{region}.amazonaws.com/openai/v1`
 * after region substitution (or with the placeholder still intact). Only those
 * URLs are normalized (region rewrite + `/openai/v1` restore). Explicit
 * overrides (VPC endpoints, gateways, custom path/query) are preserved
 * verbatim; a custom baseUrl that itself ends in origin-level `/openai/v1` on
 * AWS's host is normalized rather than double-mounted.
 */
function isAwsBedrockTemplateBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let url: URL;
	try {
		url = new URL(baseUrl.replaceAll("{region}", "us-east-1"));
	} catch {
		return false;
	}
	if (!AWS_REGIONAL_BEDROCK_HOST.test(url.host)) return false;
	if (url.search || url.hash) return false;
	const path = url.pathname.replace(/\/+$/, "");
	return path === "" || path === "/openai/v1";
}

/**
 * Resolve the base URL for Bedrock Chat Completions. AWS's own regional host
 * is re-pointed at the resolved region (SigV4 scope follows the same region)
 * and the `/openai/v1` prefix is guaranteed exactly once. Any other baseUrl
 * (VPC endpoint, gateway, custom path/query) is used verbatim; the downstream
 * OpenAI transport appends `/chat/completions` itself.
 */
function resolveBedrockOpenAIBaseUrl(baseUrl: string | undefined, region: string): string {
	if (!isAwsBedrockTemplateBaseUrl(baseUrl)) return baseUrl ?? "";
	return `https://bedrock-runtime.${encodeURIComponent(region)}.amazonaws.com/openai/v1`;
}

/** Effective guardrail settings with per-call options over model fields; explicit headers are advisory lower priority. */
function resolveBedrockGuardrailConfig(
	model: Model<"openai-completions">,
	options: BedrockOpenAIOptions,
): { guardrailIdentifier?: string; guardrailVersion?: string; guardrailTrace?: "enabled" | "disabled" | "enabled_full" } {
	const headerOverride = (key: string, value: string | undefined): string | undefined =>
		value ?? options.headers?.[key] ?? model.headers?.[key];
	return {
		guardrailIdentifier: headerOverride(GUARDRAIL_IDENTIFIER_HEADER, options.guardrailIdentifier ?? model.guardrailIdentifier),
		guardrailVersion: headerOverride(GUARDRAIL_VERSION_HEADER, options.guardrailVersion ?? model.guardrailVersion),
		guardrailTrace:
			options.guardrailTrace ??
			model.guardrailTrace ??
			(options.headers?.[GUARDRAIL_TRACE_HEADER] as "enabled" | "disabled" | undefined) ??
			(model.headers?.[GUARDRAIL_TRACE_HEADER] as "enabled" | "disabled" | undefined),
	};
}

/**
 * Translate effective guardrail settings into the documented Chat Completions
 * headers. Model-level headers apply below per-call headers (matching the
 * pi-native merge in streamSimpleRequest); any pre-set `X-Amzn-Bedrock-…`
 * header on either survives — the OpenAI request setup then merges it through
 * to the signed request. An identifierless version pins the default `DRAFT`
 * only around an actual identifier; a version without one fails closed.
 */
function translateBedrockGuardrailHeaders(
	model: Model<"openai-completions">,
	options: BedrockOpenAIOptions,
): Record<string, string> | undefined {
	const { guardrailIdentifier, guardrailVersion, guardrailTrace } = resolveBedrockGuardrailConfig(model, options);
	if (guardrailIdentifier === undefined && guardrailTrace === undefined) {
		if (guardrailVersion !== undefined) {
			throw new ConfigurationError("guardrailVersion requires guardrailIdentifier on Bedrock Chat Completions");
		}
		return undefined;
	}
	const headers: Record<string, string> = {};
	if (guardrailIdentifier !== undefined) {
		headers[GUARDRAIL_IDENTIFIER_HEADER] = guardrailIdentifier;
		headers[GUARDRAIL_VERSION_HEADER] = guardrailVersion ?? "DRAFT";
	}
	if (guardrailTrace !== undefined) {
		headers[GUARDRAIL_TRACE_HEADER] = guardrailTraceHeaderValue(guardrailTrace);
	}
	return headers;
}

export interface PreparedBedrockOpenAIRequest {
	model: Model<"openai-completions">;
	options: OpenAICompletionsOptions;
}

/**
 * Prepare an `openai-completions` request against amazon-bedrock: resolve the
 * region with the shared Converse geo logic, normalize AWS's own host to
 * `/openai/v1`, translate guardrail settings to their documented headers,
 * then either hand OpenAI the real bearer token or mark the request keyless
 * (`apiKey: N/A`, no Authorization header) and wrap the fetch in SigV4
 * signing. The registry's `<authenticated>` marker is consumed here and can
 * never reach the wire as a bearer.
 */
export function prepareBedrockOpenAIRequest(
	model: Model<"openai-completions">,
	options: BedrockOpenAIOptions,
): PreparedBedrockOpenAIRequest {
	const providerOptions = options.providerOptions;
	const guardrail = resolveBedrockGuardrailConfig(model, options);
	const regionSource: BedrockRegionSource = {
		region: providerOptions?.region,
		profile: providerOptions?.profile,
		guardrailIdentifier: guardrail.guardrailIdentifier,
	};
	const region = resolveBedrockRegion(model.id, regionSource);
	// Keep the sign region pinned to the resolved region even when it came from
	// the model ARN or geo fallback: the endpoint host and SigV4 scope must match.
	const effectiveProviderOptions: BedrockOpenAIProviderOptions = { ...providerOptions, region };
	const baseUrl = resolveBedrockOpenAIBaseUrl(model.baseUrl, region);
	const guardrailHeaders = translateBedrockGuardrailHeaders(model, options);
	// Guardrail headers sit under explicit model/caller X-Amzn-Bedrock-… entries;
	// when none were configured the merged maps reduce to the existing values.
	const headers: Record<string, string> = {
		...guardrailHeaders,
		...(model.headers as Record<string, string> | undefined),
		...(options.headers as Record<string, string> | undefined),
	};
	const resolvedModel: Model<"openai-completions"> = { ...model, baseUrl, headers };
	const fetchOptions: BedrockOpenAIOptions = { ...options, providerOptions: effectiveProviderOptions, headers };
	const bearerToken = resolveAwsAuthenticatedBearerToken(fetchOptions);
	if (bearerToken) {
		return {
			model: resolvedModel,
			options: { ...fetchOptions, apiKey: bearerToken },
		};
	}
	return {
		model: resolvedModel,
		options: {
			...fetchOptions,
			apiKey: NO_AUTH_SENTINEL,
			fetch: createAwsAuthenticatedFetch(BEDROCK_SERVICE, fetchOptions),
		},
	};
}
