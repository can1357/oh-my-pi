/**
 * Z.AI Web Search Provider
 *
 * Calls Z.AI's remote MCP server (`webSearchPrime`) and adapts results into
 * the unified SearchResponse shape used by the web search tool.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax } from "../query";
import { dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ZAI_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_TOOL_NAME = "web_search_prime";
const DEFAULT_NUM_RESULTS = 10;

/**
 * webSearchPrime exposes no native filter args (the Web Search API's
 * `search_domain_filter`/`search_recency_filter` are scoped to the
 * `search_pro_jina` engine, not `search-prime`), but its Bing-flavored
 * backend parses the common inline operators. Dates and language are left
 * to the central lenient post-filter.
 */
const ZAI_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	site: true,
	inTitle: true,
	inUrl: true,
	filetype: true,
};

export interface ZaiSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
	authStorage: AuthStorage;
	sessionId?: string;
}

interface ZaiSearchResult {
	title?: string;
	content?: string;
	link?: string;
	url?: string;
	media?: string;
	publish_date?: string;
	publishedDate?: string;
}

interface ZaiWebSearchResponse {
	id?: string;
	request_id?: string;
	requestId?: string;
	search_result?: ZaiSearchResult[];
	results?: ZaiSearchResult[];
}

interface JsonRpcError {
	code?: number;
	message?: string;
}

interface JsonRpcPayload {
	result?: unknown;
	error?: JsonRpcError;
}

interface ZaiMcpPostResult {
	parsed?: unknown;
	sessionId?: string;
}

const ZAI_MCP_PROTOCOL_VERSION = "2025-03-26";
const ZAI_MCP_CLIENT_INFO = {
	name: "omp-coding-agent",
	version: "1.0.0",
};

function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseZaiMcpResponse(rawText: string): unknown {
	const parsedMessages: unknown[] = [];
	for (const line of rawText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const data = trimmed.slice(5).trim();
		if (!data) continue;
		try {
			parsedMessages.push(JSON.parse(data));
		} catch {
			// Ignore non-JSON data events.
		}
	}

	if (parsedMessages.length === 0) {
		try {
			parsedMessages.push(JSON.parse(rawText));
		} catch {
			throw new SearchProviderError("zai", "Failed to parse Z.AI MCP response", 500);
		}
	}

	return parsedMessages[parsedMessages.length - 1];
}

async function postZaiMcp(
	apiKey: string,
	method: string,
	params: Record<string, unknown>,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
	expectResponse: boolean,
	timeoutMs?: number,
): Promise<ZaiMcpPostResult> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (sessionId) {
		headers["Mcp-Session-Id"] = sessionId;
	}

	const body: Record<string, unknown> = {
		jsonrpc: "2.0",
		method,
		params,
	};
	if (expectResponse) {
		body.id = crypto.randomUUID();
	}

	const response = await fetchImpl(ZAI_MCP_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("zai", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("zai", `Z.AI MCP error (${response.status}): ${errorText}`, response.status);
	}

	const nextSessionId = response.headers.get("Mcp-Session-Id") ?? sessionId;
	if (!expectResponse) {
		await response.body?.cancel();
		return { sessionId: nextSessionId };
	}

	return {
		parsed: parseZaiMcpResponse(await response.text()),
		sessionId: nextSessionId,
	};
}

