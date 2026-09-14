import { type } from "@oh-my-pi/omptype";
import type { Api, FetchImpl, ModelSpec, Provider } from "../types";
import { discoveryFetch } from "../utils";

const MODELS_PATH = "/models";

/**
 * Default hard deadline applied to an OpenAI-compatible `/models` probe when
 * the caller supplies neither an `AbortSignal` nor an explicit `timeoutMs`.
 *
 * Built-in provider model managers (openrouter, xAI, DeepSeek, …) call
 * {@link fetchOpenAICompatibleModels} with no timeout, so without this bound a
 * stalled endpoint left the request pending forever and blocked startup's
 * awaited `resolveModelDiscoveryFallback` discovery pass indefinitely
 * (issue #8315). 10s matches the coding-agent's remote-discovery budget.
 */
export const DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Uses a cancellable timer rather than the native abort-timeout helper so
 * successful fast discovery requests do not leave armed timeout signals for
 * concurrent GC to trip over later.
 */
async function withOpenAICompatibleDiscoveryTimeout<T>(
	timeoutMs: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Minimal OpenAI-style model entry shape consumed by discovery.
 *
 * Providers may return additional fields; this type only captures
 * fields that are useful for generic normalization.
 */
export interface OpenAICompatibleModelRecord {
	id?: unknown;
	name?: unknown;
	object?: unknown;
	owned_by?: unknown;
	[key: string]: unknown;
}

/**
 * Tolerant envelope for OpenAI-compatible `/models` responses.
 *
 * Common providers return `{ data: [...] }`, but variants such as
 * `{ models: [...] }`, `{ result: [...] }`, or direct arrays are also
 * accepted during extraction.
 */
export interface OpenAICompatibleModelsEnvelope {
	data?: unknown;
	models?: unknown;
	result?: unknown;
	items?: unknown;
	[key: string]: unknown;
}

const openAICompatibleModelRecordSchema = type({
	id: "string >= 1",
	"name?": "string | null",
	"object?": "unknown",
	"owned_by?": "unknown",
});

const openAICompatibleModelsEnvelopeSchema = type({
	"data?": "unknown",
	"models?": "unknown",
	"result?": "unknown",
	"items?": "unknown",
});

const openAICompatibleModelsPayloadSchema = type("unknown[]").or(openAICompatibleModelsEnvelopeSchema);

type ParsedOpenAICompatibleModelRecord = typeof openAICompatibleModelRecordSchema.infer;
/**
 * Context passed to custom OpenAI-compatible model mappers.
 */
export interface OpenAICompatibleModelMapperContext<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
}

/**
 * Options for fetching and normalizing OpenAI-compatible `/models` catalogs.
 */
export interface FetchOpenAICompatibleModelsOptions<TApi extends Api> {
	/** API type assigned to normalized models. */
	api: TApi;
	/** Provider id assigned to normalized models. */
	provider: Provider;
	/** Provider base URL used for both fetch and normalized model records. */
	baseUrl: string;
	/** Optional bearer token for Authorization header. */
	apiKey?: string;
	/** Additional request headers. */
	headers?: Record<string, string>;
	/** Optional AbortSignal for request cancellation; caller owns its lifecycle. */
	signal?: AbortSignal;
	/**
	 * Optional cancellable request timeout used when `signal` is omitted.
	 * Defaults to {@link DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS} so a
	 * stalled endpoint can never hang discovery indefinitely.
	 */
	timeoutMs?: number;
	/** Optional fetch implementation override for testing/custom runtimes. */
	fetch?: FetchImpl;
	/**
	 * Optional post-normalization filter.
	 * Return false to skip a model.
	 */
	filterModel?: (entry: OpenAICompatibleModelRecord, model: ModelSpec<TApi>) => boolean;
	/**
	 * Optional mapper override for provider-specific quirks.
	 * Return null to skip a model.
	 */
	mapModel?: (
		entry: OpenAICompatibleModelRecord,
		defaults: ModelSpec<TApi>,
		context: OpenAICompatibleModelMapperContext<TApi>,
	) => ModelSpec<TApi> | null;
}

