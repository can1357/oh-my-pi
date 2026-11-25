/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, DeepSeek, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type AuthStorage, type Model, tokenUsage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { formatAge, formatCount, prompt, truncate } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../../config/auxiliary-model-policy";
import { disabledModelRule } from "../../config/disabled-models";
import { ModelRegistry } from "../../config/model-registry";
import { type RoleChainCandidate, resolveModelRoleValue, resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import { settings, type Settings } from "../../config/settings";
import type { CustomTool, CustomToolContext } from "../../extensibility/custom-tools/types";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { journalCompletion, type ModelUsageLedger } from "../../session/model-usage-journal";
import { resolveConfiguredModelTarget } from "../../session/role-models";
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getGroundedSearchProvider,
	getSearchProvider,
	type SearchParams,
	type SearchProvider,
	type SearchProviderFailure,
} from "./provider";
import { rankXAIProviders, targetsX, xaiModelChain, xSearchAvailable } from "./providers/xai";
import { applyQueryConstraints, parseSearchQuery, scopeConstraints } from "./query";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SearchProviderError,
	type SearchFailureDetail,
	type SearchResponse,
	type SearchResultDetails,
} from "./types";

import {
	cfgProvidersAntigravityEndpoint,
	cfgProvidersWebKeyless,
	cfgProvidersWebSearchTimeoutSeconds,
} from "../../session/settings";

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

/** Longest failure reason a fallback note quotes, the cap source snippets get; provider errors can carry whole response bodies. */
const MAX_FALLBACK_REASON_CHARS = 240;

/** Failed candidates as tool details record them and the fallback note quotes them: reason flattened and capped. */
function failureDetails(failures: readonly SearchProviderFailure[]): SearchFailureDetail[] {
	return failures.map(({ provider, error }): SearchFailureDetail => {
		const reason = formatSearchProviderFailure(error, provider).replace(/\s+/g, " ").trim().replace(/\.$/, "");
		return {
			provider: provider.id,
			label: provider.label,
			reason: truncate(reason, MAX_FALLBACK_REASON_CHARS),
			...(error instanceof SearchProviderError && error.status !== undefined ? { status: error.status } : {}),
		};
	});
}

/**
 * Note naming the candidates that failed before `served` answered. Without it a
 * fallback engine's results read as the preferred provider's, e.g. web pages
 * standing in for an X search.
 */
function fallbackNotes(failed: readonly SearchFailureDetail[], served: { label: string }): string[] {
	if (failed.length === 0) return [];
	return [`answered by ${served.label} after ${failed.map(f => `${f.label} failed (${f.reason})`).join(" and ")}`];
}

/** How long an engine that answered HTTP 429 is skipped by the automatic chain. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * Engines (`provider/id`) that answered HTTP 429, with when the automatic chain may
 * try them again. A keyless engine's free tier (Parallel, Exa) rate-limits for minutes,
 * so retrying it on every call only adds the 429's latency before the fallback answers.
 */
const rateLimitedUntil = new Map<string, number>();

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
	/** The owning session's settings: its web role, `disabledModels` and limits. Defaults to the process settings. */
	settings?: Settings;
	signal?: AbortSignal;
	/** Session journal each provider response's usage is billed to; unjournaled when omitted. */
	usageLedger?: Partial<ModelUsageLedger>;
}

/**
 * A provider response's token usage as an assistant message for the session's usage journal, or
 * `undefined` when the provider reported neither input nor output tokens. Search usage carries no
 * cache breakdown and no billed amount, so the cost is the catalog price of the reported tokens:
 * per-search fees are not in it, and a search-only engine without token rates prices at zero.
 */
