/** Bearer-token and SigV4 authentication shared by Bedrock transports. */
import { NO_AUTH_SENTINEL } from "../auth-retry";
import { type AwsBedrockProviderOptions, resolveAwsBearerToken } from "../registry/aws";
import type { FetchImpl } from "../types";
import { resolveAwsRegion } from "../utils/aws-profile";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";

/** Options for {@link createAwsAuthenticatedFetch}: transport override plus the AWS credential/bearer inputs used to sign requests. */
export interface AwsAuthenticatedFetchOptions {
	fetch?: FetchImpl;
	/** Bearer API key; authentication sentinels fall back to the AWS credential chain. */
	apiKey?: string;
	signal?: AbortSignal;
	providerOptions?: AwsBedrockProviderOptions;
}

// Recompute signature headers and content length from the final request.
const SIGNER_OWNED_HEADERS: Record<string, true> = {
	host: true,
	authorization: true,
	"content-length": true,
	"x-amz-date": true,
	"x-amz-content-sha256": true,
	"x-amz-security-token": true,
};

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

/** Sign requests and invalidate cached credentials after an authentication failure. */
export function createAwsSignedFetch(
	options: AwsAuthenticatedFetchOptions,
	region: string,
	service: string,
): FetchImpl {
	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const signedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "POST");
		const signal = init?.signal ?? options.signal ?? (input instanceof Request ? input.signal : undefined);
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		const signableHeaders: Record<string, string> = {};
		for (const [name, value] of headers) {
			if (SIGNER_OWNED_HEADERS[name]) continue;
			signableHeaders[name] = value;
		}
		for (const name in SIGNER_OWNED_HEADERS) headers.delete(name);
		const body = await requestBody(input, init);
		const credentials = await resolveAwsCredentials({
			profile: options.providerOptions?.profile,
			region,
			signal,
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
			headers: signableHeaders,
		});
		for (const [name, value] of Object.entries(signed)) {
			if (value !== undefined && name !== "host") headers.set(name, value);
		}
		const response = await baseFetch(
			url,
			method === "GET" || method === "HEAD"
				? { ...init, method, headers, signal }
				: { ...init, method, headers, body, signal },
		);
		if (response.status === 401 || response.status === 403) {
			invalidateAwsCredentialCache({ profile: options.providerOptions?.profile, region });
		}
		return response;
	};
	return Object.assign(signedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

/** Resolve a bearer token without forwarding internal authentication sentinels. */
export function resolveAwsAuthenticatedBearerToken(options: AwsAuthenticatedFetchOptions): string | undefined {
	const apiKey = options.apiKey === NO_AUTH_SENTINEL ? undefined : options.apiKey;
	return resolveAwsBearerToken(apiKey, options.providerOptions?.bearerToken);
}

/** Use a configured bearer token, otherwise sign with the AWS credential chain. */
export function createAwsAuthenticatedFetch(service: string, options: AwsAuthenticatedFetchOptions = {}): FetchImpl {
	const region = resolveAwsRegion(options.providerOptions?.region, options.providerOptions?.profile);
	const bearerToken = resolveAwsAuthenticatedBearerToken(options);
	if (!bearerToken) return createAwsSignedFetch(options, region, service);

	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.set("authorization", `Bearer ${bearerToken}`);
		return baseFetch(input, {
			...init,
			headers,
			signal: init?.signal ?? options.signal ?? (input instanceof Request ? input.signal : undefined),
		});
	};
	return Object.assign(authenticatedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}