function readJsonRpcPayload(parsed: unknown): JsonRpcPayload {
	const parsedRecord = isRecord(parsed) ? parsed : null;
	const directErrorCode = typeof parsedRecord?.code === "number" ? parsedRecord.code : undefined;
	const directErrorSuccess = parsedRecord?.success;
	const directErrorMessage =
		asString(parsedRecord?.msg) ?? asString(parsedRecord?.message) ?? asString(parsedRecord?.error_message);
	if (directErrorSuccess === false && directErrorMessage) {
		throw new SearchProviderError(
			"zai",
			`Z.AI API error${directErrorCode ? ` (${directErrorCode})` : ""}: ${directErrorMessage}`,
			directErrorCode,
		);
	}

	if (!isRecord(parsed)) {
		throw new SearchProviderError("zai", "Failed to parse Z.AI MCP response", 500);
	}

	const payload = parsed as JsonRpcPayload;
	if (payload.error) {
		const status = typeof payload.error.code === "number" ? payload.error.code : 400;
		throw new SearchProviderError(
			"zai",
			`Z.AI MCP error${payload.error.code ? ` (${payload.error.code})` : ""}: ${payload.error.message ?? "Unknown error"}`,
			status,
		);
	}

	return payload;
}

/** Resolve Z.AI API credentials through the unified auth storage pipeline. */
export async function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	return (await authStorage.getApiKey("zai", sessionId, { signal })) ?? null;
}

async function callZaiTool(
	apiKey: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
	timeoutMs?: number,
): Promise<unknown> {
	const initialized = await postZaiMcp(
		apiKey,
		"initialize",
		{
			protocolVersion: ZAI_MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: ZAI_MCP_CLIENT_INFO,
		},
		undefined,
		signal,
		fetchImpl,
		true,
		timeoutMs,
	);
	if (initialized.parsed !== undefined) {
		readJsonRpcPayload(initialized.parsed);
	}

	await postZaiMcp(
		apiKey,
		"notifications/initialized",
		{},
		initialized.sessionId,
		signal,
		fetchImpl,
		false,
		timeoutMs,
	);

	const toolCall = await postZaiMcp(
		apiKey,
		"tools/call",
		{
			name: ZAI_TOOL_NAME,
			arguments: args,
		},
		initialized.sessionId,
		signal,
		fetchImpl,
		true,
		timeoutMs,
	);
	const payload = readJsonRpcPayload(toolCall.parsed);
	const resultRecord = isRecord(payload.result) ? payload.result : null;
	if (resultRecord?.isError === true) {
		const content = Array.isArray(resultRecord.content) ? resultRecord.content : [];
		const errorText = content
			.map(item => {
				if (!isRecord(item)) return null;
				return asString(item.text);
			})
			.filter((text): text is string => text != null)
			.join("\n")
			.trim();
		const statusMatch = errorText.match(/MCP error\s*(-?\d+)/i);
		const statusCode = statusMatch ? Math.abs(Number.parseInt(statusMatch[1], 10)) : 400;
		throw new SearchProviderError("zai", errorText || "Z.AI MCP tool call failed", statusCode);
	}

	if (payload.result !== undefined) {
		return payload.result;
	}

	return toolCall.parsed;
}

async function callZaiSearch(apiKey: string, params: ZaiSearchParams): Promise<unknown> {
	const count = params.num_results ?? DEFAULT_NUM_RESULTS;
	const fetchImpl = params.fetch ?? fetch;
	const attempts: Record<string, unknown>[] = [
		{ query: params.query, count },
		{ search_query: params.query, count },
		{ search_query: params.query, search_engine: "search-prime", count },
	];

	let lastError: unknown;
	for (let i = 0; i < attempts.length; i++) {
		try {
			return await callZaiTool(apiKey, attempts[i], params.signal, fetchImpl, params.timeoutMs);
		} catch (error) {
			lastError = error;
			const isLastAttempt = i === attempts.length - 1;
			if (isLastAttempt) {
				throw error;
			}
			if (!(error instanceof SearchProviderError)) {
				throw error;
			}
			const message = error.message.toLowerCase();
			const looksLikeArgError =
				error.status === 400 ||
				message.includes("invalid") ||
				message.includes("argument") ||
				message.includes("search_query") ||
				message.includes("query");
			if (!looksLikeArgError) {
				throw error;
			}
		}
	}

	throw lastError ?? new SearchProviderError("zai", "Z.AI search failed", 500);
}

