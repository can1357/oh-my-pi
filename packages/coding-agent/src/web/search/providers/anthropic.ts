/**
 * Anthropic Web Search Provider
 *
 * Uses Claude's server-side web_search tool (web_search_20250305) to search the web.
 * Returns synthesized answers with citations and source metadata.
 */
import {
	type AnthropicSystemBlock,
	type Api,
	type ApiKey,
	type AuthStorage,
	buildAnthropicAuthConfig,
	buildAnthropicSearchHeaders,
	buildAnthropicUrl,
	type FetchImpl,
	type Model,
	resolveAnthropicMetadataUserId,
	stripClaudeToolPrefix,
	withAuth,
} from "@oh-my-pi/pi-ai";
import {
	buildAnthropicSystemBlocks,
	buildGitHubCopilotAnthropicHeaders,
	wrapFetchForCch,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { normalizeAnthropicBaseUrl } from "@oh-my-pi/pi-ai/providers/anthropic-state";
import {
	buildCopilotDynamicHeaders,
	getCachedCopilotIntegrationId,
	getCopilotIntegrationCacheKey,
	resolveCopilotRequestIdentity,
	resolveGitHubCopilotBaseUrl,
	wrapFetchForCopilotFallback,
} from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import {
	anthropicApiVersionAcceptsSamplingParams,
	isOfficialAnthropicApiUrl,
	resolveAnthropicApiVersion,
} from "@oh-my-pi/pi-catalog/compat/anthropic";
import { fallbackCreditTargets } from "@oh-my-pi/pi-catalog/compat/fallback-credit";
import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { $env } from "@oh-my-pi/pi-utils";
// The model decides whether to search and answers from its weights when a query
// reads as stable knowledge; a search backend must always search.
import searchInstruction from "../../../prompts/system/web-search-anthropic.md" with { type: "text" };
import type { AnthropicApiResponse, AnthropicCitation } from "../../../web/search/types";
import type { SearchCitation, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { parseSearchQuery, type StructuredQuery } from "../query";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_MAX_TOKENS = 4096;
const WEB_SEARCH_TOOL_NAME = "web_search";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
/**
 * Server-side refusal fallback (`fallbacks: "default"`): when a model's safety
 * classifier declines, the API retries on the model Anthropic recommends for
 * the refusal category and returns that model's answer in the same response
 * (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
 */
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Upstream request shape derived from the parsed query. */
interface AnthropicQueryPlan {
	query: string;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

/**
 * Map `site:` includes onto `allowed_domains` and `-site:` exclusions onto
 * `blocked_domains` (mutually exclusive on the API, so exclusions are only
 * sent when there are no includes). Filters take bare hosts (subdomains
 * included automatically); any path part of a `site:` value is enforced by the
 * central constraint filter. The query text itself goes to Claude unchanged:
 * it writes its own searches, and stripping `site:` would hide what the query
 * is about (`site:github.com/org/repo/file.c "fn"` would reach it as `"fn"`).
 */
function planQuery(rawQuery: string, parsed: StructuredQuery): AnthropicQueryPlan {
	if (!parsed.hasDirectives) return { query: rawQuery };
	const hosts = (sites: readonly string[]) => {
		const unique = new Set<string>();
		for (const site of sites) {
			const slash = site.indexOf("/");
			const host = slash === -1 ? site : site.slice(0, slash);
			if (host.length > 0) unique.add(host);
		}
		return [...unique];
	};
	const allowed = hosts(parsed.sites);
	const blocked = allowed.length === 0 ? hosts(parsed.excludedSites) : [];
	return {
		query: rawQuery,
		allowedDomains: allowed.length > 0 ? allowed : undefined,
		blockedDomains: blocked.length > 0 ? blocked : undefined,
	};
}

/**
 * Builds system instruction blocks for the Anthropic API request.
 * @param isOAuth - Whether the request uses Claude Code OAuth shaping
 * @param injectClaudeCodeInstruction - Catalog policy for OAuth system fingerprinting
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Array of system blocks for the API request
 */
function buildSystemBlocks(
	isOAuth: boolean,
	injectClaudeCodeInstruction: boolean,
	systemPrompt?: string,
): AnthropicSystemBlock[] | undefined {
	// Match the streaming path: the CC billing header + system instruction are
	// an OAuth fingerprint and must not be claimed on API-key requests.
	const includeClaudeCode = isOAuth && injectClaudeCodeInstruction;
	const extraInstructions = isOAuth
		? ["You are a helpful AI assistant with web search capabilities.", searchInstruction]
		: [searchInstruction];

	return buildAnthropicSystemBlocks(systemPrompt ? [systemPrompt] : undefined, {
		includeClaudeCodeInstruction: includeClaudeCode,
		extraInstructions,
	});
}

/** Where and how one search request is sent for the selected model's backend. */
interface AnthropicSearchEndpoint {
	url: string;
	/** Effective base URL; selects the API version that gates sampling parameters. */
	baseUrl: string;
	headers: Record<string, string>;
	/** Claude Code OAuth shaping: system fingerprint and metadata.user_id. */
	isOAuth: boolean;
	/** Runs Anthropic's server-side refusal fallback chain. */
	serverSideFallback: boolean;
	fetch: FetchImpl;
}

/**
 * Resolve the endpoint, headers and fetch for a search request. GitHub Copilot
 * goes through the streaming path's Copilot helpers: its OAuth key is a JSON
 * envelope carrying the token and the (enterprise) API endpoint, and its proxy
 * rejects Anthropic's beta set and Claude Code fingerprint headers.
 */
function resolveSearchEndpoint(
	key: string,
	model: Model<Api>,
	configuredHeaders: Record<string, string> | undefined,
	query: string,
	sessionId: string | undefined,
	fetchImpl: FetchImpl,
): AnthropicSearchEndpoint {
	if (model.provider === "github-copilot") {
		const baseUrl =
			normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, key) ?? model.baseUrl) ?? model.baseUrl;
		const cacheKey = getCopilotIntegrationCacheKey(key, baseUrl);
		const cachedIntegrationId = getCachedCopilotIntegrationId(cacheKey);
		const integrationId = resolveCopilotRequestIdentity();
		// A search is a tool call the agent made, not a user turn.
		const dynamicHeaders = buildCopilotDynamicHeaders({
			messages: [{ role: "user", content: query }],
			hasImages: false,
			premiumMultiplier: model.premiumMultiplier,
			headers: configuredHeaders,
			integrationId,
			initiatorOverride: "agent",
			enterpriseUrl: parseGitHubCopilotApiKey(key).enterpriseUrl,
			cachedIntegrationId,
		});
		return {
			url: `${baseUrl}/v1/messages`,
			baseUrl,
			// The model's configured headers sit below the dynamic Copilot headers, as in
			// streaming, so a catalog `Copilot-Integration-Id` cannot override the resolved one.
			headers: buildGitHubCopilotAnthropicHeaders({
				model: { ...model, headers: configuredHeaders },
				apiKey: key,
				baseUrl,
				stream: false,
				dynamicHeaders: dynamicHeaders.headers,
				sessionId,
			}),
			isOAuth: false,
			serverSideFallback: false,
			fetch: wrapFetchForCopilotFallback(fetchImpl, true, integrationId, cacheKey, cachedIntegrationId ?? null),
		};
	}

	const auth = buildAnthropicAuthConfig(key, model.baseUrl, { isOAuth: model.isOAuth });
	// Only Anthropic's own endpoint runs the fallback chain, and only models with
	// a refusal classifier have targets to fall back to (Haiku 5.5 has none).
	const serverSideFallback = isOfficialAnthropicApiUrl(auth.baseUrl) && fallbackCreditTargets(model).length > 0;
	const headers = buildAnthropicSearchHeaders(auth, {
		modelHeaders: configuredHeaders,
		allowAnthropicHeaderOverrides:
			model.compat !== undefined &&
			"allowAnthropicHeaderOverrides" in model.compat &&
			model.compat.allowAnthropicHeaderOverrides === true,
		extraBetas: serverSideFallback ? [SERVER_SIDE_FALLBACK_BETA] : undefined,
		provider: model.provider,
		providerType: model.providerType,
		additiveSessionHeader:
			model.compat !== undefined && "additiveSessionHeader" in model.compat
				? model.compat.additiveSessionHeader
				: undefined,
		sessionId,
	});
	return {
		url: buildAnthropicUrl(auth),
		baseUrl: auth.baseUrl,
		headers,
		isOAuth: auth.isOAuth,
		serverSideFallback,
		// OAuth requests inject the CC billing header (buildSystemBlocks); patch its
		// cch attestation like the streaming path instead of shipping `cch=00000`.
		fetch: auth.isOAuth ? wrapFetchForCch(fetchImpl) : fetchImpl,
	};
}

/**
 * Calls the Anthropic API with web search tool enabled.
 * @param endpoint - Resolved endpoint, headers and fetch for the selected backend
 * @param model - Selected catalog model
 * @param plan - Query text plus native domain filters derived from parsed directives
 * @param metadataUserId - Optional Anthropic Messages metadata.user_id (already shaped for OAuth)
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Raw API response from Anthropic
 * @throws {SearchProviderError} If the API request fails
 */
async function callSearch(
	endpoint: AnthropicSearchEndpoint,
	model: Model<Api>,
	plan: AnthropicQueryPlan,
	metadataUserId?: string,
	systemPrompt?: string,
	maxTokens?: number,
	temperature?: number,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<AnthropicApiResponse> {
	const { url, headers, serverSideFallback } = endpoint;
	const injectClaudeCodeInstruction =
		model.compat === undefined ||
		!("injectClaudeCodeInstruction" in model.compat) ||
		model.compat.injectClaudeCodeInstruction !== false;
	const systemBlocks = buildSystemBlocks(endpoint.isOAuth, injectClaudeCodeInstruction, systemPrompt);

	const body: Record<string, unknown> = {
		model: model.id,
		max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{ role: "user", content: plan.query }],
		tools: [
			{
				type: WEB_SEARCH_TOOL_TYPE,
				name: WEB_SEARCH_TOOL_NAME,
				...(plan.allowedDomains ? { allowed_domains: plan.allowedDomains } : {}),
				...(plan.blockedDomains ? { blocked_domains: plan.blockedDomains } : {}),
			},
		],
	};
	if (serverSideFallback) body.fallbacks = "default";

	if (metadataUserId) {
		body.metadata = { user_id: metadataUserId };
	}

	// Sampling restrictions come from the resolved catalog policy; API version
	// 2026-10-21 also rejects sampling parameters for otherwise compatible models.
	if (
		temperature !== undefined &&
		(model.compat === undefined ||
			!("supportsSamplingParams" in model.compat) ||
			model.compat.supportsSamplingParams !== false) &&
		anthropicApiVersionAcceptsSamplingParams(resolveAnthropicApiVersion(endpoint.baseUrl))
	) {
		body.temperature = temperature;
	}

	if (systemBlocks && systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	const response = await endpoint.fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("anthropic", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"anthropic",
			`Anthropic API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return response.json() as Promise<AnthropicApiResponse>;
}

/**
 * Parses a human-readable page age string into seconds.
 * @param pageAge - Age string like "2 days ago", "3h ago", "1 week ago"
 * @returns Age in seconds, or undefined if parsing fails
 */
function parsePageAge(pageAge: string | null | undefined): number | undefined {
	if (!pageAge) return undefined;

	const match = pageAge.match(/^(\d+)\s*(s|sec|second|m|min|minute|h|hour|d|day|w|week|mo|month|y|year)s?\s*(ago)?$/i);
	if (!match) return undefined;

	const value = parseInt(match[1], 10);
	const unit = match[2].toLowerCase();

	const multipliers: Record<string, number> = {
		s: 1,
		sec: 1,
		second: 1,
		m: 60,
		min: 60,
		minute: 60,
		h: 3600,
		hour: 3600,
		d: 86400,
		day: 86400,
		w: 604800,
		week: 604800,
		mo: 2592000,
		month: 2592000,
		y: 31536000,
		year: 31536000,
	};

	return value * (multipliers[unit] ?? 86400);
}

/**
 * Parses the Anthropic API response into a unified SearchResponse.
 * @param response - Raw API response containing content blocks
 * @returns Normalized response with answer, sources, citations, and usage
 * @throws {SearchProviderError} When no results came back because the safety
 *   classifier declined the query or every search failed
 */
function parseResponse(response: AnthropicApiResponse): SearchResponse {
	// Citations split continuous text into adjacent text blocks; insert a paragraph
	// break only when non-empty text resumes after a non-text block.
	let answer = "";
	let previousWasText = false;
	const searchQueries: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const toolErrors = new Set<string>();

	for (const block of response.content) {
		if (block.type !== "text") previousWasText = false;
		if (
			block.type === "server_tool_use" &&
			block.name &&
			stripClaudeToolPrefix(block.name) === WEB_SEARCH_TOOL_NAME
		) {
			// Intermediate search query
			if (block.input?.query) {
				searchQueries.push(block.input.query);
			}
		} else if (block.type === "web_search_tool_result" && block.content) {
			// A failed search carries one error object instead of a result list.
			if (!Array.isArray(block.content)) {
				toolErrors.add(block.content.error_code);
				continue;
			}
			for (const result of block.content) {
				if (result.type === "web_search_result") {
					sources.push({
						title: result.title,
						url: result.url,
						snippet: undefined,
						publishedDate: result.page_age ?? undefined,
						ageSeconds: parsePageAge(result.page_age),
					});
				}
			}
		} else if (block.type === "text" && block.text) {
			// Synthesized answer with citations
			if (answer && !previousWasText) answer += "\n\n";
			answer += block.text;
			previousWasText = true;
			if (block.citations) {
				for (const c of block.citations as AnthropicCitation[]) {
					citations.push({
						url: c.url,
						title: c.title,
						citedText: c.cited_text,
					});
				}
			}
		}
	}

	// A classifier decline (before or mid-output) leaves any text incomplete;
	// Anthropic says to discard it. Results it already searched stay usable, and
	// the answer says why it is missing.
	if (response.stop_reason === "refusal") {
		const category = response.stop_details?.category ?? "uncategorized";
		const explanation = response.stop_details?.explanation;
		const refusal = `${response.model} declined the query (${category} safety classifier)${explanation ? `: ${explanation}` : "."}`;
		if (sources.length === 0) throw new SearchProviderError("anthropic", refusal);
		answer = `${refusal} The results it found before declining follow.`;
		citations.length = 0;
	} else if (sources.length === 0 && toolErrors.size > 0) {
		throw new SearchProviderError("anthropic", `Anthropic web search failed: ${[...toolErrors].join(", ")}.`);
	}

	// Top-level usage counts only the attempt that served the turn; a refusal
	// fallback's declined attempt appears only in `iterations`.
	const iterations = response.usage.iterations;
	const usage =
		iterations && iterations.length > 0
			? {
					input: iterations.reduce((sum, entry) => sum + entry.input_tokens, 0),
					output: iterations.reduce((sum, entry) => sum + entry.output_tokens, 0),
				}
			: { input: response.usage.input_tokens, output: response.usage.output_tokens };

	return {
		provider: "anthropic",
		answer: answer || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		usage: {
			inputTokens: usage.input,
			outputTokens: usage.output,
			searchRequests: response.usage.server_tool_use?.web_search_requests,
		},
		model: response.model,
		requestId: response.id,
	};
}

/**
 * Executes a web search using Anthropic's Claude with built-in web search tool.
 * @param params - Search parameters including query and optional settings
 * @returns Search response with synthesized answer, sources, and citations
 * @throws {Error} If no Anthropic credentials are configured
 */
export async function searchAnthropic(params: SearchParams): Promise<SearchResponse> {
	const registryResolver = params.modelRegistry.resolver(params.model, params.sessionId);
	const searchApiKey = params.model.provider === "anthropic" ? $env.ANTHROPIC_SEARCH_API_KEY : undefined;
	const keyOrResolver: ApiKey = searchApiKey
		? async context => {
				if (context.error === undefined && !context.lastChance) return searchApiKey;
				return (await registryResolver(context)) ?? searchApiKey;
			}
		: registryResolver;
	const accountId = params.authStorage.oauth.identity(params.model.provider, params.sessionId)?.accountId;
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const plan = planQuery(params.query, parsed);
	const response = await withAuth(
		keyOrResolver,
		async key => {
			const configuredHeaders = await params.modelRegistry.resolveModelHeaders(params.model, params.signal);
			const endpoint = resolveSearchEndpoint(
				key,
				params.model,
				configuredHeaders,
				plan.query,
				params.sessionId,
				params.fetch ?? fetch,
			);
			// Mirror the main Messages path: OAuth requests need a Claude-Code-shaped
			// metadata.user_id (`{session_id, account_uuid?, device_id}`) so the
			// CC billing header + system fingerprint installed by
			// `buildAnthropicSearchHeaders`/`buildSystemBlocks` line up with the
			// attribution Anthropic and enterprise gateways expect. API-key tokens
			// forward the raw session id verbatim.
			const metadataUserId = resolveAnthropicMetadataUserId(
				params.sessionId,
				endpoint.isOAuth,
				params.sessionId,
				accountId,
			);
			return callSearch(
				endpoint,
				params.model,
				plan,
				metadataUserId,
				params.systemPrompt,
				params.maxOutputTokens,
				params.temperature,
				params.signal,
				params.timeoutMs,
			);
		},
		{
			signal: params.signal,
			missingKeyMessage: `Anthropic credentials not found for selected provider "${params.model.provider}".`,
		},
	);

	const result = parseResponse(response);

	const numResults = params.numSearchResults ?? params.limit;
	if (numResults && result.sources.length > numResults) {
		result.sources = result.sources.slice(0, numResults);
	}

	return result;
}

/** Search provider for Anthropic Claude web search. */
export class AnthropicProvider extends SearchProvider {
	readonly id = "anthropic";
	readonly label = "Anthropic";

	isAvailable(authStorage: AuthStorage, model?: Model<Api>): Promise<boolean> | boolean {
		if (model) {
			return (
				authStorage.keys.source(model.provider) !== undefined ||
				(model.provider === "anthropic" && Boolean($env.ANTHROPIC_SEARCH_API_KEY))
			);
		}
		return Boolean($env.ANTHROPIC_SEARCH_API_KEY) || authStorage.keys.source("anthropic") !== undefined;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnthropic(params);
	}
}
