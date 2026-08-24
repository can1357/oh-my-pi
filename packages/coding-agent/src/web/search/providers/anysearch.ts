/**
 * AnySearch Web Search Provider
 *
 * Supports ordinary API-key authentication and AnySearch's anonymous-quota
 * auto-registration protocol. Registration responses may contain credentials,
 * so raw error bodies are parsed only for the protocol and never surfaced.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ANYSEARCH_SEARCH_URL = "https://api.anysearch.com/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const DEFAULT_REGISTRATION_POLL_DELAYS_MS = [500, 1_000, 2_000] as const;
const DEFAULT_CREDENTIAL_ACTIVATION_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
const GENERATED_API_KEY_PATTERN = /^as_sk_[0-9a-f]{32}$/;

export interface AnySearchParams {
	query: string;
	num_results?: number;
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
	provisionGeneratedCredential?: boolean;
	/** Test seam for the bounded anonymous-registration polling schedule. */
	registrationPollDelaysMs?: readonly number[];
	/** Test seam for bounded 401 retries while a generated key reaches Gateway caches. */
	credentialActivationRetryDelaysMs?: readonly number[];
}

interface AnySearchCredential {
	username: string;
	password: string;
	apiKey: string;
}

interface AnySearchHttpResult {
	response: SearchResponse;
	registrationRequired?: boolean;
	registrationMessage?: string;
}

interface AnySearchErrorEnvelope {
	message?: string;
	requestId?: string;
}

type RegistrationState = "pending" | "failed" | "disabled" | "unknown";

class AnySearchHttpError extends SearchProviderError {
	readonly requestId?: string;

	constructor(message: string, status: number, requestId?: string) {
		super("anysearch", message, status);
		this.requestId = requestId;
	}
}

interface LimitedResponseTextOptions {
	truncate?: boolean;
	onTooLarge?: () => Error;
}