function getSearchResults(value: unknown): ZaiSearchResult[] {
	if (Array.isArray(value)) {
		return value as ZaiSearchResult[];
	}
	if (!isRecord(value)) return [];
	const obj = value;

	const searchResult = obj.search_result;
	if (Array.isArray(searchResult)) return searchResult as ZaiSearchResult[];

	const results = obj.results;
	if (Array.isArray(results)) return results as ZaiSearchResult[];

	return [];
}

function parseSearchPayload(rawResult: unknown): {
	results: ZaiSearchResult[];
	answer?: string;
	requestId?: string;
} {
	const candidates: unknown[] = [rawResult];
	const textParts: string[] = [];

	if (isRecord(rawResult)) {
		if (rawResult.structuredContent) candidates.push(rawResult.structuredContent);
		if (rawResult.data) candidates.push(rawResult.data);
		if (rawResult.result) candidates.push(rawResult.result);

		const content = rawResult.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				const text = isRecord(part) ? asString(part.text) : null;
				if (!text) continue;
				try {
					let parsed: unknown = JSON.parse(text);
					if (typeof parsed === "string") {
						try {
							parsed = JSON.parse(parsed);
						} catch {
							// The decoded string is answer text rather than another JSON payload.
						}
					}
					candidates.push(parsed);
					if (getSearchResults(parsed).length === 0) textParts.push(text);
				} catch {
					// Non-JSON content is preserved as answer text.
					textParts.push(text);
				}
			}
		}
	}

	for (const candidate of candidates) {
		const results = getSearchResults(candidate);
		if (results.length > 0) {
			const obj = isRecord(candidate) ? (candidate as ZaiWebSearchResponse) : null;
			return {
				results,
				answer: textParts.length > 0 ? textParts.join("\n\n") : undefined,
				requestId: obj?.request_id ?? obj?.requestId ?? obj?.id,
			};
		}
	}

	return {
		results: [],
		answer: textParts.length > 0 ? textParts.join("\n\n") : undefined,
	};
}

function toSources(results: ZaiSearchResult[]): SearchSource[] {
	const sources: SearchSource[] = [];
	for (const result of results) {
		const url = asString(result.link) ?? asString(result.url);
		if (!url) continue;

		const publishedDate = asString(result.publish_date) ?? asString(result.publishedDate);
		sources.push({
			title: asString(result.title) ?? url,
			url,
			snippet: asString(result.content) ?? undefined,
			publishedDate: publishedDate ?? undefined,
			ageSeconds: dateToAgeSeconds(publishedDate),
			author: asString(result.media) ?? undefined,
		});
	}
	return sources;
}

/** Execute Z.AI web search via remote MCP endpoint. */
export async function searchZai(params: ZaiSearchParams): Promise<SearchResponse> {
	const keyOrResolver: ApiKey = params.authStorage.resolver("zai", {
		sessionId: params.sessionId,
	});

	const rawResult = await withAuth(keyOrResolver, key => callZaiSearch(key, params), {
		signal: params.signal,
		missingKeyMessage: "Z.AI credentials not found. Set ZAI_API_KEY or login with 'omp /login zai'.",
	});
	const payload = parseSearchPayload(rawResult);
	let sources = toSources(payload.results);

	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "zai",
		answer: payload.answer,
		sources,
		requestId: payload.requestId,
	};
}

type ZaiProviderSearchParams = SearchParams & { fetch?: FetchImpl };

/** Search provider for Z.AI web search MCP. */
export class ZaiProvider extends SearchProvider {
	readonly id = "zai";
	readonly label = "Z.AI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return authStorage.hasAuth("zai") || !!getEnvApiKey("zai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		const { fetch: fetchOverride } = params as ZaiProviderSearchParams;
		const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
		return searchZai({
			query: parsed.hasDirectives ? formatQuery(parsed, ZAI_QUERY_SYNTAX) : params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: fetchOverride,
		});
	}
}
