import { getEnvApiKey, type Api, type KeysApi, type Model } from "@oh-my-pi/pi-ai";
import { mapOpenAIReasoningEffort } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { type ConfiguredThinkingLevel } from "../../../utils/render-utils";
import { concreteThinkingLevel, toReasoningEffort } from "../../../thinking/levels";
import { readBoundedBody } from "@oh-my-pi/pi-utils/bounded-json";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, SearchProviderError } from "../../../web/search/types";
import { SEARCH_PROVIDER_LABELS, type SearchProviderId, type SearchSource } from "../types";
import { decodeBody } from "../../response-body";
import { formatQuery, type QuerySyntax, type StructuredQuery } from "../query";
import { dateToAgeSeconds } from "../utils";

/** Web readers prefer the caller's environment key, then ask the session's credential owner. */
export async function findCredential(
	keys: Pick<KeysApi, "get"> | undefined,
	provider: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const envKey = getEnvApiKey(provider);
	if (envKey) return envKey;
	try {
		const key = await keys?.get(provider, undefined, { signal });
		return key?.trim() ? key : null;
	} catch {
		signal?.throwIfAborted();
		throw new Error(`Failed to read stored credentials for ${provider}.`);
	}
}

/**
 * The 60-second default tolerates legitimate slow LLM-mediated responses
 * (Anthropic web_search_20250305, Perplexity, Gemini, Codex) while bounding
 * Windows stalls when Bun's `AbortSignal` fails to propagate. Callers may
 * configure a longer provider deadline, capped at five minutes by the
 * dispatcher; pure search APIs typically settle far faster.
 */
export const SEARCH_HARD_TIMEOUT_MS = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;

/**
 * Compose a caller-supplied {@link AbortSignal} with a hard timeout so an
 * outbound `fetch()` is guaranteed to settle within `ms` even when the
 * runtime fails to propagate cancellation to the underlying transport.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard timeout in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Wire `reasoning.effort` for an OpenAI-style hosted-search request (Codex,
 * OpenAI Responses) from the web role's thinking level. Clamps to the model's
 * ladder and applies its effort map, as chat requests do. `undefined` — omit
 * the field and keep the server default — when the level is unset, `auto`,
 * `off`, or `inherit`, or the model does not reason.
 */
export function searchReasoningEffort(
	model: Model<Api>,
	thinkingLevel: ConfiguredThinkingLevel | undefined,
): string | undefined {
	const effort = clampThinkingLevelForModel(model, toReasoningEffort(concreteThinkingLevel(thinkingLevel)));
	if (effort === undefined) return undefined;
	const compat = model.compat && "reasoningEffortMap" in model.compat ? model.compat : undefined;
	return mapOpenAIReasoningEffort(model, compat, effort);
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}

/**
 * Quota/auth signals across providers. Telemetry on 15.1.7/15.1.8 showed users
 * hitting credit-exhaustion and 401/402/403 responses that were surfaced as
 * raw HTTP error text. Map those into compact, provider-tagged messages so
 * the orchestrator can chain-advance cleanly and the final summary stays
 * legible when every provider rejects the request.
 *
 * Returns `null` when the response does not match a known quota/auth signal,
 * leaving the caller to throw its provider-specific fallback error.
 */
const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

export function classifyProviderHttpError(
	provider: SearchProviderId,
	status: number,
	body: string,
): SearchProviderError | null {
	if (CREDIT_BODY_PATTERN.test(body)) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) {
		return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	}
	if (status === 401) {
		return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	}
	if (status === 403) {
		return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	}
	return null;
}

/**
 * Collapse runs of whitespace in a loosely-typed provider field, returning
 * `undefined` for missing/non-string/blank values. Shared so tab/newline
 * folding cannot drift between providers.
 */
export function normalizeSearchText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > 0 ? text : undefined;
}

/**
 * Bare, deduplicated hosts from `site:` values (`github.com/anthropics` → `github.com`)
 * for provider domain filters; path parts are enforced by the central lenient post-filter.
 */
export function siteHosts(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const host = site.split("/", 1)[0];
		if (host) hosts.add(host);
	}
	return [...hosts];
}

/**
 * Query text for search APIs that take only plain terms in `syntax`. A query without
 * directives passes through verbatim; otherwise its terms are rendered, and a
 * directives-only query falls back to its constraint values (site hosts, `intitle:`
 * words, …) as keywords, never the operators themselves.
 *
 * @throws {SearchProviderError} 400 when nothing searchable remains (a date-only query).
 */
export function keywordQuery(provider: SearchProviderId, parsed: StructuredQuery, syntax: QuerySyntax): string {
	const query = parsed.hasDirectives ? formatQuery({ ...parsed, raw: "" }, syntax) : parsed.raw.trim();
	if (query) return query;
	throw new SearchProviderError(
		provider,
		`${SEARCH_PROVIDER_LABELS[provider]} needs search terms; date-only queries are not supported`,
		400,
	);
}

/**
 * Read a provider response body up to a byte cap, truncating or throwing when
 * the limit is exceeded. Shared so streaming-cap fixes land in one place.
 */
export async function readLimitedText(
	response: Response,
	provider: SearchProviderId,
	maxBytes: number,
	truncate = false,
): Promise<string> {
	const body = await readBoundedBody(response, maxBytes);
	if (!body) return "";
	if (body.truncated && !truncate) {
		throw new SearchProviderError(provider, `${SEARCH_PROVIDER_LABELS[provider]} API response exceeded 2 MiB`, 500);
	}
	return decodeBody(body.bytes, response.headers.get("content-type") ?? "");
}

/**
 * Parse a provider-supplied result URL, keeping only absolute http(s) URLs.
 * Returns the normalized string, or `undefined` for anything else.
 */
export function normalizeHttpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}
