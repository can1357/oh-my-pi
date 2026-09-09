/**
 * Exa Web Search Provider
 *
 * High-quality neural search via Exa Search API.
 * Returns structured search results with optional content extraction.
 * Requests per-result summaries via `contents.summary` and synthesizes
 * them into a combined `answer` string on the SearchResponse.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { getDefault, settings } from "../../../config/settings";
import { findApiKey, isSearchResponse } from "../../../exa/mcp-client";
import { parseSSE } from "../../../mcp/json-rpc";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type StructuredQuery } from "../query";
import { dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const EXA_API_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_MCP_SOURCE = "oh-my-pi";
const MAX_EXA_SNIPPET_CHARS = 500;
const DEFAULT_EXA_SEARCH_DELAY_MS = getDefault("exa.searchDelayMs");

let nextExaSearchRequestAt = 0;
let exaSearchThrottle = Promise.resolve();

function configuredExaSearchDelayMs(): number {
	try {
		const delayMs = settings.get("exa.searchDelayMs");
		return Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0;
	} catch {
		return DEFAULT_EXA_SEARCH_DELAY_MS;
	}
}

function rejectWithAbortReason(reject: (reason?: unknown) => void, signal: AbortSignal): void {
	try {
		signal.throwIfAborted();
		reject(new DOMException("The operation was aborted.", "AbortError"));
	} catch (error) {
		reject(error);
	}
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
		if (signal) rejectWithAbortReason(reject, signal);
	};
	timer = setTimeout(() => {
		cleanup();
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return promise;
}

function waitUntilDoneOrAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => rejectWithAbortReason(reject, signal);
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

async function waitForExaSearchSlot(signal: AbortSignal | undefined): Promise<void> {
	const delayMs = configuredExaSearchDelayMs();
	if (delayMs <= 0) return;

	const prior = exaSearchThrottle.catch(() => {});
	const queued = prior.then(async () => {
		signal?.throwIfAborted();
		const waitMs = Math.max(0, nextExaSearchRequestAt - Date.now());
		if (waitMs > 0) {
			await abortableSleep(waitMs, signal);
		}
		signal?.throwIfAborted();
		nextExaSearchRequestAt = Date.now() + delayMs;
	});
	exaSearchThrottle = queued.catch(() => {});
	await waitUntilDoneOrAborted(queued, signal);
}

/** Reset Exa request pacing state for isolated provider tests. */
export function resetExaSearchThrottleForTest(): void {
	nextExaSearchRequestAt = 0;
	exaSearchThrottle = Promise.resolve();
}

type ExaSearchType = "neural" | "fast" | "auto" | "deep";

type ExaSearchParamType = ExaSearchType | "keyword";

export interface ExaSearchParams {
	query: string;
	num_results?: number;
	type?: ExaSearchParamType;
	include_domains?: string[];
	exclude_domains?: string[];
	start_published_date?: string;
	end_published_date?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
	/**
	 * Credential source. Resolved before falling back to `EXA_API_KEY` so
	 * Exa works when the key is stored via the broker/auth pipeline.
	 */
	authStorage?: AuthStorage;
	sessionId?: string;
}

interface ExaSearchResult {
	title?: string | null;
	url?: string | null;
	author?: string | null;
	publishedDate?: string | null;
	text?: string | null;
	highlights?: string[] | null;
	summary?: string | null;
}

interface ExaSearchResponse {
	requestId?: string;
	resolvedSearchType?: string;
	results?: ExaSearchResult[];
	costDollars?: { total: number };
	searchTime?: number;
}
function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

function parseJsonContent(text: string): unknown | null {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function normalizeExaMcpPayload(payload: unknown): unknown {
	const candidates: unknown[] = [];
	const root = asRecord(payload);

	if (root) {
		if (root.structuredContent !== undefined) candidates.push(root.structuredContent);
		if (root.data !== undefined) candidates.push(root.data);
		if (root.result !== undefined) candidates.push(root.result);
		candidates.push(root);

		const content = root.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				const part = asRecord(item);
				if (!part) continue;
				const text = part.text;
				if (typeof text !== "string" || text.trim().length === 0) continue;
				const parsed = parseJsonContent(text);
				if (parsed !== null) candidates.push(parsed);
			}
		}
	} else {
		candidates.push(payload);
	}

	for (const candidate of candidates) {
		if (isSearchResponse(candidate)) {
			return candidate;
		}
	}

	return payload;
}

