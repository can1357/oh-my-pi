/**
 * Shared AWS fetch construction for Bedrock-family transports that must
 * either present a real bearer token or SigV4-sign with the standard
 * credential chain. Parameterized by SigV4 service name only:
 * `bedrock` (runtime APIs, including /openai/v1 Chat Completions) versus
 * `bedrock-mantle`. Callers' supplied fetch and signal always form the base.
 */
import { NO_AUTH_SENTINEL } from "../auth-retry";
import { type AwsBedrockProviderOptions, resolveAwsBearerToken } from "../registry/aws";
import type { FetchImpl } from "../types";
import { resolveAwsRegion } from "../utils/aws-profile";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";

/** Options consumed by the shared AWS authenticated fetch. */
export interface AwsAuthenticatedFetchOptions {
	/** Base fetch; defaults to the global implementation. */
	fetch?: FetchImpl;
	/** Caller-supplied bearer API key; the `N/A` sentinel means keyless (sign instead). */
	apiKey?: string;
	/** Abort signal threaded into credential resolution. */
	signal?: AbortSignal;
	/** AWS region/profile/bearer overrides. */
	providerOptions?: AwsBedrockProviderOptions;
}

async function requestBody(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
	if (init?.body !== undefined && init.body !== null) {
		if (typeof init.body === "string") return new TextEncoder().encode(init.body);
		if (init.body instanceof Uint8Array) return init.body;
		if (init.body instanceof ArrayBuffer) return new Uint8Array(init.body);
		throw new TypeError(`Cannot SigV4-sign ${init.body.constructor?.name ?? typeof init.body} request body`);
	}
	if (input instanceof Request) return new Uint8Array(await input.clone().arrayBuffer());
	return new Uint8Array();
}

/**
 * Fetch implementation that SigV4-signs every request with the resolved AWS
 * credentials. Any caller `authorization` header is dropped first so a stale
 * sentinel can never be signed over or sent. Signature region and credential
 * scope use the same resolved `region`, so endpoint and signer stay coherent.
 * A 401/403 drops the cached credentials for the profile/region so the next
 * request re-resolves instead of reusing stale session keys.
 */
export function createAwsSignedFetch(
	options: AwsAuthenticatedFetchOptions,
	region: string,
	service: string,
): FetchImpl {
	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const signedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "POST");
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.delete("authorization");
		const body = await requestBody(input, init);
		const credentials = await resolveAwsCredentials({
			profile: options.providerOptions?.profile,
			region,
			signal: options.signal,
			fetch: baseFetch,
		});
		const signed = await signRequest({
			method,
			host: url.host,
			path: url.pathname,
			query: url.search.slice(1),
			body,
			region,
			service,
			credentials,
			headers: { "content-type": headers.get("content-type") ?? "application/json" },
		});
		for (const [name, value] of Object.entries(signed)) {
			if (value !== undefined && name !== "host") headers.set(name, value);
		}
		const response = await baseFetch(
			url,
			method === "GET" || method === "HEAD" ? { ...init, method, headers } : { ...init, method, headers, body },
		);
		if (response.status === 401 || response.status === 403) {
			invalidateAwsCredentialCache({ profile: options.providerOptions?.profile, region });
		}
		return response;
	};
	return Object.assign(signedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

/** Resolve the real AWS bearer token, filtering the registry's keyless marker. */
export function resolveAwsAuthenticatedBearerToken(options: AwsAuthenticatedFetchOptions): string | undefined {
	const apiKey = options.apiKey === NO_AUTH_SENTINEL ? undefined : options.apiKey;
	return resolveAwsBearerToken(apiKey, options.providerOptions?.bearerToken);
}

/**
 * Fetch implementation that authenticates with a real bearer token when one
 * is configured (providerOptions.bearerToken > apiKey > AWS_BEARER_TOKEN_BEDROCK)
 * and otherwise SigV4-signs with the AWS credential chain for `service`.
 * Region defaults to {@link resolveAwsRegion} precedence; callers that need
 * model-aware inference-profile geo routing pass `providerOptions.region`.
 */
export function createAwsAuthenticatedFetch(
	service: string,
	options: AwsAuthenticatedFetchOptions = {},
): FetchImpl {
	const region = resolveAwsRegion(options.providerOptions?.region, options.providerOptions?.profile);
	const bearerToken = resolveAwsAuthenticatedBearerToken(options);
	if (!bearerToken) return createAwsSignedFetch(options, region, service);

	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.set("authorization", `Bearer ${bearerToken}`);
		return baseFetch(input, { ...init, headers });
	};
	return Object.assign(authenticatedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}