function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	signal?.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let timer: NodeJS.Timeout | undefined;
	const cleanup = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		signal?.removeEventListener("abort", onAbort);
	};
	const onAbort = (): void => {
		cleanup();
		try {
			signal?.throwIfAborted();
			reject(new DOMException("The operation was aborted.", "AbortError"));
		} catch (error) {
			reject(error);
		}
	};
	timer = setTimeout(() => {
		cleanup();
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return promise;
}

async function readLimitedResponseText(
	response: Response,
	maxBytes: number,
	options: LimitedResponseTextOptions = {},
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let bytes = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const accepted = Math.min(value.byteLength, maxBytes - bytes);
			const nextBytes = bytes + accepted;
			if (nextBytes > buffer.byteLength) {
				const grown = new Uint8Array(Math.min(maxBytes, Math.max(nextBytes, buffer.byteLength * 2)));
				grown.set(buffer.subarray(0, bytes));
				buffer = grown;
			}
			buffer.set(value.subarray(0, accepted), bytes);
			bytes = nextBytes;
			if (accepted < value.byteLength) {
				await reader.cancel().catch(() => undefined);
				if (!options.truncate) {
					throw options.onTooLarge?.() ?? new Error(`Response body exceeded ${maxBytes} bytes`);
				}
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	return new TextDecoder().decode(buffer.subarray(0, bytes));
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function normalizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 2_048) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function normalizeRequestId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const requestId = value.trim();
	if (!requestId || requestId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) return undefined;
	return requestId;
}

function parseErrorEnvelope(raw: string): AnySearchErrorEnvelope {
	const payload = parseJson(raw);
	if (!isRecord(payload)) return {};
	return {
		message: typeof payload.message === "string" ? payload.message : undefined,
		requestId: normalizeRequestId(payload.request_id),
	};
}

function parseGeneratedApiKey(value: string): string | undefined {
	if (GENERATED_API_KEY_PATTERN.test(value)) return value;
	if (value.endsWith(".")) {
		const withoutLegacyPeriod = value.slice(0, -1);
		if (GENERATED_API_KEY_PATTERN.test(withoutLegacyPeriod)) return withoutLegacyPeriod;
	}
	return undefined;
}

function parseRegistrationCredential(message: string): AnySearchCredential | undefined {
	const values = new Map<string, string>();
	for (const line of message.split(/\r?\n/)) {
		const match = /^\s*(username|password|api_key)\s*=\s*(\S.*?)\s*$/.exec(line);
		if (!match) continue;
		const name = match[1];
		const value = match[2];
		if (!name || !value || value.length > 8_192) return undefined;
		const previous = values.get(name);
		if (previous !== undefined && previous !== value) return undefined;
		values.set(name, value);
	}

	const username = values.get("username");
	const password = values.get("password");
	const apiKeyValue = values.get("api_key");
	const apiKey = apiKeyValue ? parseGeneratedApiKey(apiKeyValue) : undefined;
	return username && password && apiKey ? { username, password, apiKey } : undefined;
}

function registrationState(message: string | undefined): RegistrationState {
	if (!message) return "unknown";
	if (/auto-registration failed/i.test(message)) return "failed";
	if (/auto-registration is disabled/i.test(message)) return "disabled";
	if (/registering your account|try again shortly/i.test(message)) return "pending";
	return "unknown";
}

function appendRequestId(message: string, requestId: string | undefined): string {
	return requestId ? `${message.replace(/[.!?]\s*$/, "")}. Request ID: ${requestId}.` : message;
}

function anonymousQuotaError(message: string | undefined, requestId?: string): SearchProviderError {
	const classified =
		classifyProviderHttpError("anysearch", 402, message ?? "") ??
		new SearchProviderError("anysearch", "anysearch: 402 credits exhausted", 402);
	return new SearchProviderError("anysearch", appendRequestId(classified.message, requestId), classified.status);
}

function registrationError(message: string | undefined, requestId: string | undefined): SearchProviderError {
	switch (registrationState(message)) {
		case "pending":
			return new SearchProviderError(
				"anysearch",
				appendRequestId(
					"AnySearch account registration is still in progress. Select AnySearch and try again shortly.",
					requestId,
				),
				402,
			);
		case "failed":
			return new SearchProviderError(
				"anysearch",
				appendRequestId(
					"AnySearch account registration failed. Configure ANYSEARCH_API_KEY or run /login anysearch, then try again.",
					requestId,
				),
				402,
			);
		case "disabled":
			return new SearchProviderError(
				"anysearch",
				appendRequestId(
					"AnySearch automatic account registration is unavailable. Configure ANYSEARCH_API_KEY or run /login anysearch.",
					requestId,
				),
				402,
			);
		case "unknown":
			return anonymousQuotaError(message, requestId);
	}
}

function parseSuccessfulResponse(raw: string, numResults: number, fallbackRequestId?: string): SearchResponse {
	const payload = parseJson(raw);
	if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data) || !Array.isArray(payload.data.results)) {
		throw new SearchProviderError("anysearch", "AnySearch API returned an unexpected response", 502);
	}

	const sources: SearchSource[] = [];
	for (const item of payload.data.results) {
		if (!isRecord(item)) continue;
		const url = normalizeUrl(item.url);
		if (!url) continue;
		sources.push({
			title: normalizeText(item.title, 300) ?? url,
			url,
			snippet: normalizeText(item.content, 8_000) ?? normalizeText(item.snippet, 8_000),
		});
	}

	return {
		provider: "anysearch",
		sources: sources.slice(0, numResults),
		requestId: normalizeRequestId(payload.request_id) ?? fallbackRequestId,
	};
}

async function callAnySearch(params: AnySearchParams, apiKey: string | undefined): Promise<AnySearchHttpResult> {
	const numResults = Math.floor(clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const response = await (params.fetch ?? fetch)(ANYSEARCH_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: params.query, max_results: numResults }),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
	const headerRequestId = normalizeRequestId(
		response.headers.get("x-request-id") ?? response.headers.get("request-id"),
	);

	if (response.ok) {
		const raw = await readLimitedResponseText(response, MAX_RESPONSE_BYTES, {
			onTooLarge: () => new SearchProviderError("anysearch", "AnySearch API response exceeded 2 MiB", 502),
		});
		return {
			response: {
				...parseSuccessfulResponse(raw, numResults, headerRequestId),
				authMode: apiKey ? "api_key" : "anonymous",
			},
		};
	}

	const raw = await readLimitedResponseText(response, MAX_ERROR_BYTES, { truncate: true });
	const errorEnvelope = parseErrorEnvelope(raw);
	const requestId = errorEnvelope.requestId ?? headerRequestId;
	if (!apiKey && response.status === 402) {
		return {
			response: { provider: "anysearch", sources: [], requestId, authMode: "anonymous" },
			registrationRequired: true,
			registrationMessage: errorEnvelope.message,
		};
	}

	const classified = classifyProviderHttpError("anysearch", response.status, raw);
	if (classified) throw new AnySearchHttpError(classified.message, response.status, requestId);
	throw new AnySearchHttpError(`AnySearch API request failed (${response.status})`, response.status, requestId);
}