function parseOptionalField(section: string, label: string): string | null | undefined {
	const regex = new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]*)`);
	const match = section.match(regex);
	if (!match) return undefined;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

function parseTextField(section: string): string | null | undefined {
	const match = section.match(/(?:^|\n)Text:\s*([\s\S]*)$/);
	if (!match) return undefined;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

function parseExaMcpTextPayload(payload: unknown): ExaSearchResponse | null {
	const root = asRecord(payload);
	if (!root) return null;

	const content = root.content;
	if (!Array.isArray(content)) return null;

	const textBlocks = content
		.map(item => {
			const part = asRecord(item);
			const text = typeof part?.text === "string" ? part.text : "";
			return text.replace(/\r\n?/g, "\n").trim();
		})
		.filter(text => text.length > 0);

	if (textBlocks.length === 0) return null;

	const sections = textBlocks
		.join("\n\n")
		.split(/\n{2,}(?=Title:\s*[^\n]*(?:\n(?:URL|Author|Published Date|Text):))/)
		.map(section => section.trim())
		.filter(section => section.startsWith("Title:"));

	const results: ExaSearchResult[] = [];
	for (const section of sections) {
		const title = parseOptionalField(section, "Title");
		const url = parseOptionalField(section, "URL");
		const author = parseOptionalField(section, "Author");
		const publishedDate = parseOptionalField(section, "Published Date");
		const text = parseTextField(section);

		if (!title && !url && !text) continue;

		results.push({
			title: title ?? undefined,
			url: url ?? undefined,
			author: author ?? undefined,
			publishedDate: publishedDate ?? undefined,
			text: text ?? undefined,
		});
	}

	if (results.length === 0) return null;
	return { results };
}

export function normalizeSearchType(type: ExaSearchParamType | undefined): ExaSearchType {
	if (!type) return "auto";
	if (type === "keyword") return "fast";
	return type;
}

/** Maximum number of per-result summaries to include in the synthesized answer. */
const MAX_ANSWER_SUMMARIES = 3;

/**
 * Synthesize an answer string from per-result summaries returned by Exa.
 * Returns `undefined` when no non-empty summaries are available so callers
 * can leave `SearchResponse.answer` unset (matching other providers).
 */
export function synthesizeAnswer(results: ExaSearchResult[]): string | undefined {
	const parts: string[] = [];
	for (const r of results) {
		if (parts.length >= MAX_ANSWER_SUMMARIES) break;
		const summary = r.summary?.trim();
		if (!summary) continue;
		const title = r.title?.trim() || r.url || "Untitled";
		parts.push(`**${title}**: ${summary}`);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Build the request body for `callExaSearch`. Exported for testing. */
export function buildExaRequestBody(params: ExaSearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		numResults: params.num_results ?? 10,
		type: normalizeSearchType(params.type),
		contents: {
			summary: { query: params.query },
		},
	};

	if (params.include_domains?.length) {
		body.includeDomains = params.include_domains;
	}
	if (params.exclude_domains?.length) {
		body.excludeDomains = params.exclude_domains;
	}
	if (params.start_published_date) {
		body.startPublishedDate = params.start_published_date;
	}
	if (params.end_published_date) {
		body.endPublishedDate = params.end_published_date;
	}

	return body;
}

/** Call Exa Search API */
async function callExaSearch(apiKey: string, params: ExaSearchParams): Promise<ExaSearchResponse> {
	const body = buildExaRequestBody(params);

	const fetchImpl = params.fetch ?? fetch;
	await waitForExaSearchSlot(params.signal);
	const response = await fetchImpl(EXA_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("exa", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("exa", `Exa API error (${response.status}): ${errorText}`, response.status);
	}

	return response.json() as Promise<ExaSearchResponse>;
}
function buildExaMcpArgs(params: ExaSearchParams): Record<string, unknown> {
	const queryParts = [params.query];
	for (const domain of params.include_domains ?? []) {
		const trimmed = domain.trim();
		if (trimmed) queryParts.push(`site:${trimmed}`);
	}
	for (const domain of params.exclude_domains ?? []) {
		const trimmed = domain.trim();
		if (trimmed) queryParts.push(`-site:${trimmed}`);
	}
	if (params.start_published_date) queryParts.push(`after:${params.start_published_date}`);
	if (params.end_published_date) queryParts.push(`before:${params.end_published_date}`);

	const args: Record<string, unknown> = { query: queryParts.join(" ") };
	if (params.num_results !== undefined) args.numResults = params.num_results;
	return args;
}

async function callExaMcpSearch(params: ExaSearchParams): Promise<ExaSearchResponse> {
	const query = new URLSearchParams();
	const apiKey = findApiKey();
	if (apiKey) query.set("exaApiKey", apiKey);
	query.set("tools", "web_search_exa");
	const fetchImpl = params.fetch ?? fetch;
	await waitForExaSearchSlot(params.signal);
	const response = await fetchImpl(`${EXA_MCP_URL}?${query.toString()}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"x-exa-source": EXA_MCP_SOURCE,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Math.random().toString(36).slice(2),
			method: "tools/call",
			params: {
				name: "web_search_exa",
				arguments: buildExaMcpArgs(params),
			},
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("exa", response.status, errorText);
		if (classified) throw classified;
		if (response.status === 429) {
			throw new SearchProviderError(
				"exa",
				"exa: MCP rate limit reached (429); configure an Exa API key for higher limits",
				response.status,
			);
		}
		throw new SearchProviderError(
			"exa",
			`Exa MCP request failed (${response.status}): ${errorText}`,
			response.status,
		);
	}
	const mcpResponse = parseSSE(await response.text()) as {
		result?: {
			content?: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
		error?: {
			code: number;
			message: string;
		};
	} | null;
	if (!mcpResponse) {
		throw new Error("Failed to parse MCP response");
	}
	if (mcpResponse.error) {
		throw new Error(`MCP error: ${mcpResponse.error.message}`);
	}
	if (mcpResponse.result?.isError) {
		const message = mcpResponse.result.content
			?.find(item => item.type === "text" && typeof item.text === "string")
			?.text?.trim();
		throw new SearchProviderError("exa", message || "Exa MCP returned an error");
	}
	const responsePayload = normalizeExaMcpPayload(mcpResponse.result);
	if (isSearchResponse(responsePayload)) {
		return responsePayload as ExaSearchResponse;
	}

	const parsed = parseExaMcpTextPayload(responsePayload);
	if (parsed) {
		return parsed;
	}

	throw new Error("Exa MCP search returned unexpected response shape.");
}

