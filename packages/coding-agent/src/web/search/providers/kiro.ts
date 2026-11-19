/**
 * Kiro Web Search Provider
 *
 * Calls the `web_search` tool of the Kiro runtime's MCP endpoint
 * (`POST https://runtime.<region>.kiro.dev/mcp`, JSON-RPC `tools/call`) with
 * the `kiro` login (`/login kiro`) or `KIRO_API_KEY`. The tool takes only a
 * query of at most 200 characters and returns one page of results.
 */
import { type AuthStorage, resolveApiKeyOnce, seedApiKeyResolver, withAuth } from "@oh-my-pi/pi-ai";
import { decodeKiroCredential, kiroRuntimeBaseUrl } from "@oh-my-pi/pi-catalog/wire/kiro";
import { kiroCliMcpHeaders } from "@oh-my-pi/pi-catalog/wire/kiro-cli";
import { isRecord } from "@oh-my-pi/pi-utils";
import { formatQuery, parseSearchQuery, type QuerySyntax } from "../query";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	classifyProviderHttpError,
	normalizeHttpUrl,
	normalizeSearchText,
	readLimitedText,
	withHardTimeout,
} from "./utils";

/** The tool's own input limit, in characters. */
const MAX_QUERY_CHARS = 200;
/** The tool returns one fixed-size page; larger requests are not possible. */
const MAX_NUM_RESULTS = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

/** Operators the Kiro search backend applies; dates stay with the central filter. */
const KIRO_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, site: true, filetype: true };

interface KiroSearchResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	/** Epoch milliseconds, or null when the page has no date. */
	publishedDate?: unknown;
}

async function callKiroSearch(key: string, query: string, params: SearchParams): Promise<unknown[]> {
	const credential = decodeKiroCredential(key);
	if (!credential.region) {
		throw new SearchProviderError("kiro", "Kiro web search needs the API key's region; set KIRO_API_REGION");
	}
	const id = crypto.randomUUID();
	const response = await (params.fetch ?? fetch)(`${kiroRuntimeBaseUrl(credential.region)}mcp`, {
		method: "POST",
		headers: kiroCliMcpHeaders(credential.token, credential.kind === "oauth" ? credential.profileArn : undefined),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: "web_search", arguments: { query } },
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "kiro", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("kiro", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"kiro",
			`Kiro web search error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(await readLimitedText(response, "kiro", MAX_RESPONSE_BYTES));
	} catch {
		throw new SearchProviderError("kiro", "Kiro web search returned invalid JSON", 500);
	}
	if (!isRecord(payload) || payload.id !== id) {
		throw new SearchProviderError("kiro", "Kiro web search returned a mismatched JSON-RPC response", 500);
	}
	const result = payload.result;
	if (isRecord(payload.error) || !isRecord(result) || result.isError === true) {
		const message = isRecord(payload.error) ? normalizeSearchText(payload.error.message) : undefined;
		throw new SearchProviderError("kiro", `Kiro web search was rejected${message ? `: ${message}` : ""}`);
	}
	// The tool answers with JSON text content; `structuredContent` is preferred when present.
	let data = result.structuredContent;
	if (!isRecord(data) && Array.isArray(result.content)) {
		const text = result.content.find(part => isRecord(part) && part.type === "text");
		try {
			data = isRecord(text) && typeof text.text === "string" ? JSON.parse(text.text) : undefined;
		} catch {}
	}
	if (!isRecord(data) || !Array.isArray(data.results)) {
		throw new SearchProviderError("kiro", "Kiro web search returned an unexpected response shape", 500);
	}
	return data.results;
}

/** Execute Kiro web search. */
export async function searchKiro(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, KIRO_QUERY_SYNTAX) : params.query;
	if ([...query].length > MAX_QUERY_CHARS) {
		throw new SearchProviderError(
			"kiro",
			`Kiro web search queries are limited to ${MAX_QUERY_CHARS} characters`,
			400,
		);
	}
	const limit = clampNumResults(params.numSearchResults ?? params.limit, MAX_NUM_RESULTS, MAX_NUM_RESULTS);
	const keyResolver = params.authStorage.keys.resolver("kiro", { sessionId: params.sessionId });
	const key = await resolveApiKeyOnce(keyResolver, params.signal);
	if (!key) {
		throw new SearchProviderError("kiro", "Kiro credentials not found. Run /login kiro or set KIRO_API_KEY.");
	}
	// Reuse the preflight credential, then let withAuth refresh / rotate on 401/402.
	const results = await withAuth(seedApiKeyResolver(key, keyResolver), k => callKiroSearch(k, query, params), {
		signal: params.signal,
	});

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const entry of results) {
		if (!isRecord(entry)) continue;
		const result = entry as KiroSearchResult;
		const url = normalizeHttpUrl(result.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const published =
			typeof result.publishedDate === "number" && Number.isFinite(result.publishedDate) && result.publishedDate > 0
				? new Date(result.publishedDate).toISOString()
				: undefined;
		sources.push({
			title: normalizeSearchText(result.title) ?? url,
			url,
			snippet: normalizeSearchText(result.snippet),
			publishedDate: published,
			ageSeconds: dateToAgeSeconds(published),
		});
	}

	return {
		provider: "kiro",
		sources: sources.slice(0, limit),
		authMode: decodeKiroCredential(key).kind === "api_key" ? "api_key" : "oauth",
	};
}

/** Search provider for Kiro web search. */
export class KiroProvider extends SearchProvider {
	readonly id = "kiro";
	readonly label = "Kiro";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("kiro") !== undefined;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchKiro(params);
	}
}