function searchUsageMessage(
	model: Model<Api>,
	response: SearchResponse,
	duration: number,
): AssistantMessage | undefined {
	const reported = response.usage;
	if (!reported || (reported.inputTokens === undefined && reported.outputTokens === undefined)) return undefined;
	const usage = tokenUsage(reported.inputTokens, reported.outputTokens);
	// A provider's total can count token classes (reasoning, cached input) the split leaves out.
	if (reported.totalTokens !== undefined && reported.totalTokens > usage.totalTokens) {
		usage.totalTokens = reported.totalTokens;
	}
	calculateCost(model, usage);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: response.provider,
		model: response.model ?? model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		duration,
	};
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
	searchSettings: Settings,
): RoleChainCandidate[] {
	if (!isHostedPlaceholder(candidate.model) || !sessionModel) return [candidate];
	const swap = resolveConfiguredModelTarget(sessionModel.webSearchModel, sessionModel, pool);
	const distinctSwap = swap?.provider === sessionModel.provider && swap.id === sessionModel.id ? undefined : swap;
	// The session model is not drawn from the filtered pool, so disabledModels may deny it.
	const models = [distinctSwap, sessionModel].filter(
		(model): model is Model<Api> => !!model?.webSearch && disabledModelRule(model, searchSettings) === undefined,
	);
	if (models.length === 0) return [candidate];
	return models.map(model => ({ ...candidate, model }));
}

/**
 * Move the chain's xAI-grounded candidates to the front, keeping their order,
 * or prepend {@link xaiModelChain} when the chain has none. Unchanged without
 * xAI credentials.
 */
function preferXAI(
	chain: RoleChainCandidate[],
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
): RoleChainCandidate[] {
	const xai = chain.filter(candidate => candidate.model.webSearch === "xai");
	if (xai.length > 0) return [...xai, ...chain.filter(candidate => candidate.model.webSearch !== "xai")];
	return [...xaiModelChain(modelRegistry, activeSettings).map(model => ({ model, explicit: false })), ...chain];
}

/** A site-specific engine must not replace a refused web role. */
function webRoleRefused(candidates: RoleChainCandidate[], searchSettings: Settings, pool: Model<Api>[]): boolean {
	if (candidates.length > 0 || !Object.hasOwn(searchSettings.getModelRoles(), "web")) return false;
	const resolved = resolveModelRoleValue(searchSettings.getModelRole("web"), pool, { settings: searchSettings });
	return resolved.model === undefined && resolved.disabledModel !== undefined;
}

function isHackerNewsEngine(model: Model<Api>): boolean {
	return model.provider === "web" && model.id === "hackernews";
}

/**
 * Move the chain's `web/hackernews` candidate to the front, or prepend the
 * pool's as an automatic candidate when the chain has none.
 */
