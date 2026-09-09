import { type AwsBedrockProviderOptions, resolveAwsBearerToken } from "../registry/aws";
import type { FetchImpl, Model } from "../types";
import { resolveAwsRegion } from "../utils/aws-profile";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";
import type { OpenAIResponsesOptions } from "./openai-responses";
import { NO_AUTH_SENTINEL } from "./openai-shared";

export type BedrockMantleProviderOptions = AwsBedrockProviderOptions;

export interface BedrockMantleOptions extends OpenAIResponsesOptions {
	providerOptions?: BedrockMantleProviderOptions;
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

function createSignedFetch(options: BedrockMantleOptions, region: string): FetchImpl {
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
			service: "bedrock-mantle",
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

function resolveBearerToken(options: BedrockMantleOptions): string | undefined {
	const apiKey = options.apiKey === NO_AUTH_SENTINEL ? undefined : options.apiKey;
	return resolveAwsBearerToken(apiKey, options.providerOptions?.bearerToken);
}

export function createBedrockMantleAuthenticatedFetch(options: BedrockMantleOptions = {}): FetchImpl {
	const region = resolveAwsRegion(options.providerOptions?.region, options.providerOptions?.profile);
	const bearerToken = resolveBearerToken(options);
	if (!bearerToken) return createSignedFetch(options, region);

	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.set("authorization", `Bearer ${bearerToken}`);
		return baseFetch(input, { ...init, headers });
	};
	return Object.assign(authenticatedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
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
	const bearerToken = resolveBearerToken(options);
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