/** Execute Exa web search */
export async function searchExa(params: ExaSearchParams): Promise<SearchResponse> {
	// AuthStorage-backed key takes precedence (existing behavior); probe it once
	// so the env-key and keyless-MCP fallbacks below stay intact, then drive the
	// authStorage path through the central force-refresh/rotate retry policy.
	const storedKey = params.authStorage
		? await params.authStorage.getApiKey("exa", params.sessionId, { signal: params.signal })
		: undefined;
	const keyOrResolver: ApiKey | undefined =
		storedKey && params.authStorage
			? params.authStorage.resolver("exa", { sessionId: params.sessionId })
			: getEnvApiKey("exa");
	const response = keyOrResolver
		? await withAuth(keyOrResolver, key => callExaSearch(key, params), { signal: params.signal })
		: await callExaMcpSearch(params);

	// Convert to unified SearchResponse
	const sources: SearchSource[] = [];

	if (response.results) {
		for (const result of response.results) {
			if (!result.url) continue;
			sources.push({
				title: result.title ?? result.url,
				url: result.url,
				snippet: (result.summary || result.text || result.highlights?.join(" ") || undefined)?.slice(
					0,
					MAX_EXA_SNIPPET_CHARS,
				),
				publishedDate: result.publishedDate ?? undefined,
				ageSeconds: dateToAgeSeconds(result.publishedDate ?? undefined),
				author: result.author ?? undefined,
			});
		}
	}

	// Apply num_results limit if specified
	const limitedSources = params.num_results ? sources.slice(0, params.num_results) : sources;

	// Synthesize answer only from results that have a URL (same guard as sources loop)
	const answer = response.results ? synthesizeAnswer(response.results.filter(r => !!r.url)) : undefined;

	return {
		provider: "exa",
		answer,
		sources: limitedSources,
		requestId: response.requestId,
	};
}

/** Search provider for Exa. */
export class ExaProvider extends SearchProvider {
	readonly id = "exa";
	readonly label = "Exa";

	isAvailable(authStorage: AuthStorage): boolean {
		if (!this.#settingsAllowSearch()) return false;
		return !!getEnvApiKey("exa") || authStorage.hasAuth("exa");
	}

	/**
	 * Exa ships an unauthenticated public MCP fallback, so an explicit
	 * selection (programmatic or via `providers.webSearch: exa`) routes
	 * through MCP even when no credential is configured. The auto chain
	 * still uses {@link isAvailable} so an unrelated configured provider
	 * keeps priority over the public fallback.
	 */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return this.#settingsAllowSearch();
	}

	#settingsAllowSearch(): boolean {
		try {
			if (settings.get("exa.enabled") === false) {
				return false;
			}
		} catch {
			// Settings may be unavailable before CLI initialization; assume not disabled.
		}
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
		return searchExa({
			...directiveParams(parsed),
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
		});
	}
}

/**
 * Map parsed query directives onto Exa's native request parameters:
 * `site:` → includeDomains, `-site:` → excludeDomains (bare hosts; path parts
 * are enforced by the central constraint filter), `after:`/`before:` →
 * start/endPublishedDate (ISO 8601). Exa's neural search prefers natural
 * language, so the query itself is re-emitted with quoted phrases only.
 * Directive-free queries pass through byte-identical.
 */
function directiveParams(
	parsed: StructuredQuery,
): Pick<
	ExaSearchParams,
	"query" | "include_domains" | "exclude_domains" | "start_published_date" | "end_published_date"
> {
	if (!parsed.hasDirectives) return { query: parsed.raw };
	const hosts = (sites: readonly string[]) => [...new Set(sites.map(site => site.split("/", 1)[0]))];
	return {
		query: formatQuery(parsed, { phrases: true }),
		include_domains: parsed.sites.length ? hosts(parsed.sites) : undefined,
		exclude_domains: parsed.excludedSites.length ? hosts(parsed.excludedSites) : undefined,
		start_published_date: parsed.after,
		end_published_date: parsed.before,
	};
}