/**
 * Fetches and normalizes an OpenAI-compatible `/models` catalog.
 *
 * Returns `null` on transport/protocol failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchOpenAICompatibleModels<TApi extends Api>(
	options: FetchOpenAICompatibleModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (!baseUrl) {
		return null;
	}

	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}

	const fetchImpl = discoveryFetch(options.fetch);
	const fetchEntries = async (signal?: AbortSignal): Promise<ParsedOpenAICompatibleModelRecord[] | null> => {
		const entries: ParsedOpenAICompatibleModelRecord[] = [];
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 100; page++) {
			let payload: unknown;
			try {
				const url = new URL(`${baseUrl}${MODELS_PATH}`);
				if (cursor !== undefined) {
					url.searchParams.set(options.api === "anthropic-messages" ? "after_id" : "after", cursor);
				}
				const response = await fetchImpl(url.toString(), {
					method: "GET",
					headers: requestHeaders,
					signal,
					redirect: "error",
				});
				if (!response.ok || /\brel\s*=\s*["']?next\b/i.test(response.headers.get("link") ?? "")) return null;
				payload = await response.json();
			} catch {
				return null;
			}
			const parsed = extractModelEntries(payload);
			if (parsed === null) return null;
			for (const entry of parsed.entries) entries.push(entry);
			if (parsed.cursor === undefined) return entries;
			if (seenCursors.has(parsed.cursor) || parsed.entries.length === 0) return null;
			seenCursors.add(parsed.cursor);
			cursor = parsed.cursor;
		}
		return null;
	};
	const entries =
		options.signal !== undefined
			? await fetchEntries(options.signal)
			: await withOpenAICompatibleDiscoveryTimeout(
					options.timeoutMs ?? DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
					fetchEntries,
				);
	if (entries === null) return null;

	const context: OpenAICompatibleModelMapperContext<TApi> = {
		api: options.api,
		provider: options.provider,
		baseUrl,
	};

	const deduped = new Map<string, ModelSpec<TApi>>();
	for (const entry of entries) {
		const defaults: ModelSpec<TApi> = {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			api: options.api,
			provider: options.provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		};

		// `mapModel` returning null skips the entry (documented contract); only a
		// missing mapper falls back to the defaults.
		const mapped = options.mapModel ? options.mapModel(entry, defaults, context) : defaults;
		if (mapped === null) continue;
		if (!mapped || typeof mapped.id !== "string" || mapped.id.trim().length === 0) return null;
		if (options.filterModel && !options.filterModel(entry, mapped)) {
			continue;
		}
		deduped.set(mapped.id, mapped);
	}

	return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

interface ModelPage {
	entries: ParsedOpenAICompatibleModelRecord[];
	cursor?: string;
}

export function extractModelEntries(node: unknown, depth = 0): ModelPage | null {
	if (depth > 10) return null;
	const parsedPayload = openAICompatibleModelsPayloadSchema(node);
	if (parsedPayload instanceof type.errors) return null;
	if (Array.isArray(parsedPayload)) {
		const entries: ParsedOpenAICompatibleModelRecord[] = [];
		for (const entry of parsedPayload) {
			const parsed = openAICompatibleModelRecordSchema(entry);
			if (parsed instanceof type.errors || parsed.id.trim().length === 0) return null;
			entries.push(parsed);
		}
		return { entries };
	}
	const envelope = parsedPayload as OpenAICompatibleModelsEnvelope;
	// Unknown continuation contracts must never turn one page into a complete catalog.
	for (const key of [
		"next",
		"next_page",
		"nextPage",
		"next_page_token",
		"nextPageToken",
		"next_cursor",
		"nextCursor",
		"pagination",
		"links",
		"hasMore",
	]) {
		if (envelope[key] !== undefined && envelope[key] !== null && envelope[key] !== false && envelope[key] !== "")
			return null;
	}
	if (envelope.has_more !== undefined && typeof envelope.has_more !== "boolean") return null;
	const candidates = [envelope.data, envelope.models, envelope.result, envelope.items].filter(
		value => value !== undefined,
	);
	if (candidates.length !== 1) return null;
	const nested = extractModelEntries(candidates[0], depth + 1);
	if (nested === null) return null;
	if (envelope.has_more === true) {
		if (nested.cursor !== undefined || typeof envelope.last_id !== "string" || !envelope.last_id.trim()) return null;
		return { entries: nested.entries, cursor: envelope.last_id };
	}
	if (envelope.has_more === false && nested.cursor !== undefined) return null;
	return nested;
}