async function persistGeneratedCredential(authStorage: AuthStorage, credential: AnySearchCredential): Promise<void> {
	try {
		await authStorage.set("anysearch", { type: "api_key", key: credential.apiKey, source: "login" });
	} catch {
		throw new SearchProviderError(
			"anysearch",
			"AnySearch generated an API key, but OMP could not save it. Select AnySearch and try again.",
			500,
		);
	}
}

async function searchWithGeneratedCredential(
	params: AnySearchParams,
	credential: AnySearchCredential,
): Promise<SearchResponse> {
	let lastRequestId: string | undefined;
	const retryDelays = params.credentialActivationRetryDelaysMs ?? DEFAULT_CREDENTIAL_ACTIVATION_RETRY_DELAYS_MS;

	for (let attempt = 0; ; attempt++) {
		try {
			return (await callAnySearch(params, credential.apiKey)).response;
		} catch (error) {
			if (!(error instanceof AnySearchHttpError) || error.status !== 401) throw error;
			lastRequestId = error.requestId ?? lastRequestId;
			const delayMs = retryDelays[attempt];
			if (delayMs === undefined) {
				throw new SearchProviderError(
					"anysearch",
					appendRequestId(
						"AnySearch generated an API key, but it has not reached the search gateway yet. Try again shortly.",
						lastRequestId,
					),
					503,
				);
			}
			await sleepWithAbort(delayMs, params.signal);
		}
	}
}

async function persistAndUseGeneratedCredential(
	params: AnySearchParams,
	credential: AnySearchCredential,
): Promise<SearchResponse> {
	await persistGeneratedCredential(params.authStorage, credential);
	return searchWithGeneratedCredential(params, credential);
}

async function completeAnonymousRegistration(params: AnySearchParams): Promise<SearchResponse> {
	let result = await callAnySearch(params, undefined);
	if (!result.registrationRequired) return result.response;
	let message = result.registrationMessage;
	let requestId = result.response.requestId;

	for (const delayMs of params.registrationPollDelaysMs ?? DEFAULT_REGISTRATION_POLL_DELAYS_MS) {
		const credential = message ? parseRegistrationCredential(message) : undefined;
		if (credential) {
			return persistAndUseGeneratedCredential(params, credential);
		}
		if (registrationState(message) !== "pending") break;
		await sleepWithAbort(delayMs, params.signal);
		result = await callAnySearch(params, undefined);
		if (!result.registrationRequired) return result.response;
		message = result.registrationMessage;
		requestId = result.response.requestId ?? requestId;
	}

	const credential = message ? parseRegistrationCredential(message) : undefined;
	if (credential) {
		return persistAndUseGeneratedCredential(params, credential);
	}

	throw registrationError(message, requestId);
}

/** Execute AnySearch web search. */
export async function searchAnySearch(params: AnySearchParams): Promise<SearchResponse> {
	const initialKey = await params.authStorage.getApiKey("anysearch", params.sessionId, { signal: params.signal });
	if (initialKey) {
		const keyOrResolver: ApiKey = params.authStorage.resolver("anysearch", { sessionId: params.sessionId });
		const result = await withAuth(keyOrResolver, key => callAnySearch(params, key), { signal: params.signal });
		return result.response;
	}

	if (!params.provisionGeneratedCredential) {
		const result = await callAnySearch(params, undefined);
		if (result.registrationRequired) {
			throw anonymousQuotaError(result.registrationMessage, result.response.requestId);
		}
		return result.response;
	}

	return completeAnonymousRegistration(params);
}

/** Search provider for AnySearch. */
export class AnySearchProvider extends SearchProvider {
	readonly id = "anysearch";
	readonly label = "AnySearch";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("anysearch") || !!getEnvApiKey("anysearch");
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnySearch(toAnySearchParams(params));
	}

	searchWithCredentialProvisioning(params: SearchParams): Promise<SearchResponse> {
		return searchAnySearch({
			...toAnySearchParams(params),
			provisionGeneratedCredential: true,
		});
	}
}

function toAnySearchParams(params: SearchParams): AnySearchParams {
	return {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		authStorage: params.authStorage,
		sessionId: params.sessionId,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
}
