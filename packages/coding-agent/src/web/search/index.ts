/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { formatAge, formatCount, prompt, truncate } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { type RoleChainCandidate, resolveModelRoleValue, resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import { settings } from "../../config/settings";
import type { CustomTool, CustomToolContext } from "../../extensibility/custom-tools/types";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { resolveConfiguredModelTarget } from "../../session/role-models";
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getGroundedSearchProvider,
	getSearchProvider,
	type SearchProvider,
} from "./provider";
import { rankXAIProviders, targetsX, xaiModelChain, xSearchAvailable } from "./providers/xai";
import { applyQueryConstraints, parseSearchQuery } from "./query";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SearchProviderError,
	type SearchResponse,
	type SearchResultDetails,
} from "./types";

import { cfgProvidersAntigravityEndpoint, cfgProvidersWebSearchTimeoutSeconds } from "../../session/settings";

/** Web search tool parameters schema */
export const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	model?: string;
}

/** Format response for LLM consumption. `notes` lead the output (e.g. relaxed-constraint warnings). */
function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
	const parts: string[] = [];
	for (const note of notes) {
		parts.push(`Note: ${note}`);
	}

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncate(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncate(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncate(query, 120)}`);
		}
	}

	return parts.join("\n");
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	modelRegistry?: ModelRegistry;
	sessionId?: string;
	/** The session's active model; `web/hosted` searches through it. */
	sessionModel?: Model<Api>;
	signal?: AbortSignal;
}

function isHostedPlaceholder(model: Model<Api>): boolean {
	return model.provider === "web" && model.id === "hosted";
}

/**
 * Expand the `web/hosted` placeholder into models on the session's own
 * provider, which bill the credential the session already uses: first the
 * session model's cheaper `webSearchModel` swap, then the session model itself.
 * A swap the host does not expose is skipped; a failing swap falls through to
 * the session model. Left unexpanded when neither can search.
 */
function expandHostedCandidate(
	candidate: RoleChainCandidate,
	sessionModel: Model<Api> | undefined,
	pool: Model<Api>[],
): RoleChainCandidate[] {
	if (!isHostedPlaceholder(candidate.model) || !sessionModel) return [candidate];
	const swap = resolveConfiguredModelTarget(sessionModel.webSearchModel, sessionModel, pool);
	const models = [swap, sessionModel].filter(
		(model, index, all): model is Model<Api> => !!model?.webSearch && all.indexOf(model) === index,
	);
	if (models.length === 0) return [candidate];
	return models.map(model => ({ ...candidate, model }));
}

/**
 * Move the chain's xAI-grounded candidates to the front, keeping their order,
 * or prepend {@link xaiModelChain} when the chain has none. Unchanged without
 * xAI credentials.
 */
function preferXAI(chain: RoleChainCandidate[], modelRegistry: ModelRegistry): RoleChainCandidate[] {
	const xai = chain.filter(candidate => candidate.model.webSearch === "xai");
	if (xai.length > 0) return [...xai, ...chain.filter(candidate => candidate.model.webSearch !== "xai")];
	return [...xaiModelChain(modelRegistry, settings).map(model => ({ model, explicit: false })), ...chain];
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const { authStorage, sessionId, signal } = options;
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, undefined, { settings });
	const pool = roleCandidatePool("web", settings, modelRegistry);
	const candidates = params.model
		? (() => {
				const resolved = resolveModelRoleValue(params.model, pool, { settings });
				return resolved.model
					? [{ model: resolved.model, explicit: true, thinkingLevel: resolved.thinkingLevel }]
					: [];
			})()
		: resolveRoleChain("web", settings, pool);
	const parsedQuery = parseSearchQuery(params.query);
	let expanded = rankXAIProviders(
		candidates.flatMap(candidate => expandHostedCandidate(candidate, options.sessionModel, pool)),
		candidate => candidate.model,
		settings,
	);
	// Only xAI reaches X posts; X-only queries try it first even when the role prefers another engine.
	if (!params.model && targetsX(parsedQuery)) expanded = preferXAI(expanded, modelRegistry);

	// Invariant across candidates; resolve once before walking the role chain.
	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = cfgProvidersAntigravityEndpoint.get(settings);
	} catch {
		antigravityEndpointMode = undefined;
	}

	let timeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;
	try {
		const configuredSeconds = cfgProvidersWebSearchTimeoutSeconds.get(settings);
		if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
			timeoutMs = Math.ceil(Math.min(configuredSeconds, MAX_WEB_SEARCH_TIMEOUT_SECONDS) * 1_000);
		}
	} catch {
		// Preserve the default for one-shot callers that do not initialize Settings.
	}

	const failures: Array<{ provider: { id: string; label: string }; error: unknown }> = [];
	let availableProviderCount = 0;
	let lastProvider: { id: string; label: string } | undefined;
	let failedResponseProvider: SearchResponse["provider"] = "none";
	for (const candidate of expanded) {
		let provider: SearchProvider | undefined;
		const candidateMeta = { id: candidate.model.id, label: candidate.model.name };
		lastProvider = candidateMeta;
		try {
			const model = candidate.model;
			if (isHostedPlaceholder(model)) {
				if (!candidate.explicit) continue;
				throw new Error("The session model has no web search grounding.");
			}
			if (modelKind(model) === "search") {
				provider = await getSearchProvider(model.id);
			} else if (model.webSearch) {
				provider = await getGroundedSearchProvider(model.webSearch);
			} else {
				throw new Error(`Model ${model.provider}/${model.id} does not support web search`);
			}
			lastProvider = provider;
			const available = candidate.explicit
				? await provider.isExplicitlyAvailable(authStorage, model)
				: await provider.isAvailable(authStorage, model);
			if (!available && !candidate.explicit) continue;
			if (!available && candidate.explicit) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} web search is unavailable. Configure its credentials or select the automatic provider chain.`,
				);
			}
			availableProviderCount++;
			lastProvider = provider;

			const response = await provider.search({
				query: params.query,
				parsedQuery,
				limit: params.limit,
				recency: params.recency,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
				timeoutMs,
				authStorage,
				model,
				thinkingLevel: candidate.thinkingLevel,
				modelRegistry,
				explicit: candidate.explicit,
				sessionId,
				antigravityEndpointMode,
			});

			// A host that silently drops the hosted search tool still answers from the
			// model's weights; without sources that answer is not a search result.
			if (modelKind(model) !== "search" && response.sources.length === 0 && !response.citations?.length) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} returned no sources; ${model.provider}/${model.id} may not support hosted web search.`,
					204,
				);
			}

			// Lenient constraint pass over whatever the provider returned: enforce
			// site:/inurl:/intitle:/filetype:/date directives the provider could
			// not (or only partially) honor natively, relaxing any dimension that
			// would wipe out every result. Citations/answer text stay untouched.
			let finalResponse = response;
			const constraintNotes: string[] = [];
			if (parsedQuery.hasConstraints && response.sources.length > 0) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				if (filtered.sources.length !== response.sources.length) {
					finalResponse = { ...response, sources: filtered.sources };
				}
				for (const label of filtered.dropped) {
					constraintNotes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			const text = formatForLLM(finalResponse, constraintNotes);

			return {
				content: [{ type: "text" as const, text }],
				details: { response: finalResponse },
			};
		} catch (error) {
			// Surface user-initiated cancellation immediately so the session sees
			// a clean abort instead of a generic "all providers failed" message.
			// Without this, an AbortError from `fetch()` is treated as a provider
			// failure and the loop falls through to the next provider (or to the
			// summary error), masking the cancellation.
			throwIfAborted(signal);
			failedResponseProvider = provider?.id ?? "none";
			failures.push({ provider: provider ?? candidateMeta, error });
		}
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const message = params.model
			? `No web search model matches selector "${params.model}".`
			: "No web search model configured.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider?.label ?? "web search provider"}`;
	const message =
		failures.length > 1 ? `All web search providers failed: ${formatSearchProviderFailures(failures)}` : baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: {
			response: { provider: failedResponseProvider, sources: [] },
			error: message,
		},
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `OMP_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage?: AuthStorage;
		modelRegistry?: ModelRegistry;
		sessionId?: string;
		sessionModel?: Model<Api>;
		signal?: AbortSignal;
	} = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const createdAuthStorage = options.authStorage || options.modelRegistry ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? options.modelRegistry?.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			modelRegistry: options.modelRegistry,
			sessionId: options.sessionId,
			sessionModel: options.sessionModel,
			signal: options.signal,
		});
	} finally {
		createdAuthStorage?.close();
	}
}

/** Description without the X operators, for hosts without a model registry. */
const plainDescription = prompt.render(webSearchDescription);

/**
 * Description rendered on first read with a model registry, then reused for
 * the process: re-checking xAI auth per read would rewrite the tool
 * description, and invalidate the prompt cache, whenever auth changes.
 */
let registryDescription: string | undefined;

/**
 * Web search tool implementation.
 *
 * Supports the configured web model role chain with automatic fallback.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchResultDetails> {
	readonly name = "web_search";
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	/** Advertises X search operators when xAI credentials existed at the process's first read. */
	get description(): string {
		const modelRegistry = this.#session.modelRegistry;
		if (!modelRegistry) return plainDescription;
		registryDescription ??= prompt.render(webSearchDescription, { xSearch: xSearchAvailable(modelRegistry) });
		return registryDescription;
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchResultDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchResultDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, {
			authStorage,
			modelRegistry: this.#session.modelRegistry,
			sessionId,
			sessionModel: this.#session.getActiveModel?.(),
			signal,
		});
	}
}

/** Web search tool as CustomTool for consumers embedding the custom-tool API. */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchResultDetails> = {
	name: "web_search",
	label: "Web Search",
	description: plainDescription,
	parameters: webSearchSchema,

	approval: "read",
	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, {
			authStorage,
			modelRegistry: ctx.modelRegistry,
			sessionId,
			sessionModel: ctx.model,
			signal,
		});
	},
};

export function getSearchTools(): CustomTool<typeof webSearchSchema, SearchResultDetails>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