function preferHackerNews(
	chain: RoleChainCandidate[],
	pool: Model<Api>[],
	activeSettings: Settings,
): RoleChainCandidate[] {
	const listed = chain.filter(candidate => isHackerNewsEngine(candidate.model));
	if (listed.length > 0) return [...listed, ...chain.filter(candidate => !isHackerNewsEngine(candidate.model))];
	const model = pool.find(isHackerNewsEngine);
	if (model && disabledModelRule(model, activeSettings) !== undefined) return chain;
	return model ? [{ model, explicit: false }, ...chain] : chain;
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const { authStorage, sessionId, signal } = options;
	// The session's own settings (an ACP session's project, a subagent overlay) win over the process global.
	const activeSettings = options.settings ?? settings;
	const modelRegistry =
		options.modelRegistry ?? new ModelRegistry(authStorage, undefined, { settings: activeSettings });
	const pool = roleCandidatePool("web", activeSettings, modelRegistry);
	const candidates = params.model
		? (() => {
				const resolved = resolveModelRoleValue(params.model, pool, { settings: activeSettings });
				return resolved.model
					? [{ model: resolved.model, explicit: true, thinkingLevel: resolved.thinkingLevel }]
					: [];
			})()
		: resolveRoleChain("web", activeSettings, pool);
	const parsedQuery = parseSearchQuery(params.query);
	let expanded = rankXAIProviders(
		candidates.flatMap(candidate => expandHostedCandidate(candidate, options.sessionModel, pool, activeSettings)),
		candidate => candidate.model,
		activeSettings,
	);
	if (!params.model && !webRoleRefused(candidates, activeSettings, pool)) {
		// Only xAI reaches X posts; general engines index HN threads sparsely and late.
		if (targetsX(parsedQuery)) expanded = preferXAI(expanded, modelRegistry, activeSettings);
		if (
			parsedQuery.sites.length > 0 &&
			parsedQuery.sites.every(site => site.split("/", 1)[0] === "news.ycombinator.com")
		) {
			expanded = preferHackerNews(expanded, pool, activeSettings);
		}
	}

	// Invariant across candidates; resolve once before walking the role chain.
	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = cfgProvidersAntigravityEndpoint.get(activeSettings);
	} catch {
		antigravityEndpointMode = undefined;
	}

	let timeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;
	try {
		const configuredSeconds = cfgProvidersWebSearchTimeoutSeconds.get(activeSettings);
		if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
			timeoutMs = Math.ceil(Math.min(configuredSeconds, MAX_WEB_SEARCH_TIMEOUT_SECONDS) * 1_000);
		}
	} catch {
		// Preserve the default for one-shot callers that do not initialize Settings.
	}

	// Only a per-request selector reaches a keyless service once the user turned them off.
	const keylessAllowed = params.model !== undefined || cfgProvidersWebKeyless.get(activeSettings);
	let keylessSkipped = false;
	const failures: SearchProviderFailure[] = [];
	let availableProviderCount = 0;
	let lastProvider: { id: string; label: string } | undefined;
	let failedResponseProvider: SearchResponse["provider"] = "none";
	const scope = parsedQuery.hasConstraints ? scopeConstraints(parsedQuery) : undefined;
	/** Engines that answered, but with nothing inside the query's scope directives. */
	const scopeMisses: { id: SearchResponse["provider"]; label: string }[] = [];
	// The tool result holds the text; this is the only place a search's tokens reach session totals.
	const journal = journalCompletion(options.usageLedger, { purpose: "web-search", usageOnly: true });
	for (const candidate of expanded) {
		if (cfgOffline.get(activeSettings)) {
			const activeProvider = options.sessionModel?.provider;
			// Search-only catalog entries use the synthetic "web" provider; their
			// backend is not the session's model endpoint, so do not infer a match.
			if (
				!activeProvider ||
				candidate.model.provider !== activeProvider ||
				modelKind(candidate.model) === "search"
			) {
				continue;
			}
		}
		let provider: SearchProvider | undefined;
		const candidateMeta = { id: candidate.model.id, label: candidate.model.name };
		lastProvider = candidateMeta;
		const engineKey = `${candidate.model.provider}/${candidate.model.id}`;
		const cooldownEnds = rateLimitedUntil.get(engineKey);
		if (cooldownEnds !== undefined && !params.model) {
			if (cooldownEnds > Date.now()) {
				const minutes = RATE_LIMIT_COOLDOWN_MS / 60_000;
				failures.push({
					provider: candidateMeta,
					error: new Error(`skipped: rate-limited (429) within the last ${minutes} minutes`),
				});
				continue;
			}
			rateLimitedUntil.delete(engineKey);
		}
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
			if (!keylessAllowed && (await provider.isKeyless(authStorage, model))) {
				keylessSkipped = true;
				continue;
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
			// Availability can yield to a settings edit. Neither the extension nor the backend may receive a denied query.
			if (disabledModelRule(model, activeSettings) !== undefined) continue;
			availableProviderCount++;
			lastProvider = provider;

			const sentAt = Date.now();
			const searchParams: SearchParams = {
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
			};
			// An extension may own the request for its provider's models; availability stays the backend's.
			const extensionSearch = modelRegistry.getProviderWebSearch(model.provider);
			const response = await (extensionSearch ? extensionSearch(searchParams) : provider.search(searchParams));
			// Before any rejection below: a response a later check discards was still billed.
			const billed = searchUsageMessage(model, response, Date.now() - sentAt);
			if (billed) journal?.(billed);

			// A host that silently drops the hosted search tool still answers from the
			// model's weights; without sources that answer is not a search result.
			if (modelKind(model) !== "search" && response.sources.length === 0 && !response.citations?.length) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} returned no sources; ${model.provider}/${model.id} may not support hosted web search.`,
					204,
				);
			}

			// Constraint pass over whatever the provider returned: enforce the
			// directives the provider could not (or only partially) honor natively.
			// Scope directives (site:/inurl:/exclusions) hold even when nothing is
			// left, and also filter citations; intitle:/filetype:/date relax when they
			// would wipe out every result. Answer text cannot be filtered, so it is
			// flagged when sources it may draw on were removed.
			let finalResponse = response;
			const constraintNotes: string[] = [];
			if (parsedQuery.hasConstraints && (response.sources.length > 0 || response.citations?.length)) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				const citations = scope ? response.citations?.filter(scope.matches) : response.citations;
				if (filtered.sources.length !== response.sources.length || citations !== response.citations) {
					finalResponse = {
						...response,
						sources: filtered.sources,
						...(citations === undefined ? {} : { citations }),
					};
				}
				for (const label of filtered.dropped) {
					constraintNotes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
				if (scope) {
					if (filtered.sources.length === 0 && !citations?.length) {
						scopeMisses.push({ id: provider.id, label: provider.label });
						continue;
					}
					const offScope =
						response.sources.filter(source => !scope.matches(source)).length +
						(response.citations?.length ?? 0) -
						(citations?.length ?? 0);
					if (response.answer?.trim() && offScope > 0) {
						constraintNotes.push(
							`removed ${formatCount("source", offScope)} outside \`${scope.label}\`; the answer text is unfiltered and may draw on them`,
						);
					}
				}
			}
			if (modelKind(model) !== "search" && finalResponse.answer?.trim()) {
				constraintNotes.unshift(
					`synthesized answer by ${model.provider}/${model.id} hosted search, not a result list; check claims against the cited sources`,
				);
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			const failed = failureDetails(failures);
			const text = formatForLLM(finalResponse, [...fallbackNotes(failed, provider), ...constraintNotes]);

			return {
				content: [{ type: "text" as const, text }],
				details: failed.length > 0 ? { response: finalResponse, failures: failed } : { response: finalResponse },
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
			if (error instanceof SearchProviderError && error.status === 429) {
				rateLimitedUntil.set(engineKey, Date.now() + RATE_LIMIT_COOLDOWN_MS);
			}
		}
	}

	if (scope && scopeMisses.length > 0) {
		// Engines answered, just not inside the requested scope: an empty result, not an error.
		const searched = scopeMisses.map(miss => miss.label).join(", ");
		const notes = fallbackNotes(failureDetails(failures), { label: searched });
		const text = [
			...notes.map(note => `Note: ${note}`),
			`No results from ${searched} matched \`${scope.label}\`.`,
		].join("\n");
		return {
			content: [{ type: "text" as const, text }],
			details: { response: { provider: scopeMisses[0]!.id, sources: [] } },
		};
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const message = cfgOffline.get(activeSettings)
			? "No web search backend is available on the active model's provider under --offline."
			: params.model
				? `No web search model matches selector "${params.model}".`
				: keylessSkipped
					? "No configured web search service is available, and providers.webKeyless is off. Configure a search credential or turn providers.webKeyless on."
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
			failures: failureDetails(failures),
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
		settings?: Settings;
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
			settings: options.settings,
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
			settings: this.#session.settings,
			signal,
			usageLedger: this.#session.sessionManager,
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
			settings: ctx.settings,
			signal,
		});
	},
};

export function getSearchTools(): CustomTool<typeof webSearchSchema, SearchResultDetails>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
