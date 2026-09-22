/**
 * Anthropic Web Search Provider
 *
 * Uses Claude's built-in web_search_20250305 tool to search the web.
 * Returns synthesized answers with citations and source metadata.
 */
import {
	type AnthropicAuthConfig,
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
import { buildAnthropicSystemBlocks, wrapFetchForCch } from "@oh-my-pi/pi-ai/providers/anthropic";
import { compareRevision, parseRevision } from "@oh-my-pi/pi-catalog/identity";
import { $env } from "@oh-my-pi/pi-utils";
import type { AnthropicApiResponse, AnthropicCitation } from "../../../web/search/types";
import type { SearchCitation, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

function hasSamplingRestrictions(model: Model<Api>): boolean {
	const identity = model.identity;
	if (identity.class !== "anthropic" || identity.revision === undefined) return false;
	const revision = parseRevision(identity.revision);
	const floor = parseRevision(identity.family === "opus" ? "4.7" : "5");
	return (
		revision !== undefined &&
		floor !== undefined &&
		(identity.family === "opus" ||
			identity.family === "sonnet" ||
			identity.family === "fable" ||
			identity.family === "mythos") &&
		compareRevision(revision, floor) >= 0
	);
}

const DEFAULT_MAX_TOKENS = 4096;
const WEB_SEARCH_TOOL_NAME = "web_search";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

/**
 * Claude's search backend understands common Google-style operators, so most
 * directives are re-emitted as query text. `site:` is intentionally absent:
 * site includes/excludes map onto the web_search tool's native
 * `allowed_domains`/`blocked_domains` parameters instead.
 */
const ANTHROPIC_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
	dateRange: true,
};

/** Upstream request shape derived from the parsed query. */
interface AnthropicQueryPlan {
	query: string;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

/**
 * Map parsed directives onto the request: `site:` includes become
 * `allowed_domains`, `-site:` exclusions become `blocked_domains` (the two are
 * mutually exclusive on the API, so exclusions are only sent when there are no
 * includes), and remaining directives are re-emitted as query syntax.
 * Directive-free queries pass through byte-identical. Anthropic domain
 * filters take bare hosts (subdomains included automatically); any path part
 * of a `site:` value is enforced by the central constraint filter.
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
		query: formatQuery(parsed, ANTHROPIC_QUERY_SYNTAX),
		allowedDomains: allowed.length > 0 ? allowed : undefined,
		blockedDomains: blocked.length > 0 ? blocked : undefined,
	};
}

/**
 * Builds system instruction blocks for the Anthropic API request.
 * @param auth - Authentication configuration
 * @param injectClaudeCodeInstruction - Catalog policy for OAuth system fingerprinting
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Array of system blocks for the API request
 */
function buildSystemBlocks(
	auth: AnthropicAuthConfig,
	injectClaudeCodeInstruction: boolean,
	systemPrompt?: string,
): AnthropicSystemBlock[] | undefined {
	// Match the streaming path: the CC billing header + system instruction are
	// an OAuth fingerprint and must not be claimed on API-key requests.
	const includeClaudeCode = auth.isOAuth && injectClaudeCodeInstruction;
	const extraInstructions = auth.isOAuth ? ["You are a helpful AI assistant with web search capabilities."] : [];

	return buildAnthropicSystemBlocks(systemPrompt ? [systemPrompt] : undefined, {
		includeClaudeCodeInstruction: includeClaudeCode,
		extraInstructions,
	});
}

/**
 * Calls the Anthropic API with web search tool enabled.
 * @param auth - Authentication configuration (API key or OAuth)
 * @param model - Selected catalog model
 * @param plan - Query text plus native domain filters derived from parsed directives
 * @param metadataUserId - Optional Anthropic Messages metadata.user_id (already shaped for OAuth)
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Raw API response from Anthropic
 * @throws {SearchProviderError} If the API request fails
 */
async function callSearch(
	auth: AnthropicAuthConfig,
	configuredHeaders: Record<string, string> | undefined,
	model: Model<Api>,
	plan: AnthropicQueryPlan,
	metadataUserId?: string,
	systemPrompt?: string,
	maxTokens?: number,
	temperature?: number,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
	timeoutMs?: number,
): Promise<AnthropicApiResponse> {
	const url = buildAnthropicUrl(auth);
	const headers = { ...configuredHeaders, ...buildAnthropicSearchHeaders(auth) };

	const injectClaudeCodeInstruction =
		model.compat === undefined ||
		!("injectClaudeCodeInstruction" in model.compat) ||
		model.compat.injectClaudeCodeInstruction !== false;
	const systemBlocks = buildSystemBlocks(auth, injectClaudeCodeInstruction, systemPrompt);

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

	if (metadataUserId) {
		body.metadata = { user_id: metadataUserId };
	}

	// Opus 4.7+, Sonnet 5+, and Fable/Mythos 5 reject sampling parameters with a 400.
	if (temperature !== undefined && !hasSamplingRestrictions(model)) {
		body.temperature = temperature;
	}

	if (systemBlocks && systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	// OAuth requests inject the CC billing header (buildSystemBlocks); patch its
	// cch attestation like the streaming path instead of shipping `cch=00000`.
	const doFetch = auth.isOAuth ? wrapFetchForCch(fetchImpl) : fetchImpl;
	const response = await doFetch(url, {
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
 */
function parseResponse(response: AnthropicApiResponse): SearchResponse {
	const answerParts: string[] = [];
	const searchQueries: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];

	for (const block of response.content) {
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
			// Search results
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
			answerParts.push(block.text);
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

	return {
		provider: "anthropic",
		answer: answerParts.join("\n\n") || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		usage: {
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
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
	const accountId = params.authStorage.getOAuthAccountId(params.model.provider, params.sessionId);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const plan = planQuery(params.query, parsed);
	const response = await withAuth(
		keyOrResolver,
		async key => {
			const auth = buildAnthropicAuthConfig(key, params.model.baseUrl);
			const configuredHeaders = await params.modelRegistry.resolveModelHeaders(params.model, params.signal);
			// Mirror the main Messages path: OAuth requests need a Claude-Code-shaped
			// metadata.user_id (`{session_id, account_uuid?, device_id}`) so the
			// CC billing header + system fingerprint installed by
			// `buildAnthropicSearchHeaders`/`buildSystemBlocks` line up with the
			// attribution Anthropic and enterprise gateways expect. API-key tokens
			// forward the raw session id verbatim.
			const metadataUserId = resolveAnthropicMetadataUserId(
				params.sessionId,
				auth.isOAuth,
				params.sessionId,
				accountId,
			);
			return callSearch(
				auth,
				configuredHeaders,
				params.model,
				plan,
				metadataUserId,
				params.systemPrompt,
				params.maxOutputTokens,
				params.temperature,
				params.signal,
				params.fetch,
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
				authStorage.hasAuth(model.provider) ||
				(model.provider === "anthropic" && Boolean($env.ANTHROPIC_SEARCH_API_KEY))
			);
		}
		return Boolean($env.ANTHROPIC_SEARCH_API_KEY) || authStorage.hasAuth("anthropic");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnthropic(params);
	}
}
