import { USER_AGENT } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { toClinePassPublicModelId } from "../cline-pass-model-id";
import {
	apiRouteExactModelIds,
	apiRouteFor,
	isExcludedModel,
	isLikelyOpenAIResponsesId,
	modelLimitsFor,
	pricingPeerFor,
} from "../compat/behavior";
import { xaiResponsesReasoningEffortMap } from "../compat/openai";
import { resolveModelPolicy } from "../compat/resolve";
import { compareRevision, parseRevision } from "../compat/revision";
import { classifyModel, discoveryVocabulary } from "../compat/taxonomy";
import {
	DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../discovery/openai-compatible";
import { Effort, THINKING_EFFORTS } from "../effort";
import { FIREWORKS_FAST_SUFFIX, toFireworksPublicModelId } from "../fireworks-model-id";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions, ModelsDevFallback } from "../model-manager";
import { type GeneratedProvider, getBundledModels } from "../models";
import type { Api, FetchImpl, Model, ModelSpec, OpenAICompat, Provider, ThinkingConfig, TokenCost } from "../types";
import { discoveryFetch, isAnthropicOAuthToken, isRecord, toBoolean, toNumber, toPositiveNumber } from "../utils";
import { ALIBABA_TOKEN_PLAN_BASE_URL, parseAlibabaTokenPlanCredential } from "../wire/alibaba-token-plan";
import { CLINEPASS_API_BASE_URL, clinePassClientHeaders } from "../wire/cline-pass";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../wire/cloudflare-ai-gateway";
import { coreWeaveProjectHeaders } from "../wire/coreweave";
import {
	COPILOT_API_HEADERS,
	COPILOT_DISCOVERY_HEADERS,
	discoverGitHubCopilotApiEndpoint,
	getGitHubCopilotBaseUrl,
	isPersonalGitHubCopilotBaseUrl,
	mergeCopilotApiHeaders,
	parseGitHubCopilotApiKey,
} from "../wire/github-copilot";
import { createBundledReferenceMap, createReferenceResolver, toModelSpec } from "./bundled-references";
import { getDefaultModelDiscoveryBaseUrl, resolveModelCacheProviderId } from "./cache-provider-id";
import { getClinePassModelMetadata } from "./cline-pass";
import type { ModelManagerConfig } from "./descriptor-types";
import { filterModelsDevCatalogRows } from "./models-dev-policies";

function revisionAtLeast(revision: string | undefined, floor: string): boolean {
	if (revision === undefined) return false;
	const parsedRevision = parseRevision(revision);
	const parsedFloor = parseRevision(floor);
	return (
		parsedRevision !== undefined && parsedFloor !== undefined && compareRevision(parsedRevision, parsedFloor) >= 0
	);
}

function isGlmReasoningIdentity(provider: string, modelId: string, floor: string): boolean {
	const identity = classifyModel(provider, modelId, { lenient: true });
	if (identity.class !== "glm" || !revisionAtLeast(identity.revision, floor)) return false;
	if (identity.family === "flash") return revisionAtLeast(identity.revision, "5.3");
	return identity.family === undefined || identity.family === "air" || identity.family === "turbo";
}

const MODELS_DEV_URL = "https://catalog.stencil.so/models.json.zstd";

/** Little-endian magic number opening every zstd frame (RFC 8878). */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Uses a cancellable timer rather than the native abort-timeout helper so
 * successful fast discovery requests do not leave armed timeout signals for
 * concurrent GC to trip over later.
 */
async function withCatalogDiscoveryTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_OAUTH_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";

export interface ModelsDevModel {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: Array<{ type?: string; values?: string[]; min?: number; max?: number }>;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
	status?: string;
	provider?: { npm?: string };
}

function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function toInputCapabilities(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) {
		return ["text"];
	}
	const supportsImage = value.some(item => item === "image");
	return supportsImage ? ["text", "image"] : ["text"];
}

/**
 * Catalog sessions are scoped to the fetch implementation that owns their
 * network and authentication context. Callers sharing one fetch reuse the same
 * conditional request state; isolated registries cannot observe each other's
 * payloads, ETags, or in-flight requests.
 */
interface CatalogSession {
	inflight: Promise<unknown> | null;
	payload: unknown;
	etag: string | null;
	hasPayload: boolean;
}

const defaultCatalogSession: CatalogSession = { inflight: null, payload: undefined, etag: null, hasPayload: false };
const catalogSessionsByFetch = new WeakMap<FetchImpl, CatalogSession>();

function getCatalogSession(fetchImpl: FetchImpl | undefined): CatalogSession {
	if (!fetchImpl) return defaultCatalogSession;
	const existing = catalogSessionsByFetch.get(fetchImpl);
	if (existing) return existing;
	const created: CatalogSession = { inflight: null, payload: undefined, etag: null, hasPayload: false };
	catalogSessionsByFetch.set(fetchImpl, created);
	return created;
}

function waitForCatalogRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return request;
	if (signal.aborted) return Promise.reject(signal.reason);
	const aborted = Promise.withResolvers<never>();
	const rejectAborted = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", rejectAborted, { once: true });
	return Promise.race([request, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", rejectAborted);
	});
}

const CATALOG_USER_AGENT = USER_AGENT;

/**
 * Fetches the models.dev catalog via catalog.stencil.so, which serves a
 * field-pruned copy precompressed as a zstd blob (~93 KB vs ~3.3 MB raw).
 * The frame magic is sniffed rather than trusting content-type so plain-JSON
 * responses (test stubs, fallback mirrors) parse identically.
 *
 * Fetched fully once per fetch context: concurrent callers sharing a fetch
 * implementation reuse one transport request, while repeat callers send a
 * conditional GET that the server answers with `304`. Each subscriber may stop
 * waiting independently; the shared transport retains its own hard deadline.
 * Transient failures reuse the last in-memory payload for callers that only
 * need best-effort metadata.
 */
export function fetchWellKnownModels(fetchImpl?: FetchImpl, signal?: AbortSignal): Promise<unknown> {
	const session = getCatalogSession(fetchImpl);
	return fetchRevalidatedWellKnownModels(fetchImpl, signal).catch(error => {
		if (session.hasPayload) return session.payload;
		throw error;
	});
}

function fetchRevalidatedWellKnownModels(fetchImpl?: FetchImpl, signal?: AbortSignal): Promise<unknown> {
	const session = getCatalogSession(fetchImpl);
	if (!session.inflight) {
		session.inflight = withCatalogDiscoveryTimeout(DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS, transportSignal =>
			fetchCatalogPayload(fetchImpl ?? discoveryFetch(), session, transportSignal),
		).finally(() => {
			session.inflight = null;
		});
	}
	return waitForCatalogRequest(session.inflight, signal);
}

function fetchRevalidatedWellKnownModelsWithTimeout(
	fetchImpl?: FetchImpl,
	timeoutMs = DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
): Promise<unknown> {
	return withCatalogDiscoveryTimeout(timeoutMs, signal => fetchRevalidatedWellKnownModels(fetchImpl, signal));
}

async function fetchCatalogPayload(
	fetchImpl: FetchImpl,
	session: CatalogSession,
	signal?: AbortSignal,
): Promise<unknown> {
	const headers: Record<string, string> = {
		Accept: "application/zstd, application/json",
		"User-Agent": CATALOG_USER_AGENT,
	};
	if (session.hasPayload && session.etag) {
		headers["If-None-Match"] = session.etag;
	}
	const response = await fetchImpl(MODELS_DEV_URL, { method: "GET", headers, signal });
	if (response.status === 304 && session.hasPayload) {
		return session.payload;
	}
	if (!response.ok) {
		throw new Error(`models catalog fetch failed: ${response.status}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const isZstd = bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === ZSTD_MAGIC;
	const text = new TextDecoder().decode(isZstd ? await Bun.zstdDecompress(bytes) : bytes);
	const payload: unknown = JSON.parse(text);
	session.payload = payload;
	session.etag = response.headers.get("etag");
	session.hasPayload = true;
	return payload;
}

function mapAnthropicModelsDev(payload: unknown, baseUrl: string): ModelSpec<"anthropic-messages">[] {
	if (!isRecord(payload)) {
		return [];
	}
	const anthropicPayload = payload.anthropic;
	if (!isRecord(anthropicPayload)) {
		return [];
	}
	const modelsValue = anthropicPayload.models;
	if (!isRecord(modelsValue)) {
		return [];
	}

	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, rawModel] of Object.entries(modelsValue)) {
		if (!isRecord(rawModel)) {
			continue;
		}
		const model = rawModel as ModelsDevModel;
		if (model.tool_call !== true) {
			continue;
		}
		models.push({
			id: modelId,
			name: toModelName(model.name, modelId),
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl,
			reasoning: model.reasoning === true,
			input: toInputCapabilities(model.modalities?.input),
			cost: {
				input: toNumber(model.cost?.input) ?? 0,
				output: toNumber(model.cost?.output) ?? 0,
				cacheRead: toNumber(model.cost?.cache_read) ?? 0,
				cacheWrite: toNumber(model.cost?.cache_write) ?? 0,
			},
			contextWindow: toPositiveNumber(model.limit?.context, null),
			maxTokens: toPositiveNumber(model.limit?.output, null),
		});
	}

	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}

function buildAnthropicDiscoveryHeaders(apiKey: string): Record<string, string> {
	const oauthToken = isAnthropicOAuthToken(apiKey);
	const headers: Record<string, string> = {
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": ANTHROPIC_OAUTH_BETA,
	};
	if (oauthToken) {
		headers.Authorization = `Bearer ${apiKey}`;
	} else {
		headers["x-api-key"] = apiKey;
	}
	return headers;
}

function buildAnthropicReferenceMap(
	modelsDevModels: readonly ModelSpec<"anthropic-messages">[],
): Map<string, ModelSpec<"anthropic-messages">> {
	const merged = new Map<string, ModelSpec<"anthropic-messages">>();
	for (const model of modelsDevModels) {
		merged.set(model.id, model);
	}
	// Anthropic /v1/models does not carry token limits, so bundled metadata stays canonical
	// for known models while models.dev only fills gaps for newly discovered ids.
	const bundledModels = getBundledModels("anthropic").filter(
		(model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages",
	);
	for (const model of bundledModels) {
		merged.set(model.id, toModelSpec(model));
	}
	return merged;
}

/**
 * Curated Anthropic models that are live or limited-availability on the
 * first-party `/v1/models` endpoint but that models.dev has not catalogued yet.
 * Seeded into model generation so the bundled catalog is never gated on
 * models.dev's update cadence; deduped behind upstream catalog / models.dev
 * entries once those appear. Token limits and pricing are pinned either directly or
 * in `applyAnthropicCatalogPolicy`, and `thinking` is re-baked
 * by the generator's policy pass (scripts/generated-policies.ts).
 */
export const ANTHROPIC_CURATED_FALLBACK_MODELS: readonly ModelSpec<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-mythos-5",
		name: "Claude Mythos 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
];

function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<TApi>,
	reference: ModelSpec<TApi> | undefined,
): ModelSpec<TApi> {
	const name = toModelName(entry.name, reference?.name ?? defaults.name);
	if (!reference) {
		return {
			...defaults,
			name,
		};
	}
	return {
		...reference,
		id: defaults.id,
		name,
		api: defaults.api,
		provider: defaults.provider,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

function normalizeAnthropicBaseUrl(baseUrl: string | undefined, fallback: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return fallback;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toAnthropicDiscoveryBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

async function fetchOllamaNativeModels(
	baseUrl: string,
	resolveMetadata: (modelId: string) => Promise<OllamaResolvedMetadata>,
	fetchImpl: FetchImpl = discoveryFetch(),
): Promise<ModelSpec<"openai-responses">[] | null> {
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	let response: Response;
	try {
		response = await fetchImpl(`${nativeBaseUrl}/api/tags`, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	const entries = payload.models ?? [];
	const resolved = await Promise.all(
		entries.map(async (entry): Promise<ModelSpec<"openai-responses"> | null> => {
			const id = entry.model ?? entry.name;
			if (!id) return null;
			const metadata = await resolveMetadata(id);
			return {
				id,
				name: entry.name ?? id,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				reasoning: metadata.reasoning ?? false,
				input: metadata.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.contextWindow,
				maxTokens: metadata.maxTokens,
			};
		}),
	);
	const models: ModelSpec<"openai-responses">[] = resolved.filter(
		(m): m is ModelSpec<"openai-responses"> => m !== null,
	);
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Fallback context window for Ollama models when `/api/show` is unavailable
 * or omits a `model_info.<arch>.context_length` field. Matches the size
 * Ollama's cloud catalog reports for stock models.
 */
const OLLAMA_FALLBACK_CONTEXT_WINDOW = 128_000;
/** Cap max output tokens at a value that matches OMP's other openai-responses defaults. */
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

interface OllamaResolvedMetadata {
	contextWindow: number;
	maxTokens: number;
	capabilities?: string[];
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

interface OllamaShowMetadata {
	contextWindow?: number;
	maxTokens?: number;
	capabilities?: string[];
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

function getOllamaContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number" || value <= 0) {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getOllamaCapabilities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * Query Ollama's `/api/show` endpoint for a single model and pull native
 * context and capability metadata from the response. Returns `undefined` when
 * the endpoint is unavailable so callers can layer their own fallback.
 */
async function fetchOllamaShowMetadata(
	nativeBaseUrl: string,
	modelId: string,
	fetchImpl: FetchImpl = discoveryFetch(),
): Promise<OllamaShowMetadata | undefined> {
	try {
		const response = await fetchImpl(`${nativeBaseUrl}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ model: modelId }),
		});
		if (!response.ok) {
			return undefined;
		}
		const payload = (await response.json()) as { capabilities?: unknown; model_info?: Record<string, unknown> };
		const capabilities = getOllamaCapabilities(payload.capabilities);
		const contextWindow = getOllamaContextWindow(payload.model_info);
		return {
			contextWindow,
			maxTokens: contextWindow ? OLLAMA_DEFAULT_MAX_TOKENS : undefined,
			capabilities,
			reasoning: capabilities ? capabilities.includes("thinking") : undefined,
			input: capabilities
				? capabilities.includes("vision")
					? (["text", "image"] as Array<"text" | "image">)
					: (["text"] as Array<"text">)
				: undefined,
		};
	} catch {
		// fall through; caller decides on the fallback
	}
	return undefined;
}

/**
 * Build a resolver that fetches `/api/show` metadata per model id and caches
 * the result in-memory for the lifetime of the manager. Successful lookups are
 * cached so repeated `fetchDynamicModels` calls do not refetch; failed
 * lookups stay uncached so a later refresh can recover.
 */
function createOllamaMetadataResolver(
	nativeBaseUrl: string,
	fetchImpl?: FetchImpl,
): (modelId: string) => Promise<OllamaResolvedMetadata> {
	const cache = new Map<string, Promise<OllamaResolvedMetadata>>();
	return modelId => {
		const cached = cache.get(modelId);
		if (cached) return cached;
		const pending = (async () => {
			const metadata = await fetchOllamaShowMetadata(nativeBaseUrl, modelId, fetchImpl);
			if (!metadata) {
				cache.delete(modelId);
				return { contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW, maxTokens: OLLAMA_DEFAULT_MAX_TOKENS };
			}
			return {
				...metadata,
				contextWindow: metadata.contextWindow ?? OLLAMA_FALLBACK_CONTEXT_WINDOW,
				maxTokens: metadata.maxTokens ?? OLLAMA_DEFAULT_MAX_TOKENS,
			};
		})();
		cache.set(modelId, pending);
		void pending.catch(() => cache.delete(modelId));
		return pending;
	};
}

function isLikelyOpenAIResponsesModelId(
	id: string,
	references?: ReadonlyMap<string, ModelSpec<"openai-responses">>,
): boolean {
	const trimmed = id.trim();
	if (!trimmed) {
		return false;
	}
	if (references?.has(trimmed)) {
		return true;
	}
	return isLikelyOpenAIResponsesId(trimmed);
}

/** Regex matching NanoGPT `:thinking` suffixed model IDs (with or without a level). */
const NANO_GPT_THINKING_SUFFIX_RE = /:thinking(:[^:]+)?$/;

function isLikelyNanoGptTextModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (NANO_GPT_THINKING_SUFFIX_RE.test(normalized)) {
		return false;
	}
	return !isExcludedModel("nanogpt", normalized);
}

type SimpleProviderDiscoveryHeaders = Record<string, string> | (() => Record<string, string> | undefined);
type SimpleProviderConfig = {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	headers?: SimpleProviderDiscoveryHeaders;
};

function resolveSimpleProviderHeaders(
	headers: SimpleProviderDiscoveryHeaders | undefined,
): Record<string, string> | undefined {
	return typeof headers === "function" ? headers() : headers;
}

type OpenAICompatibleModelManagerBuilderOptions<TApi extends Api> = {
	api: TApi;
	providerId: GeneratedProvider;
	defaultBaseUrl: string;
	config?: SimpleProviderConfig;
	headers?: SimpleProviderDiscoveryHeaders;
	dynamicModelsAuthoritative?: true;
	requireApiKey?: true;
	dropCachedModelIdsOnStaticMismatch?: readonly string[];
	filterModel?: (
		entry: OpenAICompatibleModelRecord,
		model: ModelSpec<TApi>,
		references: Map<string, ModelSpec<TApi>>,
	) => boolean;
	mapModel: (
		entry: OpenAICompatibleModelRecord,
		defaults: ModelSpec<TApi>,
		reference: ModelSpec<TApi> | undefined,
	) => ModelSpec<TApi> | null;
};

function createOpenAICompatibleModelManagerOptions<TApi extends Api>(
	options: OpenAICompatibleModelManagerBuilderOptions<TApi>,
): ModelManagerOptions<TApi> {
	const apiKey = options.config?.apiKey;
	const baseUrl = options.config?.baseUrl ?? options.defaultBaseUrl;
	const references = createBundledReferenceMap<TApi>(options.providerId);
	const filterModel = options.filterModel;
	return {
		providerId: options.providerId,
		...(options.dynamicModelsAuthoritative && { dynamicModelsAuthoritative: true }),
		...(options.dropCachedModelIdsOnStaticMismatch && {
			dropCachedModelIdsOnStaticMismatch: options.dropCachedModelIdsOnStaticMismatch,
		}),
		...((!options.requireApiKey || apiKey) && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: options.api,
					provider: options.providerId,
					baseUrl,
					apiKey,
					...(options.headers && { headers: resolveSimpleProviderHeaders(options.headers) }),
					...(filterModel && {
						filterModel: (entry, model) => filterModel(entry, model, references),
					}),
					mapModel: (entry, defaults) => options.mapModel(entry, defaults, references.get(defaults.id)),
					fetch: options.config?.fetch,
				}),
		}),
	};
}

export function createSimpleOpenAICompletionsOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId,
		defaultBaseUrl,
		config,
		headers: config?.headers,
		requireApiKey: true,
		mapModel: mapWithBundledReference,
	});
}

function createSimpleAnthropicProviderOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrlFallback: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAnthropicBaseUrl(config?.baseUrl, defaultBaseUrlFallback);
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "anthropic-messages",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					headers: buildAnthropicDiscoveryHeaders(apiKey),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						return {
							...model,
							name: toModelName(entry.display_name, model.name),
							baseUrl,
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// Umans AI Coding Plan
// ---------------------------------------------------------------------------

const UMANS_BASE_URL = "https://api.code.umans.ai";
const UMANS_MODELS_INFO_PATH = "/models/info";
const UMANS_REASONING_EFFORT_BY_LEVEL: Record<string, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};
const UMANS_DEFAULT_REASONING_EFFORTS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
const UMANS_VIA_HANDOFF_MODEL_IDS = ["umans-glm-5.1", "umans-glm-5.2"] as const;

export interface UmansModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface UmansModelInfo {
	name?: unknown;
	display_name?: unknown;
	capabilities?: unknown;
}

function normalizeUmansBaseUrl(baseUrl: string | undefined): string {
	const normalized = normalizeAnthropicBaseUrl(baseUrl, UMANS_BASE_URL);
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

/**
 * Umans `models/info` reports `supports_vision: true` for natively
 * vision-capable models and a non-empty string sentinel (e.g.
 * `"via-handoff"`) for models that route image inputs through a vision
 * handoff pre-analysis step instead of accepting raw image blocks. Only
 * `true` means the model accepts image content directly; sentinel values
 * MUST map to text-only so the agent's vision-handoff path runs instead
 * of triggering an upstream HTTP 400 (`This model does not support image
 * inputs`).
 */
function umansSupportsVision(value: unknown): boolean {
	return value === true;
}

function umansReasoningSupported(value: unknown): boolean {
	return isRecord(value) ? value.supported === true : value === true;
}

function mapUmansReasoningEfforts(value: unknown): readonly Effort[] {
	if (!isRecord(value) || !Array.isArray(value.levels)) {
		return UMANS_DEFAULT_REASONING_EFFORTS;
	}
	const efforts: Effort[] = [];
	for (const level of value.levels) {
		if (typeof level !== "string") continue;
		const effort = UMANS_REASONING_EFFORT_BY_LEVEL[level];
		if (effort !== undefined && !efforts.includes(effort)) {
			efforts.push(effort);
		}
	}
	return efforts.length > 0 ? efforts : UMANS_DEFAULT_REASONING_EFFORTS;
}

function umansHasMaxReasoningLevel(value: unknown): boolean {
	return isRecord(value) && Array.isArray(value.levels) && value.levels.includes("max");
}

function mapUmansThinkingConfig(value: unknown): ThinkingConfig | undefined {
	if (!umansReasoningSupported(value)) return undefined;
	const efforts = mapUmansReasoningEfforts(value);
	const thinking: ThinkingConfig = {
		mode: umansHasMaxReasoningLevel(value) ? "anthropic-budget-effort" : "budget",
		efforts,
	};
	if (isRecord(value)) {
		if (value.can_disable === false) {
			thinking.requiresEffort = true;
		}
		if (typeof value.default_level === "string") {
			const defaultLevel = UMANS_REASONING_EFFORT_BY_LEVEL[value.default_level];
			if (defaultLevel !== undefined && efforts.includes(defaultLevel)) {
				thinking.defaultLevel = defaultLevel;
			}
		}
	}
	return thinking;
}

function mapUmansModelInfo(
	modelId: string,
	raw: UmansModelInfo,
	baseUrl: string,
	reference: ModelSpec<"anthropic-messages"> | undefined,
): ModelSpec<"anthropic-messages"> | null {
	if (!modelId) return null;
	const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
	const supportsTools = capabilities.supports_tools;
	const thinking = mapUmansThinkingConfig(capabilities.reasoning);
	return {
		...reference,
		id: modelId,
		name: toModelName(raw.display_name, toModelName(raw.name, modelId)),
		api: "anthropic-messages",
		provider: "umans",
		baseUrl,
		compat: { ...reference?.compat, escapeBuiltinToolNames: true },
		reasoning: thinking !== undefined,
		...(thinking ? { thinking } : {}),
		input: umansSupportsVision(capabilities.supports_vision) ? ["text", "image"] : ["text"],
		...(supportsTools === false ? { supportsTools: false } : {}),
		cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: toPositiveNumber(capabilities.context_window, reference?.contextWindow ?? null),
		maxTokens: toPositiveNumber(
			capabilities.recommended_max_tokens,
			toPositiveNumber(capabilities.max_completion_tokens, reference?.maxTokens ?? null),
		),
	};
}

async function fetchUmansModelsInfo(options: {
	baseUrl: string;
	apiKey?: string;
	fetch?: FetchImpl;
	references: Map<string, ModelSpec<"anthropic-messages">>;
}): Promise<ModelSpec<"anthropic-messages">[] | null> {
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(options.baseUrl);
	const requestHeaders: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) {
		requestHeaders["x-api-key"] = options.apiKey;
	}
	const fetchImpl = discoveryFetch(options.fetch);
	let payload: unknown;
	try {
		const response = await fetchImpl(`${discoveryBaseUrl}${UMANS_MODELS_INFO_PATH}`, {
			method: "GET",
			headers: requestHeaders,
		});
		if (!response.ok) {
			return null;
		}
		payload = await response.json();
	} catch (error) {
		throw new Error("Failed to fetch Umans models info", { cause: error });
	}
	if (!isRecord(payload)) {
		return null;
	}
	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;
		const mapped = mapUmansModelInfo(modelId, value, options.baseUrl, options.references.get(modelId));
		if (mapped) {
			models.push(mapped);
		}
	}
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

export function umansModelManagerOptions(config?: UmansModelManagerConfig): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeUmansBaseUrl(config?.baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">("umans");
	return {
		providerId: "umans",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: UMANS_VIA_HANDOFF_MODEL_IDS,
		fetchDynamicModels: () => fetchUmansModelsInfo({ baseUrl, apiKey, fetch: config?.fetch, references }),
	};
}
// ---------------------------------------------------------------------------
// 1. OpenAI
// ---------------------------------------------------------------------------

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
// Curated seed pricing for approval-gated aliases stencil.so does not list
// yet; upstream catalog rows outrank these once discovery serves them.
/** Standard GPT-5.6 Sol rates used by the Daybreak Blue aliases. */
const OPENAI_GPT_56_SOL_STANDARD_COST = {
	input: 5,
	output: 30,
	cacheRead: 0.5,
	cacheWrite: 6.25,
} as const satisfies TokenCost;

/** Standard GPT-5.6 Cyber rates used by the Daybreak Red aliases. */
const OPENAI_GPT_56_CYBER_STANDARD_COST = {
	input: 12.5,
	output: 75,
	cacheRead: 1.25,
	cacheWrite: 15.625,
} as const satisfies TokenCost;

export interface OpenAIModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function openaiModelManagerOptions(config?: OpenAIModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-responses",
		providerId: "openai",
		defaultBaseUrl: OPENAI_API_BASE_URL,
		config,
		requireApiKey: true,
		filterModel: (_entry, model, references) => isLikelyOpenAIResponsesModelId(model.id, references),
		mapModel: mapWithBundledReference,
	});
}

/**
 * Daybreak models are approval-gated first-party Responses models that are not
 * yet present in stencil.so. Seed the documented aliases and current Cyber
 * snapshot so fresh installs expose them without credentialed discovery.
 */
export const OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS: readonly ModelSpec<"openai-responses">[] = [
	{
		id: "daybreak-blue-latest",
		name: "Daybreak Blue",
		api: "openai-responses",
		provider: "openai",
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		// The >272K long-context tier is rule-owned (`providers/openai.kdl`
		// long-context-cost) and baked at build time.
		cost: OPENAI_GPT_56_SOL_STANDARD_COST,
		contextWindow: 1_050_000,
		maxTokens: 128_000,
	},
	{
		id: "daybreak-red-latest",
		name: "Daybreak Red",
		api: "openai-responses",
		provider: "openai",
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: OPENAI_GPT_56_CYBER_STANDARD_COST,
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.6-cyber",
		name: "GPT-5.6 Cyber",
		api: "openai-responses",
		provider: "openai",
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: OPENAI_GPT_56_CYBER_STANDARD_COST,
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
];

/**
 * A row this generator pass owns: one of the derived `gpt-5.6-*-pro` alias ids
 * on a swept provider that carries the generated `reasoningMode` marker.
 * A real upstream model occupying the same id has no `reasoningMode` and is
 * never touched.
 * The reviewed base-id and sweep tables live in the compiled discovery
 * vocabulary (`pro-reasoning-alias` / `pro-reasoning-sweep`).
 */
function isGeneratedOpenAIProReasoningAlias(model: ModelSpec<Api>): boolean {
	const { proReasoningAliases, proReasoningSweep } = discoveryVocabulary();
	return (
		proReasoningSweep.includes(model.provider) &&
		model.reasoningMode !== undefined &&
		model.id.endsWith("-pro") &&
		Object.values(proReasoningAliases).some(bases => bases.includes(model.id.slice(0, -"-pro".length)))
	);
}

/**
 * Re-derive the generated pro-reasoning aliases (`gpt-5.6-*-pro`) for the
 * first-party `openai` gpt-5.6 rows. Each alias inherits the base row's
 * metadata, requests the base wire id via `requestModelId`, and sets
 * `reasoningMode: "pro"` so Responses-family request builders emit
 * `reasoning: { mode: "pro" }`. Called by the models.json generator after all
 * sources merge: stale copies of the owned aliases (previous snapshot,
 * including retired `openai-codex` rows) are dropped and re-projected from the
 * current base rows so alias metadata always tracks the base, while a real
 * upstream model that occupies an alias id wins and suppresses the projection.
 */
export function projectOpenAIProReasoningAliases(models: readonly ModelSpec<Api>[]): ModelSpec<Api>[] {
	const kept = models.filter(model => !isGeneratedOpenAIProReasoningAlias(model));
	const ids = new Set(kept.map(model => `${model.provider}/${model.id}`));
	const out = [...kept];
	for (const model of kept) {
		const bases = discoveryVocabulary().proReasoningAliases[model.provider];
		if (!bases?.includes(model.id)) continue;
		const aliasId = `${model.id}-pro`;
		const aliasKey = `${model.provider}/${aliasId}`;
		if (ids.has(aliasKey)) continue;
		ids.add(aliasKey);
		out.push({
			...model,
			id: aliasId,
			name: `${model.name} Pro`,
			requestModelId: model.id,
			reasoningMode: "pro",
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1b. GMI Cloud
// ---------------------------------------------------------------------------

const GMI_CLOUD_BASE_URL = "https://api.gmi-serving.com/v1";

/**
 * Bundled seed for GMI Cloud. Generation has no `GMI_API_KEY`, so a regen
 * without credentials would leave the provider slice empty and the declared
 * `defaultModel` unresolvable on a fresh install before the async runtime
 * discovery fires. Live `/v1/models` discovery is authoritative for the model
 * ID set and overrides context/max-token limits, but `mapWithBundledReference`
 * keeps the reference's cost/reasoning/thinking — so these fields carry GMI's
 * direct-tariff values: V4-Flash at $0.14/$0.28 per 1M with Think High/Max
 * modes per GMI's launch post
 * (https://www.gmicloud.ai/en/blog/deepseek-v4-is-here-we-tested-it), not
 * discounted gateway-route pricing. GMI publishes no cache-read tariff, so
 * cacheRead stays 0 until a direct source confirms cached-token billing.
 */
export const GMI_CLOUD_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "deepseek-ai/DeepSeek-V4-Flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "gmi-cloud",
		baseUrl: GMI_CLOUD_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 384000,
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	},
];

export interface GmiCloudModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Map a discovered GMI Cloud model to a full spec.
 *
 * GMI's `/v1/models` returns only bare `{id}` rows, so discovery defaults carry
 * no limits, reasoning, or thinking metadata. When a gmi-cloud bundled
 * reference exists (the seeded default) it supplies GMI's published tariff and
 * limits directly. Every other id is an open-weight model GMI resells under its
 * canonical id (`deepseek-ai/…`, `moonshotai/…`, `zai-org/…`, `Qwen/…`), so its
 * intrinsic capabilities — context window, output limit, reasoning, thinking
 * ladder — are recovered from any bundled upstream entry via the canonical
 * reference index. Pricing is deliberately never borrowed across providers:
 * GMI's per-model tariff is unknown for these ids, so cost stays zeroed rather
 * than inheriting another provider's rate.
 */
function mapGmiCloudModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	if (reference) {
		return mapWithBundledReference(entry, defaults, reference);
	}
	const canonical = resolveModelReference(defaults.id, getBundledModelReferenceIndex()) as
		| ModelSpec<"openai-completions">
		| undefined;
	if (!canonical) {
		return { ...defaults, name: toModelName(entry.name, defaults.name) };
	}
	const contextWindow = canonical.contextWindow ?? defaults.contextWindow;
	const maxTokens =
		canonical.maxTokens != null && contextWindow != null
			? Math.min(canonical.maxTokens, contextWindow)
			: (canonical.maxTokens ?? defaults.maxTokens);
	return {
		...defaults,
		name: toModelName(entry.name, canonical.name ?? defaults.name),
		reasoning: canonical.reasoning,
		input: canonical.input,
		...(canonical.thinking && { thinking: canonical.thinking }),
		contextWindow,
		maxTokens,
	};
}

export function gmiCloudModelManagerOptions(
	config?: GmiCloudModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "gmi-cloud",
		defaultBaseUrl: GMI_CLOUD_BASE_URL,
		config,
		requireApiKey: true,
		mapModel: mapGmiCloudModel,
	});
}

// ---------------------------------------------------------------------------
// 2. Groq
// ---------------------------------------------------------------------------

export interface GroqModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config);
}

// ---------------------------------------------------------------------------
// 3. Cerebras
// ---------------------------------------------------------------------------

export interface CerebrasModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cerebrasModelManagerOptions(
	config?: CerebrasModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "cerebras",
		defaultBaseUrl: "https://api.cerebras.ai/v1",
		config,
		requireApiKey: true,
		mapModel: (entry, defaults, reference) => mapWithBundledReference(entry, defaults, reference),
	});
}

// ---------------------------------------------------------------------------
// 4. Hugging Face
// ---------------------------------------------------------------------------

export interface HuggingfaceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function huggingfaceModelManagerOptions(
	config?: HuggingfaceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("huggingface", "https://router.huggingface.co/v1", config);
}

// ---------------------------------------------------------------------------
// 5. NVIDIA
// ---------------------------------------------------------------------------

export interface NvidiaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nvidiaModelManagerOptions(
	config?: NvidiaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("nvidia", "https://integrate.api.nvidia.com/v1", config);
}

// ---------------------------------------------------------------------------
// 5.5 Novita
// ---------------------------------------------------------------------------

/** Novita OpenAI-compatible discovery configuration. */
export interface NovitaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function novitaArrayIncludes(value: unknown, expected: string): boolean {
	return Array.isArray(value) && value.some(item => item === expected);
}

function isPublicNovitaModelId(id: string): boolean {
	return !id.toLowerCase().startsWith("ai_infer_test");
}

// Novita reports token prices in 1/10,000 USD per million tokens.
function toNovitaCostPerMillion(value: unknown): number {
	return toPositiveNumber(value, 0) / 10_000;
}

function getNovitaCacheReadPricePerMillion(entry: OpenAICompatibleModelRecord): number {
	const pricing = entry.pricing;
	if (!isRecord(pricing)) {
		return 0;
	}
	const cacheRead = pricing.input_cache_read;
	if (!isRecord(cacheRead)) {
		return 0;
	}
	return toNovitaCostPerMillion(cacheRead.price_per_m);
}

function mapNovitaModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	const model = mapWithBundledReference(
		{
			...entry,
			name: entry.display_name ?? entry.title ?? entry.name,
		},
		defaults,
		reference,
	);
	return {
		...model,
		reasoning: novitaArrayIncludes(entry.features, "reasoning"),
		supportsTools: novitaArrayIncludes(entry.features, "function-calling"),
		input: toInputCapabilities(entry.input_modalities),
		cost: {
			input: toNovitaCostPerMillion(entry.input_token_price_per_m),
			output: toNovitaCostPerMillion(entry.output_token_price_per_m),
			cacheRead: getNovitaCacheReadPricePerMillion(entry),
			cacheWrite: 0,
		},
		contextWindow: toPositiveNumber(entry.context_size, model.contextWindow),
		maxTokens: toPositiveNumber(entry.max_output_tokens, model.maxTokens),
	};
}

/** Builds Novita's public model-discovery manager. */
export function novitaModelManagerOptions(
	config?: NovitaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "novita",
		defaultBaseUrl: "https://api.novita.ai/openai/v1",
		config,
		dynamicModelsAuthoritative: true,
		filterModel: (entry, model) => {
			const active = typeof entry.status !== "number" || entry.status === 1;
			return (
				active &&
				isPublicNovitaModelId(model.id) &&
				novitaArrayIncludes(entry.endpoints, "chat/completions") &&
				toPositiveNumber(entry.max_output_tokens, 0) > 0
			);
		},
		mapModel: mapNovitaModel,
	});
}

// ---------------------------------------------------------------------------
// 5.6 DeepInfra
// ---------------------------------------------------------------------------

export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
/**
 * `filter=with_meta` attaches per-model `metadata` (limits, pricing, tags);
 * `sort_by=omp` asks DeepInfra to return models in omp-priority order
 * (earlier = better). The mapper does not stamp `priority` yet — see
 * `mapDeepinfraModel` — but the params are sent so discovery picks the
 * ordering up as soon as the server honors it.
 */
const DEEPINFRA_MODELS_QUERY = "?filter=with_meta&sort_by=omp";
const DEEPINFRA_EFFORTS = [Effort.Low, Effort.Medium, Effort.High] as const;

/** DeepInfra OpenAI-compatible discovery configuration. */
export interface DeepinfraModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface DeepinfraModelEntry {
	id?: unknown;
	metadata?: unknown;
}

function deepinfraTags(metadata: Record<string, unknown>): readonly string[] {
	const tags = metadata.tags;
	return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

/**
 * Map one DeepInfra catalog entry to a chat model spec. Non-`chat` entries
 * (`tts`, `stt`, `embed`, `image-gen`, `video-gen`) are dropped — those
 * surfaces are served by dedicated tool backends, not the chat catalog.
 * DeepInfra reports token prices in USD per 1M tokens — omp's `ModelCost`
 * unit, used verbatim. A bundled reference (when the generated catalog has
 * one) is spread first so compat/tooling metadata can contribute, but the
 * live metadata always wins for limits, pricing, and modalities.
 */
function mapDeepinfraModel(
	entry: DeepinfraModelEntry,
	baseUrl: string,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> | null {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) {
		return null;
	}
	const metadata = isRecord(entry.metadata) ? entry.metadata : {};
	const tags = deepinfraTags(metadata);
	if (!tags.includes("chat")) {
		return null;
	}
	const pricing = isRecord(metadata.pricing) ? metadata.pricing : {};
	// `reasoning_effort` marks models whose effort dial is advertised. The
	// parameter itself is validated and accepted platform-wide on DeepInfra
	// (verified: 200 on effort-tagged, reasoning-only, and plain-chat models;
	// 422 only for out-of-enum values), so a bundled reference's effort ladder
	// surviving the `...reference` spread after a tag disappears is harmless —
	// the host ignores the dial rather than rejecting the request.
	const thinking: ThinkingConfig | undefined = tags.includes("reasoning_effort")
		? { mode: "effort", efforts: [...DEEPINFRA_EFFORTS] }
		: undefined;
	const contextWindow = toPositiveNumber(metadata.context_length, reference?.contextWindow ?? null);
	// `metadata.max_tokens` mirrors `context_length` on every live row today —
	// it is the total token ceiling, not an output cap (the catalog exposes no
	// output-specific field). Stamping it into `maxTokens` would advertise
	// `output === context` for every model and default oversized `max_tokens`
	// onto models with smaller real output limits. Trust it only when it is
	// strictly below the context window (i.e. the API starts publishing a real
	// output cap); otherwise keep the bundled reference's cap (stencil.so fill
	// during generation) or leave the limit unknown so requests defer to the
	// server-side cap.
	const liveMaxTokens = toPositiveNumber(metadata.max_tokens, 0);
	const hasLiveOutputCap = contextWindow !== null && liveMaxTokens > 0 && liveMaxTokens < contextWindow;
	// A same-id reference carries the canonical deployment's output cap, which
	// can exceed the (smaller) window DeepInfra serves — e.g. a 500K cap against
	// a 256K context. An output cap above the context ceiling is meaningless, so
	// keep the fallback inside the window.
	const referenceMaxTokens = reference?.maxTokens ?? null;
	const maxTokens = hasLiveOutputCap
		? liveMaxTokens
		: referenceMaxTokens !== null && contextWindow !== null
			? Math.min(referenceMaxTokens, contextWindow)
			: referenceMaxTokens;
	return {
		...reference,
		id,
		name: reference?.name ?? id,
		api: "openai-completions",
		provider: "deepinfra",
		baseUrl,
		reasoning: tags.includes("reasoning") || tags.includes("reasoning_effort"),
		...(thinking ? { thinking } : {}),
		input: tags.includes("vision") || tags.includes("vlm") ? ["text", "image"] : ["text"],
		cost: {
			input: toPositiveNumber(pricing.input_tokens, 0),
			output: toPositiveNumber(pricing.output_tokens, 0),
			cacheRead: toPositiveNumber(pricing.cache_read_tokens, 0),
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
	};
}

/**
 * Bespoke fetch instead of `fetchOpenAICompatibleModels`: the shared helper
 * cannot carry the `filter`/`sort_by` query params and re-sorts results by id,
 * which would destroy DeepInfra's priority ordering once the server honors
 * `sort_by=omp`. Response order is preserved (dedupe keeps the first, i.e.
 * highest-priority, occurrence).
 */
async function fetchDeepinfraModels(options: {
	baseUrl: string;
	apiKey?: string;
	fetch?: FetchImpl;
	references: Map<string, ModelSpec<"openai-completions">>;
}): Promise<ModelSpec<"openai-completions">[] | null> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}
	const fetchImpl = discoveryFetch(options.fetch);
	let payload: unknown;
	try {
		const response = await withCatalogDiscoveryTimeout(DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS, signal =>
			fetchImpl(`${options.baseUrl}/models${DEEPINFRA_MODELS_QUERY}`, { method: "GET", headers, signal }),
		);
		if (!response.ok) {
			return null;
		}
		payload = await response.json();
	} catch {
		return null;
	}
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		return null;
	}
	const models: ModelSpec<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const entry of payload.data) {
		if (!isRecord(entry)) {
			continue;
		}
		const reference = typeof entry.id === "string" ? options.references.get(entry.id) : undefined;
		const mapped = mapDeepinfraModel(entry as DeepinfraModelEntry, options.baseUrl, reference);
		if (mapped && !seen.has(mapped.id)) {
			seen.add(mapped.id);
			models.push(mapped);
		}
	}
	return models;
}

/**
 * Builds DeepInfra's model-discovery manager. The catalog endpoint is public,
 * so discovery (and keyless `gen:models` generation) works without an API key;
 * model availability at runtime is still gated on credentials by the registry.
 */
export function deepinfraModelManagerOptions(
	config?: DeepinfraModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = (config?.baseUrl ?? DEEPINFRA_BASE_URL).replace(/\/$/, "");
	const references = createBundledReferenceMap<"openai-completions">("deepinfra");
	return {
		providerId: "deepinfra",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: () => fetchDeepinfraModels({ baseUrl, apiKey, fetch: config?.fetch, references }),
	};
}

// ---------------------------------------------------------------------------
// 6. xAI
// ---------------------------------------------------------------------------

export interface XaiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

// SuperGrok surfaces a few models under IDs that differ from their public
// `xai` catalog equivalent, so the exact-ID price fallback misses them. Map
// the OAuth ID to the paid ID it mirrors.
// The alias map lives in the `pricing-peer` behavior rule.
function hasTokenPrice(cost: ModelSpec["cost"]): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

/**
 * Mirrors exact public-model prices onto matching SuperGrok catalog rows.
 * The >200K long-context tier itself is rule-owned (`classes/xai.kdl`
 * `long-context-cost` multiplier axis) and derives at build time.
 */
export function applyXaiCatalogPricing(models: readonly ModelSpec[]): ModelSpec[] {
	const publicCosts = new Map(
		models
			.filter(model => model.provider === "xai" && hasTokenPrice(model.cost))
			.map(model => [model.id, model.cost]),
	);

	return models.map(model => {
		if (model.provider !== "xai-oauth" || hasTokenPrice(model.cost)) return model;
		const peer = pricingPeerFor("xai-oauth", model.id);
		const publicCost =
			publicCosts.get(model.id) ?? (peer && peer.peerId !== model.id ? publicCosts.get(peer.peerId) : undefined);
		return publicCost ? { ...model, cost: { ...publicCost } } : model;
	});
}

export function xaiModelManagerOptions(config?: XaiModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	return {
		...createOpenAICompatibleModelManagerOptions({
			api: "openai-responses",
			providerId: "xai",
			defaultBaseUrl: "https://api.x.ai/v1",
			config,
			requireApiKey: true,
			mapModel: mapWithBundledReference,
		}),
		// Completions → Responses migration: a fresh authoritative cache written
		// by the old resolver stores `api: "openai-completions"` for these ids.
		// Without a drop list, `online-if-uncached` skips the network and
		// `mergeDynamicModel` lets the cached api win over the new static
		// Responses entries until TTL expiry.
		dropCachedModelIdsOnStaticMismatch: getBundledModels("xai").map(model => model.id),
	};
}

export interface XaiOAuthModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface XAICuratedModel {
	id: string;
	contextWindow: number;
	name?: string;
	/** Whether the model reasons natively. Defaults to true for Grok-4.x family. */
	reasoning?: boolean;
	/**
	 * Whether xAI accepts the `reasoning.effort` wire param for this model.
	 * Default true. When false: the picker hides the effort dial (via
	 * getSupportedEfforts in model-thinking.ts) AND the wire omits the param.
	 * Both read the compat engine's resolved reasoning-effort axes.
	 */
	supportsReasoningEffort?: boolean;
	/**
	 * Input modalities this model accepts. Defaults to `["text"]` when absent.
	 * Vision-capable Grok models MUST list `"image"` here so the curated layer
	 * overrides `fetchOpenAICompatibleModels`' default of `["text"]` (which
	 * otherwise strips image capability on every online refresh).
	 */
	input?: ("text" | "image")[];
}

// Source of truth for the xai-oauth chat picker. Top of list = headline.
// Context windows from hermes-agent/agent/model_metadata.py:205-220
// ("Values sourced from models.dev (2026-04)"). grok-build is xAI's
// coding-fine-tuned chat model; 512K context per user spec (2026-05-17).
//
// supportsReasoningEffort=false entries reason natively but reject the wire
// `reasoning.effort` param (api.x.ai returns HTTP 400). The corresponding
// omit/include/history replay defaults live in catalog compat so every
// OpenAI-family endpoint consumes the same constraint.
export const XAI_OAUTH_CURATED_MODELS: readonly XAICuratedModel[] = [
	{
		id: "grok-build",
		contextWindow: 512_000,
		name: "Grok Build",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-build-0.1",
		contextWindow: 256_000,
		name: "Grok Build 0.1",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{ id: "grok-4.3", contextWindow: 1_000_000, name: "Grok 4.3", input: ["text", "image"] },
	{ id: "grok-4.5", contextWindow: 500_000, name: "Grok 4.5", input: ["text", "image"] },
	{ id: "grok-4.6", contextWindow: 500_000, name: "Grok 4.6", input: ["text", "image"] },
	// grok-4.20-multi-agent-0309 is text-only per the bundled catalog; omit `input` for the default.
	{ id: "grok-4.20-multi-agent-0309", contextWindow: 2_000_000, name: "Grok 4.20 (Multi-Agent)" },
	{
		id: "grok-4.20-0309-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Reasoning)",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
	},
	// Cursor's "Composer 2.5 Fast" exposed via SuperGrok: non-reasoning,
	// text-only, 200K context (mirrors Cursor's composer-* catalog entries).
	// Off the Grok effort-capable allowlist; reasoning:false also hides the effort dial.
	{
		id: "grok-composer-2.5-fast",
		contextWindow: 200_000,
		name: "Grok Composer 2.5 Fast",
		reasoning: false,
		input: ["text"],
	},
] as const;

// xAI /v1/models returns chat, image, voice, and STT entries. Tool surfaces
// route through dedicated tools (generate_image, tts) with their own model
// strings; the chat picker MUST exclude these prefixes or selecting them 400s.
function withXaiOAuthCompatDefaults(model: ModelSpec<"openai-responses">): ModelSpec<"openai-responses"> {
	const compat = {
		...model.compat,
		includeEncryptedReasoning: model.compat?.includeEncryptedReasoning ?? true,
		filterReasoningHistory: model.compat?.filterReasoningHistory ?? false,
		supportsImageDetailOriginal: model.compat?.supportsImageDetailOriginal ?? false,
		omitReasoningEffort: model.compat?.omitReasoningEffort ?? resolveModelPolicy(model).compat.omitReasoningEffort,
	};
	return { ...model, compat };
}

// Hermes-agent parity for `minimal -> low` (see hermes-agent/agent/transports/
// codex.py:92). Multi-agent Grok keeps `xhigh` unmapped (agent-count mode);
// other first-party SKUs clamp leftover `xhigh`/`max` to `high`.
// `resolveModelThinking` folds this into `model.thinking.effortMap`.

/**
 * Bake first-party xAI Responses effort-dial metadata onto a catalog spec.
 *
 * models.dev marks many Grok SKUs as reasoners and the thinking rebake would
 * otherwise emit a default `minimal/low/medium/high` dial. api.x.ai
 * accepts `reasoning.effort` only for ids selected by the compat rule —
 * off-allowlist reasoners (`grok-code-fast-1`, `grok-build-0.1`,
 * `grok-4.20-0309-reasoning`, …) 400 if the param is sent. SuperGrok
 * (`xai-oauth`) already curates this via {@link mergeCuratedIntoModel}; paid
 * `xai` rows come from stencil.so and need the same wire facts in the exported
 * `models.json` so direct catalog readers do not present an unsupported dial.
 *
 * Explicit `compat.supportsReasoningEffort` / `omitReasoningEffort` win.
 */
export function applyXaiResponsesThinkingPolicy(model: ModelSpec<"openai-responses">): ModelSpec<"openai-responses"> {
	const effortCapable =
		model.compat?.supportsReasoningEffort ?? resolveModelPolicy(model).compat.supportsReasoningEffort;
	const compat = {
		...model.compat,
		supportsReasoningEffort: effortCapable,
		omitReasoningEffort: model.compat?.omitReasoningEffort ?? !effortCapable,
	};
	if (effortCapable) {
		compat.reasoningEffortMap = { ...xaiResponsesReasoningEffortMap(model.id) };
	} else {
		delete compat.reasoningEffortMap;
	}
	return { ...model, compat };
}

// xai-oauth's /v1/models exposes no per-request output limit on the OAuth
// (Grok Build / SuperGrok) surface, so the curated catalog owns `maxTokens`
// like it owns `contextWindow`: each entry mirrors its context window. The
// openai-responses wire clamps the actual request to
// min(requested, model.maxTokens, OPENAI_MAX_OUTPUT_TOKENS=64000), so this is
// just "no model-specific sub-cap below 64k", not an unbounded output budget.

// Single source of truth for curated → Model fan-in. Used by the static-seed
// and the dynamic overlay/inject paths (applyXAIOAuthCuration) so curated
// reasoning/effort flags survive an online refresh (xAI's /v1/models lacks
// reasoning metadata and fetchOpenAICompatibleModels defaults reasoning to
// false). Caller supplies a `base` Model (either a freshly synthesised seed
// or a dynamic-fetched entry); the helper layers curated fields on top.
// The effort remap from {@link xaiResponsesReasoningEffortMap} is merged
// only onto effort-capable rows. Off-allowlist reasoners omit the wire
// param, so a map on those specs is dead weight.
// The effort-dial pair (`supportsReasoningEffort`/`omitReasoningEffort`) is
// authoritative: a stale flag on `base` (previous snapshot or dynamic fetch)
// must not outlive a compat-rule change.
function mergeCuratedIntoModel(
	base: ModelSpec<"openai-responses">,
	curated: XAICuratedModel,
): ModelSpec<"openai-responses"> {
	const effortCapable =
		curated.supportsReasoningEffort ??
		resolveModelPolicy({ ...base, id: curated.id, provider: "xai-oauth" }).compat.supportsReasoningEffort;
	const compat = {
		...base.compat,
		includeEncryptedReasoning: base.compat?.includeEncryptedReasoning ?? true,
		filterReasoningHistory: false,
		supportsImageDetailOriginal: base.compat?.supportsImageDetailOriginal ?? false,
		omitReasoningEffort: !effortCapable,
		supportsReasoningEffort: effortCapable,
	};
	if (effortCapable) {
		compat.reasoningEffortMap = { ...xaiResponsesReasoningEffortMap(curated.id) };
	} else {
		delete compat.reasoningEffortMap;
	}
	return {
		...base,
		contextWindow: curated.contextWindow,
		maxTokens: curated.contextWindow,
		name: curated.name ?? base.name,
		reasoning: curated.reasoning ?? true,
		input: curated.input ?? base.input,
		compat,
	};
}

/**
 * Overlay/inject curated xai-oauth metadata onto dynamic-fetch results so
 * a successful `online refresh` doesn't regress vision capability, context
 * window, reasoning flags, or the effort-dial allowlist.
 *
 * Three passes:
 *   1. Filter `XAI_NON_CHAT_PREFIXES` (picker pollution defense for tool
 *      surfaces routed through dedicated tools — generate_image, tts).
 *   2. Overlay curated metadata onto dynamic-fetch matches. xAI's /v1/models
 *      does not return context_window or reasoning metadata, so without
 *      this overlay the runtime falls back to the bundled-reference default
 *      (effectively 128k context) and `reasoning: false` (suppressing the
 *      effort dial and stripping thinking metadata downstream).
 *   3. Inject curated entries missing from the dynamic fetch. Clones the
 *      first surviving entry as a template so required Model fields (api,
 *      provider, baseUrl, cost, etc.) inherit sane defaults. If `filtered`
 *      is empty (offline / no auth) injection is skipped — the descriptor's
 *      defaultModel covers the fallback.
 *
 * Order: curated models first in declaration order; then dynamic remainder
 * in original order.
 */
function applyXAIOAuthCuration(dynamic: readonly ModelSpec<"openai-responses">[]): ModelSpec<"openai-responses">[] {
	const filtered = dynamic.filter(e => !isExcludedModel("xai-oauth", e.id));

	const byId = new Map<string, ModelSpec<"openai-responses">>(filtered.map(e => [e.id, e]));
	for (const curated of XAI_OAUTH_CURATED_MODELS) {
		const existing = byId.get(curated.id);
		if (existing) {
			byId.set(curated.id, mergeCuratedIntoModel(existing, curated));
		}
	}

	const template = filtered[0];
	if (template) {
		for (const curated of XAI_OAUTH_CURATED_MODELS) {
			if (!byId.has(curated.id)) {
				// Reset id/name on the template before merging so the helper's
				// `curated.name ?? base.name` clause falls back to curated.id
				// (the inject contract), not to the unrelated template's label.
				const base: ModelSpec<"openai-responses"> = { ...template, id: curated.id, name: curated.id };
				byId.set(curated.id, mergeCuratedIntoModel(base, curated));
			}
		}
	}

	const curatedIds = new Set(XAI_OAUTH_CURATED_MODELS.map(c => c.id));
	const curatedFirst = XAI_OAUTH_CURATED_MODELS.map(c => byId.get(c.id)).filter(
		(e): e is ModelSpec<"openai-responses"> => e !== undefined,
	);
	const rest = filtered.filter(e => !curatedIds.has(e.id)).map(withXaiOAuthCompatDefaults);
	return [...curatedFirst, ...rest];
}

/**
 * Render `XAI_OAUTH_CURATED_MODELS` as full `ModelSpec<"openai-responses">` entries.
 *
 * Single source of truth for the curated to Model fan-in, consumed by both
 * - {@link xaiOAuthModelManagerOptions} (runtime static seed handed to the model
 *   manager so the picker is populated on a fresh login), and
 * - \`packages/catalog/scripts/generate-models.ts\` (bundles the same entries into
 *   `models.json`, so the synchronous `ModelRegistry.#loadModels()` boot path
 *   sees `xai-oauth` without waiting for a refresh — fixes the boot-time
 *   default-model reset when `modelRoles.default = "xai-oauth/<id>"`).
 *
 * `reasoning` defaults to `true` for the Grok-4.x family; the explicit
 * `grok-4.20-0309-non-reasoning` entry opts out via `XAICuratedModel.reasoning`.
 * `maxTokens` mirrors each model's `contextWindow` (the OAuth surface reports
 * no per-request output limit); the openai-responses wire still clamps the
 * actual request to OPENAI_MAX_OUTPUT_TOKENS. Mirrors
 * `hermes-agent/hermes_cli/models.py:_XAI_STATIC_FALLBACK`.
 */
export function buildXaiOAuthStaticSeed(baseUrl?: string): ModelSpec<"openai-responses">[] {
	const resolvedBaseUrl = baseUrl ?? "https://api.x.ai/v1";
	return XAI_OAUTH_CURATED_MODELS.map(curated => {
		// Synthesise a bare base then layer curated metadata via the same helper
		// the dynamic overlay/inject paths use. `name: curated.id` is a sentinel
		// the helper rewrites to `curated.name ?? base.name`, so curated.name
		// wins when set.
		const base: ModelSpec<"openai-responses"> = {
			id: curated.id,
			name: curated.id,
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: resolvedBaseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: curated.contextWindow,
			maxTokens: curated.contextWindow,
			compat: { reasoningEffortMap: xaiResponsesReasoningEffortMap(curated.id) },
		};
		return mergeCuratedIntoModel(base, curated);
	});
}

export function xaiOAuthModelManagerOptions(
	config?: XaiOAuthModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const defaultBaseUrl = "https://api.x.ai/v1";
	const resolvedBaseUrl = config?.baseUrl ?? defaultBaseUrl;
	const base = createOpenAICompatibleModelManagerOptions({
		api: "openai-responses",
		providerId: "xai-oauth",
		defaultBaseUrl,
		config,
		requireApiKey: true,
		mapModel: mapWithBundledReference,
	});
	// Static seed handed to the runtime model manager so the picker populates on
	// a fresh login even before `fetchDynamicModels` fires (it is gated on
	// `config.apiKey` at construction time, and OAuth tokens resolve later via
	// AuthStorage). \`generate-models.ts\` calls the same builder so \`models.json\`
	// carries these entries too — making the synchronous `#loadModels()` boot
	// path honor `modelRoles.default = "xai-oauth/<id>"` without `await refresh()`.
	const staticModels = buildXaiOAuthStaticSeed(resolvedBaseUrl);
	if (!base.fetchDynamicModels) {
		return { ...base, staticModels };
	}
	// Wrap fetchDynamicModels so an `online refresh` against xAI's /v1/models
	// runs through applyXAIOAuthCuration — preserves curated context windows,
	// vision modality, reasoning flags, and filters tool-only model ids
	// (grok-imagine-*, grok-stt-*, grok-voice-*) from the chat picker.
	const inner = base.fetchDynamicModels;
	return {
		...base,
		staticModels,
		fetchDynamicModels: async () => {
			const dynamic = await inner();
			return dynamic == null ? dynamic : applyXAIOAuthCuration(dynamic);
		},
	};
}

// ---------------------------------------------------------------------------
// 6.4 AIML API
// ---------------------------------------------------------------------------

export function isLikelyAimlApiChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) return false;
	return !isExcludedModel("aimlapi", normalized);
}

export interface AimlApiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function aimlApiModelManagerOptions(
	config?: AimlApiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "aimlapi",
		defaultBaseUrl: "https://api.aimlapi.com/v1",
		config,
		dynamicModelsAuthoritative: true,
		requireApiKey: true,
		filterModel: (_entry, model) => isLikelyAimlApiChatModelId(model.id),
		mapModel: mapWithBundledReference,
	});
}

// ---------------------------------------------------------------------------
// 6.5 DeepSeek
// ---------------------------------------------------------------------------

export interface DeepSeekModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function deepseekModelManagerOptions(
	config?: DeepSeekModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("deepseek", "https://api.deepseek.com", config);
}

// ---------------------------------------------------------------------------
// 6.6 SiliconFlow
// ---------------------------------------------------------------------------

export interface SiliconFlowModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * SiliconFlow's `/v1/models` lists every served model — including embeddings,
 * rerankers, image, audio, and video generators that cannot serve chat
 * completions — and carries no per-model type field, so non-chat entries are
 * dropped by id to keep the picker usable.
 */
export function isLikelySiliconFlowChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return !isExcludedModel("siliconflow", normalized);
}

/**
 * models.dev mappings consulted ONLY as a runtime metadata reference during
 * dynamic discovery. They are deliberately absent from
 * `MODELS_DEV_PROVIDER_DESCRIPTORS` so `generate-models.ts` never bundles
 * SiliconFlow models — the live endpoint decides which models exist, while
 * these entries hydrate the pricing, limits, and reasoning metadata that the
 * endpoint's bare `{id}` rows do not carry. No filter: the join against live
 * discovered ids already restricts hydration to chat models.
 */
const SILICONFLOW_MODELS_DEV_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	openAiCompletionsDescriptor("siliconflow", "siliconflow", "https://api.siliconflow.com/v1", {
		filterModel: () => true,
	}),
	openAiCompletionsDescriptor("siliconflow-cn", "siliconflow-cn", "https://api.siliconflow.cn/v1", {
		filterModel: () => true,
	}),
];

const SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS = 5_000;

async function loadSiliconFlowModelsDevReferences(
	providerId: "siliconflow" | "siliconflow-cn",
	fetchImpl?: FetchImpl,
): Promise<Map<string, ModelSpec<"openai-completions">>> {
	const descriptor = SILICONFLOW_MODELS_DEV_DESCRIPTORS.find(d => d.providerId === providerId);
	if (!descriptor) {
		return new Map();
	}
	try {
		// Bounded: this enrichment is optional, so a stalled models.dev must not
		// hold back the authoritative endpoint request that runs after it.
		const payload = await withCatalogDiscoveryTimeout(SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS, signal =>
			fetchWellKnownModels(fetchImpl, signal),
		);
		return createModelsDevReferenceMap<"openai-completions">(
			mapModelsDevToModels(payload as Record<string, unknown>, [descriptor]),
		);
	} catch {
		return new Map();
	}
}

function createSiliconFlowModelManagerOptions(
	providerId: "siliconflow" | "siliconflow-cn",
	defaultBaseUrl: string,
	config?: SiliconFlowModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	return {
		providerId,
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevReferences = await loadSiliconFlowModelsDevReferences(providerId, config?.fetch);
				// Resolved here, not at options construction: walking the bundled
				// reference index is only worth paying for when dynamic discovery
				// actually runs, keeping the ModelManager cache fast path cheap.
				const canonicalReferences = getBundledModelReferenceIndex();
				return fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isLikelySiliconFlowChatModelId(model.id),
					mapModel: (entry, defaults) => {
						const modelsDevReference = modelsDevReferences.get(defaults.id);
						if (modelsDevReference) {
							return mapWithBundledReference(entry, defaults, modelsDevReference);
						}
						// ids missing from models.dev (new launches) still recover intrinsic
						// capabilities and canonical limits from any bundled upstream/reseller
						// entry — but never its pricing, which is provider-specific.
						const canonical = resolveModelReference(defaults.id, canonicalReferences) as
							| ModelSpec<"openai-completions">
							| undefined;
						if (!canonical) {
							return defaults;
						}
						const contextWindow = canonical.contextWindow ?? defaults.contextWindow;
						const maxTokens =
							canonical.maxTokens != null && contextWindow != null
								? Math.min(canonical.maxTokens, contextWindow)
								: (canonical.maxTokens ?? defaults.maxTokens);
						return {
							...defaults,
							name: toModelName(entry.name, canonical.name ?? defaults.name),
							reasoning: canonical.reasoning,
							input: canonical.input,
							contextWindow,
							maxTokens,
						};
					},
					fetch: config?.fetch,
				});
			},
		}),
	};
}

export function siliconflowModelManagerOptions(
	config?: SiliconFlowModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSiliconFlowModelManagerOptions("siliconflow", "https://api.siliconflow.com/v1", config);
}

export function siliconflowCnModelManagerOptions(
	config?: SiliconFlowModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSiliconFlowModelManagerOptions("siliconflow-cn", "https://api.siliconflow.cn/v1", config);
}

// ---------------------------------------------------------------------------
// 6.7 Zhipu Coding Plan
// ---------------------------------------------------------------------------

export interface ZhipuCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zhipuCodingPlanModelManagerOptions(
	config?: ZhipuCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
	return {
		providerId: "zhipu-coding-plan",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "zhipu-coding-plan",
					baseUrl,
					apiKey,
					mapModel: (
						_entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const id = defaults.id;
						const identity = classifyModel("zhipu-coding-plan", id, { lenient: true });
						return {
							...defaults,
							reasoning:
								isGlmReasoningIdentity("zhipu-coding-plan", id, "4.5") || identity.thinkingVariant === true,
							// Vision-capable families are rule-owned (`providers/zhipu-coding-plan.kdl`
							// input-modalities) and corrected at build time.
							input: ["text"],
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 7.5 Fireworks
// ---------------------------------------------------------------------------

/**
 * Fireworks-published cap for the Kimi K2 family. Fireworks' `/v1/models`
 * envelope generically reports `max_completion_tokens: 65536` for every Kimi
 * deployment, but Kimi K2 (instruct / thinking / turbo) on Fireworks is
 * documented to ship long reasoning traces that should be bounded — capping
 * at 32,768 prevents handing callers a budget the router cannot honor.
 * See https://github.com/can1357/oh-my-pi/issues/1849.
 */
export const FIREWORKS_KIMI_MAX_TOKENS = 32_768;

/**
 * Fireworks' output ceiling for Kimi K2.7-Code specifically. Its `/v1/models`
 * generic `max_completion_tokens` is 65,536 and Fireworks serves it in full —
 * verified with a single completion emitting 58,971 output tokens and
 * `max_tokens: 200000` accepted without error. Unlike the older K2.5/K2.6
 * family (see {@link FIREWORKS_KIMI_MAX_TOKENS}), K2.7-Code is not clamped to
 * 32,768; that ceiling only truncated it.
 */
export const FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65_536;

/**
 * Returns true for the Kimi K2.5 / K2.6 family served by Fireworks-backed
 * providers (`fireworks` direct, `firepass` router) that share the 32,768
 * `maxTokens` ceiling. Matches both the public catalog id (`kimi-k2.5`,
 * `kimi-k2.6`, `kimi-k2.6-turbo`) and the canonical Fireworks wire id
 * (`accounts/fireworks/{models,routers}/kimi-k2…`).
 *
 * K2.7-Code (incl. `-fast` / `-highspeed`) is deliberately excluded: unlike the
 * earlier K2 family it serves its full context on Fireworks — verified with a
 * single completion emitting 58,971 output tokens and `max_tokens: 200000`
 * accepted without error — so the 32,768 cap would only truncate it. It inherits
 * Fireworks' reported `max_completion_tokens` (65,536) instead.
 */
export function isFireworksKimiK2ModelId(modelId: string): boolean {
	const identity = classifyModel("fireworks", modelId, { lenient: true });
	if (identity.class !== "kimi" || identity.family === "k2.7-code") return false;
	return identity.family?.startsWith("k2") === true;
}

/**
 * Clamp the Kimi K2 family's `maxTokens` to {@link FIREWORKS_KIMI_MAX_TOKENS}
 * on Fireworks-backed providers, leaving every other model untouched.
 */
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number): number;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isFireworksKimiK2ModelId(modelId) ? Math.min(candidate, FIREWORKS_KIMI_MAX_TOKENS) : candidate;
}

/**
 * Kimi K2.7 Code's documented recommended output budget. Some provider
 * discovery rows report the context-sized `max_completion_tokens` instead.
 */
export const KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS = 32_768;

export function isKimiK27CodeModelId(modelId: string): boolean {
	const identity = classifyModel("fireworks", modelId, { lenient: true });
	return identity.class === "kimi" && identity.family === "k2.7-code";
}

export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number): number;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isKimiK27CodeModelId(modelId) ? Math.min(candidate, KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS) : candidate;
}

/**
 * Fireworks Fast variants we surface. Each inherits the base model's
 * limits/modalities/thinking and overrides only the cost with the Standard-column
 * Fast prices from the Serverless pricing table; `cacheWrite` stays 0 (Fireworks
 * bills no cache-write). Derived from the bundled base entries so metadata stays
 * in lockstep, and the runtime auto-falls back to the base id on a failed fast
 * request. See https://docs.fireworks.ai/serverless/pricing.
 */
const FIREWORKS_FAST_VARIANT_SPECS: ReadonlyArray<{
	base: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number };
}> = [
	{ base: "kimi-k2.7-code", name: "Kimi K2.7 Code Fast", cost: { input: 1.9, output: 8, cacheRead: 0.38 } },
	{ base: "kimi-k2.6", name: "Kimi K2.6 Fast", cost: { input: 2, output: 8, cacheRead: 0.3 } },
	{ base: "glm-5.1", name: "GLM-5.1 Fast", cost: { input: 2.8, output: 8.8, cacheRead: 0.52 } },
	{ base: "glm-5.2", name: "GLM-5.2 Fast", cost: { input: 2.1, output: 6.6, cacheRead: 0.21 } },
];

/**
 * Build the Fireworks Fast seed by projecting each base bundled spec into a
 * `<id>-fast` variant. Pushed into the generated catalog (Fast routers never
 * appear in the serverless control-plane list, so discovery cannot surface
 * them) and deduped behind any identical previous-snapshot entry.
 */
export function buildFireworksFastSeed(): ModelSpec<"openai-completions">[] {
	const bundled = createBundledReferenceMap<"openai-completions">("fireworks");
	const seeds: ModelSpec<"openai-completions">[] = [];
	for (const variant of FIREWORKS_FAST_VARIANT_SPECS) {
		const base = bundled.get(variant.base);
		if (!base) continue;
		seeds.push({
			...base,
			id: `${variant.base}${FIREWORKS_FAST_SUFFIX}`,
			name: variant.name,
			cost: {
				input: variant.cost.input,
				output: variant.cost.output,
				cacheRead: variant.cost.cacheRead,
				cacheWrite: 0,
			},
		});
	}
	return seeds;
}

/**
 * Fireworks DeepSeek V4 accepts effort via `reasoning_effort` but rejects the
 * DeepSeek-native binary `thinking` toggle when both are present.
 */
export function stripFireworksDeepSeekThinkingToggle(
	model: ModelSpec<"openai-completions">,
	publicModelId: string,
): ModelSpec<"openai-completions"> {
	if (!isDeepseekV4Generation("fireworks", publicModelId)) return model;
	const compat = model.compat;
	if (!compat?.extraBody || !("thinking" in compat.extraBody)) return model;

	const extraBody = { ...compat.extraBody };
	delete extraBody.thinking;
	if (Object.keys(extraBody).length > 0) {
		return { ...model, compat: { ...compat, extraBody } };
	}

	const nextCompat = { ...compat };
	delete nextCompat.extraBody;
	return { ...model, compat: nextCompat };
}

export interface FireworksModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const FIREWORKS_CONTROL_PLANE_ACCOUNT = "fireworks";
const FIREWORKS_SERVERLESS_FILTER = "supports_serverless=true";
const FIREWORKS_CONTROL_PLANE_PAGE_SIZE = 200;
const FIREWORKS_CONTROL_PLANE_MAX_PAGES = 25;

/**
 * One record from the Fireworks control-plane catalog
 * (`GET /v1/accounts/{account}/models`). This is distinct from the
 * OpenAI-compatible `/v1/models` inference envelope: the control plane
 * enumerates the full serverless catalog with camelCase capability metadata,
 * including on-demand models (e.g. `kimi-k2p7-code`) that never surface in
 * `/v1/models`. Discovering here is what keeps new serverless models appearing
 * without catalog edits — see the Fireworks docs `List Models` API.
 */
interface FireworksControlPlaneModel {
	/** Resource name, e.g. `accounts/fireworks/models/kimi-k2p7-code`. */
	name?: unknown;
	displayName?: unknown;
	contextLength?: unknown;
	supportsImageInput?: unknown;
	supportsTools?: unknown;
	supportsServerless?: unknown;
	state?: unknown;
}

/**
 * Derive the control-plane list endpoint from the inference base URL. The
 * inference API lives under `/inference/v1` while the control plane is
 * `/v1/accounts/<account>/models` on the same origin, so we route off origin.
 * Returns null for unparseable overrides (custom gateways) so discovery falls
 * back to the cached/bundled catalog.
 */
function toFireworksControlPlaneModelsUrl(baseUrl: string, account: string): string | null {
	try {
		return `${new URL(baseUrl).origin}/v1/accounts/${account}/models`;
	} catch {
		return null;
	}
}

function mapFireworksControlPlaneModel(
	record: FireworksControlPlaneModel,
	publicModelId: string,
	reference: ModelSpec<"openai-completions"> | undefined,
	baseUrl: string,
): ModelSpec<"openai-completions"> {
	const name = toModelName(record.displayName, reference?.name ?? publicModelId);
	const supportsImage = toBoolean(record.supportsImageInput) === true;
	const supportsTools = toBoolean(record.supportsTools);
	const contextWindow = toPositiveNumber(record.contextLength, reference?.contextWindow ?? null);
	// The control plane reports no max-output budget. Default K2.7-Code to its
	// verified 65,536 ceiling, the older K2.5/K2.6 family to the clamped 32,768,
	// everyone else to the discovery fallback, then clamp.
	const fallbackMaxTokens = isKimiK27CodeModelId(publicModelId)
		? FIREWORKS_KIMI_K27_CODE_MAX_TOKENS
		: isFireworksKimiK2ModelId(publicModelId)
			? FIREWORKS_KIMI_MAX_TOKENS
			: null;
	const maxTokens = clampFireworksKimiMaxTokens(publicModelId, reference?.maxTokens ?? fallbackMaxTokens);
	const base: ModelSpec<"openai-completions"> = reference ?? {
		id: publicModelId,
		name,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
	const model: ModelSpec<"openai-completions"> = {
		...base,
		id: publicModelId,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		name,
		// The control plane exposes capability flags but no reasoning bit. Every
		// serverless chat LLM Fireworks ships reasons, and `buildModel` derives
		// the Fireworks effort map from the id at build time — so default
		// unbundled models to reasoning while bundled references keep their value.
		reasoning: reference?.reasoning ?? true,
		input: supportsImage ? ["text", "image"] : (reference?.input ?? ["text"]),
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools: false } : {}),
	};
	return stripFireworksDeepSeekThinkingToggle(model, publicModelId);
}

/**
 * Discover Fireworks serverless models via the control-plane `List Models`
 * API (`supports_serverless=true`), paginating the full catalog. Returns null
 * on any transport/protocol failure so the model manager keeps the cached or
 * bundled catalog rather than caching a truncated list as authoritative.
 */
async function fetchFireworksServerlessModels(options: {
	baseUrl: string;
	apiKey: string;
	resolveReference: (publicModelId: string) => ModelSpec<"openai-completions"> | undefined;
	fetch?: FetchImpl;
}): Promise<ModelSpec<"openai-completions">[] | null> {
	const listUrl = toFireworksControlPlaneModelsUrl(options.baseUrl, FIREWORKS_CONTROL_PLANE_ACCOUNT);
	if (!listUrl) return null;
	const fetchImpl = discoveryFetch(options.fetch);
	const collected = new Map<string, ModelSpec<"openai-completions">>();
	let pageToken = "";
	for (let page = 0; page < FIREWORKS_CONTROL_PLANE_MAX_PAGES; page++) {
		const url = new URL(listUrl);
		url.searchParams.set("filter", FIREWORKS_SERVERLESS_FILTER);
		url.searchParams.set("pageSize", String(FIREWORKS_CONTROL_PLANE_PAGE_SIZE));
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		let response: Response;
		try {
			response = await fetchImpl(url.toString(), {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			});
		} catch {
			return null;
		}
		if (!response.ok) return null;
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return null;
		}
		if (!isRecord(payload)) return null;
		const models = Array.isArray(payload.models) ? payload.models : [];
		for (const entry of models) {
			if (!isRecord(entry)) continue;
			const record = entry as FireworksControlPlaneModel;
			if (toBoolean(record.supportsServerless) !== true) continue;
			if (typeof record.state === "string" && record.state !== "READY") continue;
			const wireName = typeof record.name === "string" ? record.name : "";
			if (!wireName) continue;
			const publicModelId = toFireworksPublicModelId(wireName);
			if (!publicModelId) continue;
			collected.set(
				publicModelId,
				mapFireworksControlPlaneModel(
					record,
					publicModelId,
					options.resolveReference(publicModelId),
					options.baseUrl,
				),
			);
		}
		const next = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
		if (!next) break;
		pageToken = next;
	}
	return Array.from(collected.values());
}

function createModelsDevReferenceMap<TApi extends Api>(
	models: readonly ModelSpec<Api>[],
): Map<string, ModelSpec<TApi>> {
	const references = new Map<string, ModelSpec<TApi>>();
	for (const model of models) {
		const candidate = model as ModelSpec<TApi>;
		const existing = references.get(candidate.id);
		if (!existing) {
			references.set(candidate.id, candidate);
			continue;
		}
		if ((candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
			references.set(candidate.id, candidate);
			continue;
		}
		if (
			candidate.contextWindow === existing.contextWindow &&
			(candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0)
		) {
			references.set(candidate.id, candidate);
		}
	}
	return references;
}

async function loadModelsDevReferences<TApi extends Api>(fetchImpl?: FetchImpl): Promise<Map<string, ModelSpec<TApi>>> {
	try {
		const payload = await fetchWellKnownModels(fetchImpl);
		return createModelsDevReferenceMap<TApi>(
			mapModelsDevToModels(payload as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS),
		);
	} catch {
		return new Map<string, ModelSpec<TApi>>();
	}
}
export function fireworksModelManagerOptions(
	config?: FireworksModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.fireworks.ai/inference/v1";
	const bundledReferences = createReferenceResolver(() =>
		createBundledReferenceMap<"openai-completions">("fireworks"),
	);
	return {
		providerId: "fireworks",
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevReferences = await loadModelsDevReferences<"openai-completions">(config?.fetch);
				return fetchFireworksServerlessModels({
					baseUrl,
					apiKey,
					resolveReference: publicModelId =>
						modelsDevReferences.get(publicModelId) ?? bundledReferences(publicModelId),
					fetch: config?.fetch,
				});
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 7.6 Fire Pass (Fireworks Kimi K2.6 Turbo subscription)
// ---------------------------------------------------------------------------

export interface FirepassModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Fire Pass is a Fireworks subscription product that exposes a single router
 * model (Kimi K2.6 Turbo) under `accounts/fireworks/routers/kimi-k2p6-turbo`.
 * The dedicated `fpk_…` keys do not authorize `/v1/models`, so this manager
 * never performs dynamic discovery — the bundled catalog entry is canonical.
 * See https://docs.fireworks.ai/firepass.
 */
export function firepassModelManagerOptions(
	_config?: FirepassModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return {
		providerId: "firepass",
	};
}

const CLINEPASS_MODELS_URL = `${CLINEPASS_API_BASE_URL}/ai/cline/recommended-models`;
const CLINEPASS_FALLBACK_CONTEXT_WINDOW = 128_000;
const CLINEPASS_FALLBACK_MAX_TOKENS = 8_192;

function buildClinePassFallbackModel(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "cline-pass",
		baseUrl: CLINEPASS_API_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CLINEPASS_FALLBACK_CONTEXT_WINDOW,
		maxTokens: CLINEPASS_FALLBACK_MAX_TOKENS,
		compat: { supportsReasoningEffort: false },
	};
}

/**
 * Live reference catalog mirroring Cline's own client enrichment: the official
 * CLI fills roster metadata from OpenRouter's public `/models` catalog (their
 * gateway routes through it), keyed by full id and by slug. Consulted only for
 * ids the bundled reference has no real upstream entry for: the bundle stays
 * authoritative for known ids, and unknown ids ride fresh live data instead of
 * the conservative constants until the next regen.
 */
interface ClinePassLiveCatalogEntry {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelSpec<"openai-completions">["cost"];
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

interface ClinePassLiveCatalog {
	byId: ReadonlyMap<string, ClinePassLiveCatalogEntry>;
	bySlug: ReadonlyMap<string, ClinePassLiveCatalogEntry>;
}

const CLINE_PASS_LIVE_CATALOG_URL = "https://openrouter.ai/api/v1/models";

/** Enrichment tier, never authoritative: any failure degrades to the bundled path. */
async function fetchClinePassLiveCatalog(fetchImpl: FetchImpl): Promise<ClinePassLiveCatalog | undefined> {
	try {
		const response = await withCatalogDiscoveryTimeout(5_000, signal =>
			fetchImpl(CLINE_PASS_LIVE_CATALOG_URL, { signal }),
		);
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
		const byId = new Map<string, ClinePassLiveCatalogEntry>();
		const bySlug = new Map<string, ClinePassLiveCatalogEntry>();
		for (const raw of payload.data) {
			if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) continue;
			const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
			const topProvider = isRecord(raw.top_provider) ? raw.top_provider : undefined;
			const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined;
			const modality = String(isRecord(raw.architecture) ? (raw.architecture.modality ?? "") : "");
			const contextWindow = toPositiveNumber(raw.context_length, 0);
			const maxTokens = toPositiveNumber(topProvider?.max_completion_tokens, 0);
			const entry: ClinePassLiveCatalogEntry = {
				...(typeof raw.name === "string" && raw.name ? { name: raw.name.replace(/^[^:]+:\s*/, "") } : {}),
				...(contextWindow > 0 ? { contextWindow } : {}),
				...(maxTokens > 0 ? { maxTokens } : {}),
				...(pricing
					? {
							cost: {
								input: parseFloat(String(pricing.prompt ?? "0")) * 1_000_000,
								output: parseFloat(String(pricing.completion ?? "0")) * 1_000_000,
								cacheRead: parseFloat(String(pricing.input_cache_read ?? "0")) * 1_000_000,
								cacheWrite: parseFloat(String(pricing.input_cache_write ?? "0")) * 1_000_000,
							},
						}
					: {}),
				...(params ? { reasoning: params.includes("reasoning") } : {}),
				...(modality
					? { input: modality.includes("image") ? (["text", "image"] as const) : (["text"] as const) }
					: {}),
			};
			byId.set(raw.id, entry);
			// Cline's `buildModelsNameMap` algorithm: roster ids are lab-less slugs
			// ("glm-5.2"), so the catalog is also keyed by its last id segment.
			const slug = raw.id.split("/").at(-1);
			if (slug) bySlug.set(slug, entry);
		}
		return byId.size > 0 ? { byId, bySlug } : undefined;
	} catch {
		return undefined;
	}
}

/** Zero legs mean "unpriced upstream", not "free" — pass models bill quota regardless. */
function hasClinePassBillableCost(cost: ModelSpec<"openai-completions">["cost"] | undefined): boolean {
	return cost !== undefined && (cost.input > 0 || cost.output > 0);
}

function buildCuratedClinePassModel(
	id: string,
	tier: "subscription" | "free",
): ModelSpec<"openai-completions"> | undefined {
	const metadata = getClinePassModelMetadata(id);
	if (!metadata || metadata.tier !== tier) return undefined;
	return {
		...buildClinePassFallbackModel(id),
		name: metadata.name,
		contextWindow: metadata.contextWindow,
		maxTokens: metadata.maxTokens,
		input: metadata.input,
		cost: metadata.cost,
		reasoning: metadata.reasoning,
		thinking: metadata.thinking,
		compat: {
			...(metadata.thinking === undefined ? { supportsReasoningEffort: false } : {}),
			...(tier === "free" ? { wireModelIdMode: "raw" as const } : {}),
		},
	};
}

/**
 * Subscription models bill against plan quota, not per token — but the catalog still
 * carries the upstream list price so cost display reads as API-equivalent spend. Same
 * policy as the codex/antigravity generator fixups and the zai PAYG descriptor swap
 * (issue #5598: an all-$0 roster surfaces every model as "free" in the picker, which
 * was treated as a bug there). The price comes from the bundled upstream reference,
 * so it works offline and survives roster refreshes (`preferDiscoveryCost` never lets
 * a zero overwrite it). Ids with no upstream reference keep the honest zero until
 * models.dev prices them.
 */
function buildClinePassSubscriptionModel(
	id: string,
	references: ReadonlyMap<string, ModelSpec<"openai-completions">>,
	liveCatalog?: ClinePassLiveCatalog,
): ModelSpec<"openai-completions"> {
	const curated = buildCuratedClinePassModel(id, "subscription");
	if (curated) return curated;
	const base = references.get(id) ?? buildClinePassFallbackModel(id);
	const reference = resolveModelReference(id, getBundledModelReferenceIndex());
	// A reference pointing back at the ClinePass bundle means the last regen
	// knew nothing about the id and encoded fallback constants — treat as none.
	const upstream = reference && reference.provider !== "cline-pass" ? reference : undefined;
	// Same degeneracy on the bundle side: a bundled entry whose limits are the
	// fallback pair was written by a regen that had no upstream data for the id.
	const baseLimitsAreFallback =
		base.contextWindow === CLINEPASS_FALLBACK_CONTEXT_WINDOW && base.maxTokens === CLINEPASS_FALLBACK_MAX_TOKENS;
	if (upstream) {
		// Known to the bundle with real limits: overlay the list price only.
		// Otherwise full enrichment, like the free-tier path.
		return references.has(id) && !baseLimitsAreFallback
			? { ...base, cost: upstream.cost }
			: {
					...base,
					name: references.has(id) ? base.name : upstream.name,
					reasoning: upstream.reasoning,
					input: upstream.input,
					cost: upstream.cost,
					contextWindow: upstream.contextWindow,
					maxTokens: upstream.maxTokens,
					...(upstream.reasoning ? {} : { thinking: undefined }),
				};
	}
	const live = liveCatalog?.bySlug.get(id);
	if (!live) return base;
	return {
		...base,
		...(live.name ? { name: live.name } : {}),
		...(live.contextWindow ? { contextWindow: live.contextWindow } : {}),
		...(live.maxTokens ? { maxTokens: live.maxTokens } : {}),
		...(hasClinePassBillableCost(live.cost) ? { cost: live.cost } : {}),
		...(live.reasoning !== undefined ? { reasoning: live.reasoning } : {}),
		...(live.input ? { input: live.input } : {}),
		...(live.reasoning === false ? { thinking: undefined } : {}),
	};
}

/**
 * Free-tier entries arrive as full OpenRouter-style ids (`deepseek/deepseek-v4-flash`,
 * `poolside/laguna-s-2.1:free`) and ride usage billing at $0 outside the subscription
 * quota — their cost is genuinely zero, unlike the subscription roster's list-price
 * display. Limits and modalities resolve through the bundled upstream reference (its
 * candidate expansion treats provider prefixes and trailing `:free`-style markers as
 * identity-preserving), so known models self-enrich offline. Compat and thinking are
 * deliberately NOT inherited: those describe the reference's native host, while the
 * Cline gateway dialect is resolved per provider/family. The raw wire tag is
 * bucket-derived — the gateway already namespaces these ids, so the cline-pass prefix
 * transform must never apply to them.
 */
function buildClinePassFreeModel(id: string, liveCatalog?: ClinePassLiveCatalog): ModelSpec<"openai-completions"> {
	const curated = buildCuratedClinePassModel(id, "free");
	if (curated) return curated;
	const reference = resolveModelReference(id, getBundledModelReferenceIndex());
	const upstream = reference && reference.provider !== "cline-pass" ? reference : undefined;
	// Free ids are OpenRouter-native, so the live catalog matches by full id
	// before falling back to the slug — the official client's own lookup order.
	const live = liveCatalog?.byId.get(id) ?? liveCatalog?.bySlug.get(id.split("/").at(-1) ?? id);
	// References can carry their own free markers (e.g. OpenRouter-style
	// "Laguna S 2.1 (free)"); strip before applying our single tier suffix.
	const baseName = (upstream?.name ?? live?.name ?? id.split("/").at(-1) ?? id)
		.replace(/\s*\(free\)\s*$/i, "")
		.replace(/:free$/i, "")
		.trim();
	const fallback = buildClinePassFallbackModel(id);
	const reasoning = upstream?.reasoning ?? live?.reasoning ?? fallback.reasoning;
	return {
		...fallback,
		name: `${baseName || id} (free)`,
		reasoning,
		input: upstream?.input ?? live?.input ?? fallback.input,
		contextWindow: upstream?.contextWindow ?? live?.contextWindow ?? fallback.contextWindow,
		maxTokens: upstream?.maxTokens ?? live?.maxTokens ?? fallback.maxTokens,
		// A non-reasoning reference must not carry the Cline effort ladder.
		...(reasoning ? {} : { thinking: undefined }),
		compat: { supportsReasoningEffort: false, wireModelIdMode: "raw" },
	};
}

async function fetchClinePassModels(
	fetchImpl: FetchImpl,
	references: ReadonlyMap<string, ModelSpec<"openai-completions">>,
): Promise<ModelSpec<"openai-completions">[]> {
	// The roster is authoritative for ids; the live reference catalog is a pure
	// enrichment tier fetched alongside and tolerated away (offline → bundle).
	const [response, liveCatalog] = await Promise.all([
		withCatalogDiscoveryTimeout(5_000, signal =>
			fetchImpl(CLINEPASS_MODELS_URL, { signal, headers: clinePassClientHeaders() }),
		),
		fetchClinePassLiveCatalog(fetchImpl),
	]);
	if (!response.ok) {
		throw new Error(`Failed to fetch ClinePass models: HTTP ${response.status}`);
	}
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.clinePass)) {
		throw new Error("ClinePass model catalog response is missing clinePass");
	}

	const models = new Map<string, ModelSpec<"openai-completions">>();
	for (const entry of payload.clinePass) {
		if (!isRecord(entry) || typeof entry.id !== "string") {
			continue;
		}
		const wireId = entry.id.trim();
		if (!wireId.startsWith("cline-pass/")) {
			continue;
		}
		const id = toClinePassPublicModelId(wireId).trim();
		if (!id) {
			continue;
		}
		models.set(id, buildClinePassSubscriptionModel(id, references, liveCatalog));
	}
	if (models.size === 0) {
		throw new Error("ClinePass model catalog contains no valid model IDs");
	}

	// Free tier rides the same key and gateway at $0 outside the subscription
	// quota. Optional overlay: entries validate individually, a cline-pass/-shaped
	// entry belongs to the pass bucket, pass ids win any collision, and pass-first
	// insertion order keeps the registry's first-available fallback on a
	// subscription model.
	const freeEntries = Array.isArray(payload.free) ? payload.free : [];
	for (const entry of freeEntries) {
		if (!isRecord(entry) || typeof entry.id !== "string") {
			continue;
		}
		const id = entry.id.trim();
		if (!id || id.startsWith("cline-pass/") || models.has(id)) {
			continue;
		}
		models.set(id, buildClinePassFreeModel(id, liveCatalog));
	}
	return [...models.values()];
}

/**
 * Cline's OpenAI-compatible `/models` route is absent, but its public
 * recommended-models endpoint is the authoritative ClinePass roster: the
 * `clinePass` bucket lists subscription models and the optional `free` bucket
 * adds $0 usage-billing models selectable with the same key. Metadata resolves
 * in three tiers: the current Cline-published metadata snapshot first, bundled
 * upstream references and OpenRouter enrichment for future ids second, then
 * conservative constants. Newly added ids remain usable before the next regen;
 * known ids retain exact Cline limits, plan pricing, and reasoning controls.
 */
export function clinePassModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const references = new Map(
		(getBundledModels("cline-pass") as Model<"openai-completions">[]).map(model => [model.id, toModelSpec(model)]),
	);
	const fetchImpl = discoveryFetch(config?.fetch);
	return {
		providerId: "cline-pass",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: () => fetchClinePassModels(fetchImpl, references),
	};
}

// ---------------------------------------------------------------------------
// 7.7 Wafer Serverless
// ---------------------------------------------------------------------------

export interface WaferModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const WAFER_DEFAULT_BASE_URL = "https://pass.wafer.ai/v1";
const WAFER_MAX_TOKENS_CAP = 65536;

/**
 * Mapper for Wafer Serverless `/v1/models` records.
 *
 * Wafer wraps each entry with a `wafer` envelope describing capabilities and
 * pricing. The mapper folds that metadata into the canonical
 * `ModelSpec<"openai-completions">` shape and applies upstream-specific thinking
 * compat when the entry advertises reasoning support. Wafer pricing is exposed
 * through internal wholesale units; the public Serverless rate equals
 * `cents × 125 / 10000`.
 */
interface WaferRecord {
	context_length?: unknown;
	tier?: unknown;
	provider?: unknown;
	capabilities?: { vision?: unknown; reasoning?: unknown; tools?: unknown };
	pricing?: {
		input_cents_per_million?: unknown;
		output_cents_per_million?: unknown;
		cache_read_cents_per_million?: unknown;
	};
	display_name?: unknown;
}

function readWaferRecord(entry: OpenAICompatibleModelRecord): WaferRecord | undefined {
	const raw = (entry as { wafer?: unknown }).wafer;
	return raw && typeof raw === "object" ? (raw as WaferRecord) : undefined;
}

type WaferThinkingFormat = "zai" | "qwen";

export function resolveWaferServerlessThinkingFormat(
	modelId: string,
	upstreamProvider: unknown,
): WaferThinkingFormat | undefined {
	// residue: parses Wafer's upstream-provider metadata FIELD (vendor
	// spellings), not a model id; the id fallback below is classify-driven.
	const upstream = typeof upstreamProvider === "string" ? upstreamProvider.trim().toLowerCase() : "";
	if (upstream) {
		if (
			upstream === "zai" ||
			upstream === "z.ai" ||
			upstream === "z-ai" ||
			upstream.includes("zhipu") ||
			upstream.includes("moonshot") ||
			upstream.includes("kimi")
		) {
			return "zai";
		}
		if (upstream.includes("qwen") || upstream.includes("alibaba") || upstream.includes("dashscope")) {
			return "qwen";
		}
		return undefined;
	}

	// Older Wafer snapshots (and some endpoint responses) do not carry the
	// upstream-provider hint. Only GLM/Kimi need a sparse override: qwen and
	// deepseek IDs are resolved safely by `buildOpenAICompat` from the model id.
	const identity = classifyModel("wafer-serverless", modelId, { lenient: true });
	return isGlmReasoningIdentity("wafer-serverless", modelId, "4.5") || identity.class === "kimi" ? "zai" : undefined;
}

function mapWaferModel(
	providerId: "wafer-serverless",
	baseUrl: string,
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const wafer = readWaferRecord(entry);
	const capabilities = wafer?.capabilities ?? {};
	const reasoning = capabilities.reasoning === true;
	const vision = capabilities.vision === true;
	const supportsTools = toBoolean(capabilities.tools) === false ? false : undefined;
	const contextWindow = toPositiveNumber(
		wafer?.context_length,
		toPositiveNumber((entry as { max_model_len?: unknown }).max_model_len, defaults.contextWindow),
	);
	const maxTokens = contextWindow !== null ? Math.min(contextWindow, WAFER_MAX_TOKENS_CAP) : null;
	const pricing = wafer?.pricing ?? {};
	const cost = {
		input: (toPositiveNumber(pricing.input_cents_per_million, 0) * 125) / 10000,
		output: (toPositiveNumber(pricing.output_cents_per_million, 0) * 125) / 10000,
		cacheRead: (toPositiveNumber(pricing.cache_read_cents_per_million, 0) * 125) / 10000,
		cacheWrite: 0,
	};
	const name = toModelName(wafer?.display_name, defaults.name);
	const base: ModelSpec<"openai-completions"> = {
		...defaults,
		id: defaults.id,
		name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning,
		input: vision ? (["text", "image"] as const) : ["text"],
		cost,
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools } : {}),
	};
	if (reasoning) {
		// Wafer's `wafer.provider` envelope tells us which upstream backend serves
		// the model. Each upstream accepts a different thinking-control parameter
		// on the wire — Wafer passes the body through, so we must mirror the
		// upstream's native shape:
		//   - zai (GLM) and moonshotai (Kimi) → `thinking: { type: "enabled" | "disabled" }`
		//   - qwen (Alibaba) → top-level `enable_thinking: boolean`
		//   - deepseek → `reasoning_effort` (DeepSeek effort map; the model always
		//     reasons when invoked, replay of `reasoning_content` is required on
		//     tool-call turns — both handled by `detectOpenAICompat` from the id).
		// Unknown upstreams stay unset; missing upstreams fall back only for
		// model families that cannot be inferred safely from Wafer's host.
		const thinkingFormat = resolveWaferServerlessThinkingFormat(defaults.id, wafer?.provider);
		return {
			...base,
			compat: {
				...(thinkingFormat ? { thinkingFormat } : {}),
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		};
	}
	return {
		...base,
		compat: { supportsDeveloperRole: false },
	};
}

export function waferServerlessModelManagerOptions(
	config?: WaferModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? WAFER_DEFAULT_BASE_URL;
	const providerId = "wafer-serverless" as const;
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => mapWaferModel(providerId, baseUrl, entry, defaults),
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 7. Mistral
// ---------------------------------------------------------------------------

export interface MistralModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function mistralModelManagerOptions(
	config?: MistralModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("mistral", "https://api.mistral.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 8. OpenCode
// ---------------------------------------------------------------------------

export interface OpenCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeOpenCodeBasePath(baseUrl: string | undefined, fallbackBasePath: string): string {
	const value = normalizeAnthropicBaseUrl(baseUrl, fallbackBasePath);
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

function openCodeBaseUrlForApi(api: Api, basePath: string): string {
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

// Per-id API pins correcting upstream metadata mismatches on the OpenCode
// gateways. Applied in two places: the models.dev resolver rules
// (OPENCODE_ZEN_API_RESOLUTION / OPENCODE_GO_API_RESOLUTION) and the live
// /v1/models discovery mapper in openCodeModelManagerOptions — the gateways
// list ids that models.dev omits entirely (muse-spark-1.2[-contributor] on
// opencode-go, #8957), so discovery cannot rely on bundled references alone.
// The per-id gateway-verified route pins live in the `api-routes` behavior
// rules (`runtime/behavior.kdl`; #887, #1617, #8957).
// Runtime-discovered rows cached before model-identity corrections retain
// stale capability metadata until the authoritative catalog TTL expires.
const OPENCODE_CACHE_MIGRATION_MODEL_IDS = ["glm-5.3-flash"] as const;
const OPENCODE_ZEN_CACHE_MIGRATION_MODEL_IDS = ["gemini-3.7-flash"] as const;

// Billing-variant suffixes the OpenCode gateways append to a base model id
// without changing its transport (`deepseek-v4-flash-free`,
// `muse-spark-1.2-contributor`).
const OPENCODE_VARIANT_SUFFIXES = ["-contributor", "-free"] as const;

/** Strips a billing-variant suffix; null when `id` is not a variant. */
function openCodeBaseModelId(id: string): string | null {
	for (const suffix of OPENCODE_VARIANT_SUFFIXES) {
		if (id.endsWith(suffix) && id.length > suffix.length) return id.slice(0, -suffix.length);
	}
	return null;
}

function openCodeModelManagerOptions(
	providerId: "opencode-go" | "opencode-zen",
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const defaultBaseUrl = getDefaultModelDiscoveryBaseUrl(providerId)!;
	const defaultBasePath = defaultBaseUrl.endsWith("/v1") ? defaultBaseUrl.slice(0, -3) : defaultBaseUrl;
	const basePath = normalizeOpenCodeBasePath(config?.baseUrl, defaultBasePath);
	const discoveryBaseUrl = openCodeBaseUrlForApi("openai-completions", basePath);
	const references = createBundledReferenceMap<Api>(providerId);
	// Both gateways share one operator with identical endpoint semantics, so
	// the sibling's bundled catalog is a routing hint for ids models.dev has
	// not picked up under this gateway yet.
	const siblingReferences = createBundledReferenceMap<Api>(
		providerId === "opencode-go" ? "opencode-zen" : "opencode-go",
	);
	const apiOverrides = (id: string): Api | undefined => {
		// Route pins live in the `api-routes` behavior rules.
		const route = apiRouteFor(providerId, id)?.api;
		return route === "openai-completions" || route === "openai-responses" || route === "anthropic-messages"
			? route
			: undefined;
	};
	// Routes a discovered id with no same-provider metadata. models.dev lags
	// the gateway (muse-spark-1.2[-contributor] shipped gateway-first, #8957),
	// so borrow the openai-responses route from the sibling gateway or the
	// billing-variant base id. Responses ONLY: openai-completions is already
	// the default, and anthropic-messages transports genuinely diverge across
	// gateways (e.g. minimax-m2.5), so borrowing them would import upstream
	// metadata noise as hard routing errors.
	const fallbackApi = (id: string, base: string | null): Api | undefined => {
		const hints = [
			siblingReferences.get(id)?.api,
			base ? references.get(base)?.api : undefined,
			base ? siblingReferences.get(base)?.api : undefined,
		];
		return hints.includes("openai-responses") ? "openai-responses" : undefined;
	};
	const resolveApi = (id: string, defaultApi: Api): Api => {
		const base = openCodeBaseModelId(id);
		return (
			apiOverrides(id) ??
			(base ? apiOverrides(base) : undefined) ??
			references.get(id)?.api ??
			fallbackApi(id, base) ??
			defaultApi
		);
	};
	return {
		providerId,
		cacheProviderId: resolveModelCacheProviderId(providerId, { apiKey, baseUrl: discoveryBaseUrl }),
		dynamicModelsAuthoritative: true,
		// Per-id route pins and capability migrations are cache identity:
		// without this, rows cached before a correction keep the stale route or
		// thinking surface until TTL expiry (#8957, #9960, #10543).
		dropCachedModelIdsOnStaticMismatch: [
			...apiRouteExactModelIds(providerId),
			...OPENCODE_CACHE_MIGRATION_MODEL_IDS,
			...(providerId === "opencode-zen" ? OPENCODE_ZEN_CACHE_MIGRATION_MODEL_IDS : []),
		],
		modelsDev: {
			fetch: () => fetchRevalidatedWellKnownModelsWithTimeout(config?.fetch),
			map: payload => {
				if (!isRecord(payload)) return [];
				return mapModelsDevToModels(payload, OPENCODE_MODELS_DEV_DESCRIPTORS)
					.filter(model => model.provider === providerId)
					.map(model => {
						const api = resolveApi(model.id, "openai-completions");
						return { ...model, api, baseUrl: openCodeBaseUrlForApi(api, basePath) };
					});
			},
		},
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const name = toModelName(entry.name, reference?.name ?? defaults.name);
						// Pins and bundled routing hints win over the metadata-only
						// stencil fallback; the fallback never selects a transport.
						const api = resolveApi(defaults.id, defaults.api);
						const baseUrl = openCodeBaseUrlForApi(api, basePath);
						const identity = classifyModel(providerId, defaults.id, { lenient: true });
						if (identity.class === "meta" && identity.family === undefined) {
							// Gateway lists these as bare ids with no capability
							// metadata and no local bundled row, so the generic
							// defaults would hide the effort dial
							// (`reasoning: false`). Keep the pinned/fallback route
							// and restore the documented thinking surface.
							return {
								...(reference ?? defaults),
								id: defaults.id,
								name,
								api,
								provider: providerId,
								baseUrl,
								reasoning: true,
								input: reference?.input ?? ["text", "image"],
								thinking: reference?.thinking ?? META_MUSE_SPARK_THINKING,
								contextWindow: toPositiveNumber(entry.context_length, reference?.contextWindow ?? 1_048_576),
								maxTokens: toPositiveNumber(entry.max_completion_tokens, reference?.maxTokens ?? 131_072),
							};
						}
						if (!reference) {
							return { ...defaults, name, api, baseUrl };
						}
						return {
							...reference,
							id: defaults.id,
							name,
							api,
							baseUrl,
							contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
							maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export function opencodeZenModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-zen", config);
}

export function opencodeGoModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-go", config);
}

// ---------------------------------------------------------------------------
// 9. Ollama
// ---------------------------------------------------------------------------

export interface OllamaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("ollama" as Parameters<typeof getBundledModels>[0]);
	const resolveMetadata = createOllamaMetadataResolver(nativeBaseUrl, config?.fetch);
	return {
		providerId: "ollama",
		cacheProviderId: resolveModelCacheProviderId("ollama", { baseUrl }),
		fetchDynamicModels: async () => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toModelName(entry.name, defaults.name),
							contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW,
							maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				await Promise.all(
					openAiCompatible.map(async model => {
						const metadata = await resolveMetadata(model.id);
						model.contextWindow = metadata.contextWindow;
						if (metadata.reasoning !== undefined) {
							model.reasoning = metadata.reasoning;
							// The effort ladder is rule-owned (`providers/ollama.kdl`);
							// derived at build time from the reasoning flag.
							model.thinking = undefined;
						}
						if (metadata.input) {
							model.input = metadata.input;
						}
					}),
				);
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(baseUrl, resolveMetadata, config?.fetch);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

// ---------------------------------------------------------------------------
// 10. OpenRouter
// ---------------------------------------------------------------------------

export interface OpenRouterModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function mapOpenRouterThinking(entry: OpenAICompatibleModelRecord): ThinkingConfig | undefined {
	const reasoning = entry.reasoning;
	if (!isRecord(reasoning)) return undefined;
	const supportedEfforts = reasoning.supported_efforts;
	if (!Array.isArray(supportedEfforts)) return undefined;
	const efforts = THINKING_EFFORTS.filter(effort => supportedEfforts.includes(effort));
	if (efforts.length === 0) return undefined;
	const defaultLevel =
		typeof reasoning.default_effort === "string"
			? THINKING_EFFORTS.find(effort => effort === reasoning.default_effort)
			: undefined;
	return {
		mode: "effort",
		efforts,
		...(defaultLevel !== undefined && efforts.includes(defaultLevel) ? { defaultLevel } : {}),
		...(reasoning.mandatory === true ? { requiresEffort: true } : {}),
	};
}

export function openrouterModelManagerOptions(
	config?: OpenRouterModelManagerConfig,
): ModelManagerOptions<"openrouter"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://openrouter.ai/api/v1";
	const references = createBundledReferenceMap<"openrouter">("openrouter");
	return {
		providerId: "openrouter",
		// Older builds cached OpenRouter discovery rows as `api: "openai-completions"`.
		// Namespace the refreshed pseudo-API cache separately so those rows cannot
		// override bundled `api: "openrouter"` models during online-if-uncached startup.
		cacheProviderId: resolveModelCacheProviderId("openrouter"),
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openrouter",
				provider: "openrouter",
				baseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const params = entry.supported_parameters;
					return Array.isArray(params) && params.includes("tools");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"openrouter">,
					_context: OpenAICompatibleModelMapperContext<"openrouter">,
				): ModelSpec<"openrouter"> => {
					const reference = references.get(defaults.id);
					const baseModel = mapWithBundledReference(entry, defaults, reference);
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const params = Array.isArray(entry.supported_parameters) ? (entry.supported_parameters as string[]) : [];
					const thinking = mapOpenRouterThinking(entry);
					const modality = String((entry.architecture as Record<string, unknown> | undefined)?.modality ?? "");
					const topProvider = entry.top_provider as Record<string, unknown> | undefined;

					const supportsToolChoice = params.includes("tool_choice");

					return {
						...baseModel,
						reasoning: params.includes("reasoning"),
						...(thinking !== undefined ? { thinking } : {}),
						input: modality.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: parseFloat(String(pricing?.prompt ?? "0")) * 1_000_000,
							output: parseFloat(String(pricing?.completion ?? "0")) * 1_000_000,
							cacheRead: parseFloat(String(pricing?.input_cache_read ?? "0")) * 1_000_000,
							cacheWrite: parseFloat(String(pricing?.input_cache_write ?? "0")) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_length === "number" ? entry.context_length : baseModel.contextWindow,
						maxTokens:
							typeof topProvider?.max_completion_tokens === "number"
								? topProvider.max_completion_tokens
								: baseModel.maxTokens,
						...(!supportsToolChoice && {
							compat: { ...baseModel.compat, supportsToolChoice: false },
						}),
					};
				},
				fetch: config?.fetch,
			}),
	};
}

const ZENMUX_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
const ZENMUX_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic";

function normalizeZenMuxOpenAiBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return ZENMUX_OPENAI_BASE_URL;
	}
	const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
	if (normalized.endsWith("/api/anthropic")) {
		return normalized.replace("/api/anthropic", "/api/v1");
	}
	return normalized;
}

function toZenMuxAnthropicBaseUrl(openAiBaseUrl: string): string {
	try {
		const parsed = new URL(openAiBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/api/v1")
			? `${trimmedPath.slice(0, -"/api/v1".length)}/api/anthropic`
			: "/api/anthropic";
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return ZENMUX_ANTHROPIC_BASE_URL;
	}
}

function isZenMuxAnthropicModel(entry: OpenAICompatibleModelRecord, modelId: string): boolean {
	if (typeof entry.owned_by === "string" && entry.owned_by.toLowerCase() === "anthropic") {
		return true;
	}
	return classifyModel("zenmux", modelId, { lenient: true }).class === "anthropic";
}

function getZenMuxPricingValue(pricings: Record<string, unknown> | undefined, key: string): number {
	const bucket = pricings?.[key];
	if (!Array.isArray(bucket)) {
		return 0;
	}
	for (const item of bucket) {
		if (!isRecord(item)) {
			continue;
		}
		const value = toNumber(item.value);
		if (value !== undefined) {
			return value;
		}
	}
	return 0;
}

function getZenMuxCacheWritePrice(pricings: Record<string, unknown> | undefined): number {
	const oneHour = getZenMuxPricingValue(pricings, "input_cache_write_1_h");
	if (oneHour > 0) {
		return oneHour;
	}
	const fiveMinute = getZenMuxPricingValue(pricings, "input_cache_write_5_min");
	if (fiveMinute > 0) {
		return fiveMinute;
	}
	return getZenMuxPricingValue(pricings, "input_cache_write");
}

// ---------------------------------------------------------------------------
// 10.5 ZenMux
// ---------------------------------------------------------------------------

export interface ZenMuxModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zenmuxModelManagerOptions(config?: ZenMuxModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const openAiBaseUrl = normalizeZenMuxOpenAiBaseUrl(config?.baseUrl);
	const anthropicBaseUrl = toZenMuxAnthropicBaseUrl(openAiBaseUrl);
	return {
		providerId: "zenmux",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels<Api>({
				api: "openai-completions",
				provider: "zenmux",
				baseUrl: openAiBaseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const pricings = isRecord(entry.pricings) ? entry.pricings : undefined;
					const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
					const isAnthropicModel = isZenMuxAnthropicModel(entry, defaults.id);
					return {
						...defaults,
						name: toModelName(entry.display_name, defaults.name),
						api: isAnthropicModel ? "anthropic-messages" : "openai-completions",
						baseUrl: isAnthropicModel ? anthropicBaseUrl : openAiBaseUrl,
						reasoning: capabilities?.reasoning === true || defaults.reasoning,
						input: toInputCapabilities(entry.input_modalities),
						cost: {
							input: getZenMuxPricingValue(pricings, "prompt"),
							output: getZenMuxPricingValue(pricings, "completion"),
							cacheRead: getZenMuxPricingValue(pricings, "input_cache_read"),
							cacheWrite: getZenMuxCacheWritePrice(pricings),
						},
						contextWindow: toPositiveNumber(entry.context_length, defaults.contextWindow),
						maxTokens: toPositiveNumber(entry.max_completion_tokens, defaults.maxTokens),
					};
				},
				fetch: config?.fetch,
			}),
	};
}

// ---------------------------------------------------------------------------
// 10.6 Kilo Gateway
// ---------------------------------------------------------------------------

export interface KiloModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function kiloModelManagerOptions(config?: KiloModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kilo.ai/api/gateway";
	return {
		providerId: "kilo",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "kilo",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
			}),
	};
}

// ---------------------------------------------------------------------------
// Alibaba Coding Plan
// ---------------------------------------------------------------------------

export interface AlibabaCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function alibabaCodingPlanModelManagerOptions(
	config?: AlibabaCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "alibaba-coding-plan",
		defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
		config,
		mapModel: mapWithBundledReference,
	});
}

// ---------------------------------------------------------------------------
// Alibaba Token Plan
// ---------------------------------------------------------------------------

export { ALIBABA_TOKEN_PLAN_BASE_URL };

const ALIBABA_TOKEN_PLAN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const ALIBABA_TOKEN_PLAN_COMPAT: OpenAICompat = {
	supportsDeveloperRole: false,
};
const ALIBABA_TOKEN_PLAN_REASONING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
};
// Qwen3.8-Max combines Qwen's binary thinking toggle with OpenAI-style
// `reasoning_effort`. The base Qwen view encodes disabled turns; reasoning
// requests swap to the OpenAI effort dialect and explicitly enable thinking.
const ALIBABA_TOKEN_PLAN_QWEN_EFFORT_COMPAT: OpenAICompat = {
	...ALIBABA_TOKEN_PLAN_COMPAT,
	supportsReasoningEffort: true,
	whenThinking: {
		thinkingFormat: "openai",
		extraBody: { enable_thinking: true },
	},
};

export const ALIBABA_TOKEN_PLAN_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "qwen3.8-max-preview",
		name: "Qwen3.8 Max Preview",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 983_616,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.XHigh],
			requiresEffort: true,
		},
		compat: {
			...ALIBABA_TOKEN_PLAN_COMPAT,
			supportsReasoningEffort: true,
		},
	},
	{
		id: "qwen3.8-max",
		name: "Qwen3.8 Max",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
			defaultLevel: Effort.XHigh,
		},
		compat: ALIBABA_TOKEN_PLAN_QWEN_EFFORT_COMPAT,
	},
	{
		id: "qwen3.8-flash",
		name: "Qwen3.8 Flash",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "qwen3.7-max",
		name: "Qwen3.7 Max",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "qwen3.7-plus",
		name: "Qwen3.7 Plus",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "qwen3.6-flash",
		name: "Qwen3.6 Flash",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		},
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		thinking: {
			mode: "effort",
			efforts: [Effort.High, Effort.Max],
		},
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
];

function isAlibabaTokenPlanChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	return normalized.length > 0 && !isExcludedModel("alibaba-token-plan", normalized);
}

export interface AlibabaTokenPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function alibabaTokenPlanModelManagerOptions(
	config?: AlibabaTokenPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const credential = config?.apiKey ? parseAlibabaTokenPlanCredential(config.apiKey) : undefined;
	const apiKey = credential?.token;
	// A region-locked credential (China/custom) dictates the discovery endpoint:
	// its key only authenticates against its own region, so fetching /models from
	// any other base URL would 401 (#6682).
	const baseUrl = credential?.baseUrl ?? config?.baseUrl ?? ALIBABA_TOKEN_PLAN_BASE_URL;
	return {
		providerId: "alibaba-token-plan",
		dynamicModelsAuthoritative: true,
		staticModels: ALIBABA_TOKEN_PLAN_STATIC_MODELS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "alibaba-token-plan",
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isAlibabaTokenPlanChatModelId(model.id),
					mapModel: (_entry, defaults) => {
						const reference = ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(model => model.id === defaults.id);
						if (reference) {
							return {
								...reference,
								id: defaults.id,
								api: defaults.api,
								provider: defaults.provider,
								baseUrl: defaults.baseUrl,
							};
						}
						const normalizedId = defaults.id.trim().toLowerCase();
						// Discovery carries no limit fields; the `model-limits` behavior
						// rules pin values from official model documentation.
						const limits = modelLimitsFor("alibaba-token-plan", normalizedId);
						const enriched = limits
							? {
									...defaults,
									contextWindow: limits.context ?? defaults.contextWindow,
									maxTokens: limits.maxTokens ?? defaults.maxTokens,
								}
							: defaults;

						if (isDeepseekV4Generation("alibaba-token-plan", normalizedId)) {
							return {
								...enriched,
								reasoning: true,
								thinking: {
									mode: "effort" as const,
									efforts: [Effort.High, Effort.Max],
								},
							};
						}
						return enriched;
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 11. Vercel AI Gateway
// ---------------------------------------------------------------------------

export interface VercelAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeVercelAiGatewayBaseUrls(rawBaseUrl: string | undefined): { baseUrl: string; catalogBaseUrl: string } {
	const baseUrl = (rawBaseUrl === undefined ? "https://ai-gateway.vercel.sh" : rawBaseUrl.trim()).replace(/\/+$/, "");
	const catalogBaseUrl = baseUrl === "" || baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

	return {
		baseUrl: baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl,
		catalogBaseUrl,
	};
}

export function vercelAiGatewayModelManagerOptions(
	config?: VercelAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const { baseUrl, catalogBaseUrl } = normalizeVercelAiGatewayBaseUrls(config?.baseUrl);
	return {
		providerId: "vercel-ai-gateway",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl: catalogBaseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const tags = entry.tags;
					return Array.isArray(tags) && tags.includes("tool-use");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"anthropic-messages">,
					_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
				): ModelSpec<"anthropic-messages"> => {
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
					const reportedMaxTokens = typeof entry.max_tokens === "number" ? entry.max_tokens : defaults.maxTokens;
					const modelId = typeof entry.id === "string" ? entry.id : defaults.id;
					const maxTokens =
						modelId === "meta/muse-spark-1.2-contributor" && typeof reportedMaxTokens === "number"
							? Math.min(reportedMaxTokens, 131_072)
							: reportedMaxTokens;

					return {
						...defaults,
						baseUrl,
						reasoning: tags.includes("reasoning"),
						input: tags.includes("vision") ? ["text", "image"] : ["text"],
						cost: {
							input: (toNumber(pricing?.input) ?? 0) * 1_000_000,
							output: (toNumber(pricing?.output) ?? 0) * 1_000_000,
							cacheRead: (toNumber(pricing?.input_cache_read) ?? 0) * 1_000_000,
							cacheWrite: (toNumber(pricing?.input_cache_write) ?? 0) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_window === "number" ? entry.context_window : defaults.contextWindow,
						maxTokens,
					};
				},
				fetch: config?.fetch,
			}),
	};
}

// ---------------------------------------------------------------------------
// 12. Kimi Code
// ---------------------------------------------------------------------------

export interface KimiCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function mapKimiThinking(entry: OpenAICompatibleModelRecord): ThinkingConfig | undefined {
	const raw = entry.think_efforts;
	if (!isRecord(raw) || raw.support !== true) return undefined;
	const validEfforts = raw.valid_efforts;
	if (!Array.isArray(validEfforts)) return undefined;
	const efforts = THINKING_EFFORTS.filter(effort => validEfforts.includes(effort));
	if (efforts.length === 0) return undefined;

	const thinking: ThinkingConfig = { mode: "effort", efforts };
	if (entry.supports_thinking_type === "only") {
		thinking.requiresEffort = true;
	}
	if (typeof raw.default_effort === "string") {
		const defaultLevel = THINKING_EFFORTS.find(effort => effort === raw.default_effort);
		if (defaultLevel !== undefined && efforts.includes(defaultLevel)) {
			thinking.defaultLevel = defaultLevel;
		}
	}
	return thinking;
}

function kimiSupportsReasoning(entry: OpenAICompatibleModelRecord, modelId: string): boolean {
	switch (entry.supports_thinking_type) {
		case "only":
		case "both":
			return true;
		case "no":
			return false;
		default:
			// Without a reasoning bit, the classified thinking-variant fact names
			// the reasoning sibling.
			return (
				entry.supports_reasoning === true ||
				classifyModel("kimi-code", modelId, { lenient: true }).thinkingVariant === true
			);
	}
}

function mapKimiApiFormat(protocol: unknown): OpenAICompat["kimiApiFormat"] {
	if (protocol === "anthropic") return "anthropic";
	if (protocol === null) return "openai";
	return undefined;
}

/**
 * Kimi Code output ceilings by model family. The `/coding/v1/models` discovery
 * envelope carries no output-limit field, so the mapper supplies the documented
 * per-family caps instead of a blanket constant. Values match models.dev's
 * `kimi-for-coding` and `moonshotai` kimi-k3 entries. See #6711.
 */
/** Fallback output cap for Kimi Code families without a documented ceiling (legacy K2 discovery rows). */
export const KIMI_CODE_DEFAULT_MAX_TOKENS = 32_000;

/**
 * Resolve a Kimi Code model's output ceiling; the per-family caps are
 * rule-owned (`runtime/behavior.kdl` model-limits), everything else ->
 * `fallback`.
 */
export function kimiCodeMaxTokens(modelId: string, fallback?: number): number;
export function kimiCodeMaxTokens(modelId: string, fallback: number | null): number | null;
export function kimiCodeMaxTokens(
	modelId: string,
	fallback: number | null = KIMI_CODE_DEFAULT_MAX_TOKENS,
): number | null {
	return modelLimitsFor("kimi-code", modelId.trim().toLowerCase())?.maxTokens ?? fallback;
}

export function kimiCodeModelManagerOptions(
	config?: KimiCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kimi.com/coding/v1";
	return {
		providerId: "kimi-code",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "kimi-code",
					baseUrl,
					apiKey,
					headers: {
						"User-Agent": "KimiCLI/1.0",
						"X-Msh-Platform": "kimi_cli",
					},
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const id = defaults.id;
						const reasoning = kimiSupportsReasoning(entry, id);
						const thinking = reasoning ? mapKimiThinking(entry) : undefined;
						return {
							...defaults,
							name: typeof entry.display_name === "string" ? entry.display_name : defaults.name,
							reasoning,
							// K2.5's misreported vision support is rule-owned
							// (`providers/kimi-code.kdl` input-modalities).
							input: entry.supports_image_in === true ? ["text", "image"] : ["text"],
							contextWindow: typeof entry.context_length === "number" ? entry.context_length : 262144,
							maxTokens: kimiCodeMaxTokens(id),
							thinking,
							compat: {
								thinkingFormat: thinking ? "kimi" : "zai",
								kimiApiFormat: mapKimiApiFormat(entry.protocol),
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 12.5. LM Studio
// ---------------------------------------------------------------------------

/** Native LM Studio metadata keyed by model id from `/api/v0/models`. */
export interface LmStudioNativeModelMetadata {
	input: ("text" | "image")[];
	contextWindow?: number;
}

/** Options for LM Studio's optional native metadata probe. */
export interface LmStudioNativeModelMetadataOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

const LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250;

function toLmStudioNativeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function getLmStudioCapabilityNames(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap(item => (typeof item === "string" ? [item.toLowerCase()] : []));
}

function getLmStudioNativeInput(entry: Record<string, unknown>): ("text" | "image")[] {
	const modelType = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
	const capabilities = getLmStudioCapabilityNames(entry.capabilities);
	const supportsImage = modelType === "vlm" || capabilities.includes("vision") || capabilities.includes("image");
	return supportsImage ? ["text", "image"] : ["text"];
}

function getLmStudioNativeContextWindow(entry: Record<string, unknown>): number | undefined {
	// LM Studio serves `loaded_context_length` (the window the running instance
	// actually accepts) alongside `max_context_length` (the architectural
	// ceiling). A model is routinely loaded below its maximum — the user picks a
	// smaller window, or MLX context auto-fit shrinks it to fit unified memory —
	// so prefer what the runtime serves, matching the Ollama/llama.cpp rule from
	// #3754. Unloaded models report `loaded_context_length: null` and fall
	// through to the max/train chain unchanged.
	const loadedContextWindow = entry.state === "loaded" ? toPositiveNumber(entry.loaded_context_length, null) : null;
	return (
		loadedContextWindow ??
		toPositiveNumber(entry.max_context_length, null) ??
		toPositiveNumber(entry.context_length, null) ??
		toPositiveNumber(entry.max_model_len, null) ??
		undefined
	);
}

/** Fetches LM Studio native model metadata used to mark VLM models as image-capable. */
export async function fetchLmStudioNativeModelMetadata(
	baseUrl: string,
	fetchImpl: FetchImpl = fetch,
	options?: LmStudioNativeModelMetadataOptions,
): Promise<Map<string, LmStudioNativeModelMetadata> | null> {
	const nativeBaseUrl = toLmStudioNativeBaseUrl(baseUrl);
	const fetchMetadata = async (signal?: AbortSignal): Promise<Map<string, LmStudioNativeModelMetadata> | null> => {
		try {
			const response = await fetchImpl(`${nativeBaseUrl}/api/v0/models`, {
				method: "GET",
				headers: { Accept: "application/json", ...options?.headers },
				signal,
			});
			if (!response.ok) {
				return null;
			}
			const payload = await response.json();
			if (!isRecord(payload) || !Array.isArray(payload.data)) {
				return null;
			}
			const metadata = new Map<string, LmStudioNativeModelMetadata>();
			for (const entry of payload.data) {
				if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
					continue;
				}
				const contextWindow = getLmStudioNativeContextWindow(entry);
				metadata.set(entry.id, {
					input: getLmStudioNativeInput(entry),
					...(contextWindow === undefined ? {} : { contextWindow }),
				});
			}
			return metadata;
		} catch {
			return null;
		}
	};
	if (options?.signal !== undefined) {
		return fetchMetadata(options.signal);
	}
	return withCatalogDiscoveryTimeout(LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS, fetchMetadata);
}

export interface LmStudioModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function lmStudioModelManagerOptions(
	config?: LmStudioModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
	const references = createBundledReferenceMap<"openai-completions">("lm-studio" as any);
	return {
		providerId: "lm-studio",
		fetchDynamicModels: async () => {
			const nativeMetadataPromise = fetchLmStudioNativeModelMetadata(baseUrl, config?.fetch, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			});
			const models = await fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (!models) {
				return models;
			}
			const nativeMetadata = await nativeMetadataPromise;
			if (!nativeMetadata) {
				return models;
			}
			return models.map(model => {
				const metadata = nativeMetadata.get(model.id);
				if (!metadata) {
					return model;
				}
				return {
					...model,
					input: metadata.input,
					contextWindow: metadata.contextWindow ?? model.contextWindow,
				};
			});
		},
	};
}

// ---------------------------------------------------------------------------
// 13. Synthetic
// ---------------------------------------------------------------------------

export interface SyntheticModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Synthetic's `/openai/v1/models` entry shape (verified live against
 * api.synthetic.new). It shares no capability field names with the generic
 * OpenAI-compatible conventions: capabilities arrive in `supported_features`,
 * modalities in `input_modalities`, the output cap in `max_output_length`, the
 * accepted `reasoning_effort` vocabulary in `reasoning_parameters.efforts`,
 * and per-token prices in `pricing` as `$`-prefixed decimal strings.
 */
interface SyntheticModelRecord extends OpenAICompatibleModelRecord {
	supported_features?: unknown;
	input_modalities?: unknown;
	max_output_length?: unknown;
	reasoning_parameters?: unknown;
	pricing?: unknown;
}

/** Synthetic's thinking-off wire tier — a router state, not a user effort. */
const SYNTHETIC_WIRE_EFFORT_NONE = "none";
/** Output cap for routes that advertise no `max_output_length`. */
const SYNTHETIC_FALLBACK_MAX_TOKENS = 8192;

function toSyntheticStringList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Translate Synthetic's per-model `reasoning_effort` vocabulary into an effort
 * ladder. Every advertised value that names an OMP tier maps verbatim; `none`
 * is the thinking-off state rather than a tier of its own, so it backs the
 * `minimal` selector through the wire map (same shape as the Fireworks
 * `minimal → none` map) and gives these routes a real no-thinking tier.
 * A route that advertises only `none` (or tiers this client doesn't know)
 * still gets the minimal-off mapping: falling through to identity inference
 * would fabricate an unadvertised ladder, and leaving thinking unset would
 * leak any stale reference ladder past the wire vocabulary.
 */
function resolveSyntheticThinking(wireEfforts: readonly string[]): ThinkingConfig | undefined {
	const efforts = THINKING_EFFORTS.filter(effort => wireEfforts.includes(effort));
	const wireHasNone = wireEfforts.includes(SYNTHETIC_WIRE_EFFORT_NONE);
	if (efforts.length === 0) {
		return wireHasNone
			? { mode: "effort", efforts: [Effort.Minimal], effortMap: { [Effort.Minimal]: SYNTHETIC_WIRE_EFFORT_NONE } }
			: undefined;
	}
	if (!wireHasNone || efforts.includes(Effort.Minimal)) {
		return { mode: "effort", efforts };
	}
	return {
		mode: "effort",
		efforts: [Effort.Minimal, ...efforts],
		effortMap: { [Effort.Minimal]: SYNTHETIC_WIRE_EFFORT_NONE },
	};
}

/** Synthetic quotes per-token USD as `"$0.000001"`; catalog cost is per-million. */
function toSyntheticCostPerMillion(value: unknown): number | undefined {
	const parsed = toNumber(typeof value === "string" ? value.trim().replace(/^\$/, "") : value);
	if (parsed === undefined || parsed < 0) {
		return undefined;
	}
	// Scaling a per-token decimal by 1e6 drifts (4.5e-7 → 0.44999999999999996), so
	// settle on a millionth of a dollar per million tokens — finer than any real tier.
	return Math.round(parsed * 1e12) / 1e6;
}

function resolveSyntheticCost(
	pricing: unknown,
	fallback: ModelSpec<"openai-completions">["cost"],
): ModelSpec<"openai-completions">["cost"] {
	if (!isRecord(pricing)) {
		return fallback;
	}
	const input = toSyntheticCostPerMillion(pricing.prompt);
	const output = toSyntheticCostPerMillion(pricing.completion);
	if (input === undefined || output === undefined) {
		return fallback;
	}
	return {
		input,
		output,
		cacheRead: toSyntheticCostPerMillion(pricing.input_cache_reads) ?? fallback.cacheRead,
		cacheWrite: toSyntheticCostPerMillion(pricing.input_cache_writes) ?? fallback.cacheWrite,
	};
}

export function syntheticModelManagerOptions(
	config?: SyntheticModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.synthetic.new/openai/v1";
	const references = new Map(
		(getBundledModels("synthetic") as Model<"openai-completions">[]).map(model => [model.id, toModelSpec(model)]),
	);
	return {
		providerId: "synthetic",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "synthetic",
					baseUrl,
					apiKey,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const record = entry as SyntheticModelRecord;
						const reference = references.get(defaults.id);
						const referenceSupportsImage = reference?.input.includes("image") ?? false;
						const features = toSyntheticStringList(record.supported_features);
						const modalities = toSyntheticStringList(record.input_modalities);
						const wireEfforts = isRecord(record.reasoning_parameters)
							? toSyntheticStringList(record.reasoning_parameters.efforts)
							: [];
						const wireReasoning = features.includes("reasoning") || wireEfforts.length > 0;
						const thinking = resolveSyntheticThinking(wireEfforts);
						// An advertised effort vocabulary is authoritative over the bundled
						// reference: when the wire names tiers (even only `none`), the
						// reference's reasoning flag must not re-add a dial the route
						// doesn't expose. A route with at least one named tier reasons —
						// even a single tier is a real effort the wire accepts. Only a
						// vocabulary of `none`/unrecognized values alone is the pure
						// off-switch: reporting `reasoning: true` there would light up the
						// effort dial for a dial with one stop. When the wire is silent on
						// reasoning entirely, the reference gets a vote.
						const namedTierCount =
							(thinking?.efforts.length ?? 0) - (wireEfforts.includes(SYNTHETIC_WIRE_EFFORT_NONE) ? 1 : 0);
						const reasoning =
							wireReasoning && namedTierCount > 0
								? true
								: wireEfforts.length > 0
									? false
									: entry.supports_reasoning === true || (reference?.reasoning ?? false);
						// The router aliases (`syn:*`) and newly added routes carry no
						// bundled reference, so these advertised capabilities are the only
						// truth available. Without them such a model lands non-reasoning
						// (which hides the thinking selector and drops `reasoning_effort`
						// from every request), text-only, priced at zero, and capped at the
						// 8k placeholder — a cap low enough that verbose models stop on
						// `length` each turn and trip recovery compaction.
						const base = reference ? { ...reference, id: defaults.id, baseUrl } : defaults;
						return {
							...base,
							name: toModelName(entry.name, reference?.name ?? defaults.name),
							reasoning,
							...(thinking ? { thinking } : {}),
							// Advertised `input_modalities` are authoritative, mirroring the
							// effort vocabulary above: a wire that names its modalities (even
							// text-only) must not regrow `image` from the bundled reference.
							// Only when the wire omits them do `supports_vision` and the
							// reference get a vote.
							input:
								modalities.length > 0
									? modalities.includes("image")
										? ["text", "image"]
										: ["text"]
									: entry.supports_vision === true || referenceSupportsImage
										? ["text", "image"]
										: ["text"],
							// A present `supported_features` list (even empty) is the route's
							// whole advertised surface: no `tools` entry means no tool
							// support. The reference still wins when it already vouched for
							// tools, since a populated wire list can be incomplete; an
							// explicit reference `false` stays `false` either way.
							...(record.supported_features !== undefined &&
							!features.includes("tools") &&
							reference?.supportsTools !== true
								? { supportsTools: false }
								: reference?.supportsTools === false
									? { supportsTools: false }
									: {}),
							cost: resolveSyntheticCost(record.pricing, base.cost),
							contextWindow: toPositiveNumber(
								entry.context_length,
								reference?.contextWindow ?? defaults.contextWindow,
							),
							maxTokens: toPositiveNumber(
								record.max_output_length ?? entry.max_tokens,
								reference?.maxTokens ?? SYNTHETIC_FALLBACK_MAX_TOKENS,
							),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 14. Venice
// ---------------------------------------------------------------------------

export interface VeniceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function veniceModelManagerOptions(
	config?: VeniceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "venice",
		defaultBaseUrl: "https://api.venice.ai/api/v1",
		config,
		mapModel: (entry, defaults, reference) => {
			const model = mapWithBundledReference(entry, defaults, reference);
			return {
				...model,
				maxTokens: clampKimiK27CodeMaxTokens(defaults.id, model.maxTokens),
				compat: { ...model.compat, supportsUsageInStreaming: false },
			};
		},
	});
}

// ---------------------------------------------------------------------------
// 14.5 Baseten
// ---------------------------------------------------------------------------

export interface BasetenModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

// A previous version of OMP shipped this model without reasoning levels. We've
// since fixed that. This const lets us bust the cache so that users on that
// version of OMP pick up the reasoning levels immediately.
const BASETEN_CACHE_MIGRATION_MODEL_IDS = ["zai-org/GLM-5.3", "zai-org/GLM-5.3-Flash"] as const;

export function basetenModelManagerOptions(
	config?: BasetenModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "baseten",
		defaultBaseUrl: "https://inference.baseten.co/v1",
		config,
		dynamicModelsAuthoritative: true,
		requireApiKey: true,
		dropCachedModelIdsOnStaticMismatch: BASETEN_CACHE_MIGRATION_MODEL_IDS,
		mapModel: (entry, defaults, reference) => {
			const raw = entry as Record<string, unknown> & {
				supported_features?: unknown;
				input_modalities?: unknown;
				pricing?: Record<string, unknown>;
			};
			const features = Array.isArray(raw.supported_features) ? raw.supported_features : [];
			const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];

			// Baseten's discovery flags are not enough to enable OMP reasoning for every
			// model. Only models with a verified Baseten reasoning policy are enabled
			// here; an unknown model may use a different reasoning wire shape or effort
			// vocabulary, which OMP must not guess.
			const identity = classifyModel("baseten", defaults.id, { lenient: true });
			const isSupportedBasetenReasoningModel =
				(identity.class === "kimi" && identity.family === "k3") ||
				isGlmReasoningIdentity("baseten", defaults.id, "5.2") ||
				defaults.id === "openai/gpt-oss-120b" ||
				defaults.id === "deepseek-ai/DeepSeek-V4-Pro";
			const reasoning =
				isSupportedBasetenReasoningModel &&
				(features.includes("reasoning") || features.includes("reasoning_effort"));
			const supportsTools = features.includes("tools") ? undefined : false;
			const vision = modalities.includes("image") || (reference?.input.includes("image") ?? false);

			const pricing = raw.pricing ?? {};
			const cost = {
				input: toPositiveNumber(pricing.prompt, 0) * 1_000_000,
				output: toPositiveNumber(pricing.completion, 0) * 1_000_000,
				cacheRead: toPositiveNumber(pricing.input_cache_read, 0) * 1_000_000,
				cacheWrite: 0,
			};

			const contextWindow = toPositiveNumber(raw.context_length, reference?.contextWindow ?? defaults.contextWindow);
			const maxTokens = toPositiveNumber(raw.max_completion_tokens, reference?.maxTokens ?? defaults.maxTokens);
			const baseModel = mapWithBundledReference(entry, defaults, reference);

			return {
				...baseModel,
				reasoning,
				input: vision ? ["text", "image"] : ["text"],
				cost,
				contextWindow,
				maxTokens,
				...(supportsTools === false ? { supportsTools } : {}),
			};
		},
	});
}

// ---------------------------------------------------------------------------
// 15. Together
// ---------------------------------------------------------------------------

export interface TogetherModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function togetherModelManagerOptions(
	config?: TogetherModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("together", "https://api.together.xyz/v1", config);
}

// ---------------------------------------------------------------------------
// 15.5 CoreWeave Serverless Inference
// ---------------------------------------------------------------------------

export interface CoreWeaveModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function coreWeaveModelManagerOptions(
	config?: CoreWeaveModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("coreweave", "https://api.inference.wandb.ai/v1", {
		...config,
		headers: () => coreWeaveProjectHeaders(Bun.env),
	});
}

// ---------------------------------------------------------------------------
// 15.75 Meta Model API
// ---------------------------------------------------------------------------

const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";
const META_MUSE_SPARK_COST = { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } as const;
const META_MUSE_SPARK_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};

export const META_MUSE_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	{
		id: "muse-spark-1.1",
		name: "Muse Spark 1.1",
		api: "openai-responses",
		provider: "meta",
		baseUrl: META_MODEL_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: META_MUSE_SPARK_COST,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinking: META_MUSE_SPARK_THINKING,
		compat: {
			supportsReasoningEffort: true,
			includeEncryptedReasoning: true,
		},
	},
	{
		id: "muse-spark-1.2",
		name: "Muse Spark 1.2",
		api: "openai-responses",
		provider: "meta",
		baseUrl: META_MODEL_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: META_MUSE_SPARK_COST,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinking: META_MUSE_SPARK_THINKING,
		compat: {
			supportsReasoningEffort: true,
			includeEncryptedReasoning: true,
		},
	},
	{
		id: "muse-spark-1.2-contributor",
		name: "Muse Spark 1.2 Contributor (Data Used for Training)",
		api: "openai-responses",
		provider: "meta",
		baseUrl: META_MODEL_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinking: META_MUSE_SPARK_THINKING,
		compat: {
			supportsReasoningEffort: true,
			includeEncryptedReasoning: true,
		},
	},
];

// ---------------------------------------------------------------------------
// 15.76 Amazon Bedrock Mantle
// ---------------------------------------------------------------------------

const BEDROCK_MANTLE_BASE_URL = "https://bedrock-mantle.{region}.api.aws/openai/v1";
const BEDROCK_MANTLE_GPT_5_X_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};
const BEDROCK_MANTLE_GPT_5_6_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
};

/**
 * OpenAI frontier models served exclusively through Bedrock Mantle's Responses
 * endpoint. Pricing is per million tokens from the Amazon Bedrock pricing page.
 */
export const BEDROCK_MANTLE_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	{
		id: "openai.gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.75, output: 16.5, cacheRead: 0.275, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_X_THINKING,
	},
	{
		id: "openai.gpt-5.5",
		name: "GPT-5.5",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_X_THINKING,
	},
	{
		id: "openai.gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_6_THINKING,
	},
	{
		id: "openai.gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_6_THINKING,
	},
	{
		id: "openai.gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.2, output: 13.2, cacheRead: 0.22, cacheWrite: 2.75 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_6_THINKING,
	},
];

const BEDROCK_MANTLE_MODEL_BY_ID: Partial<Record<string, ModelSpec<"openai-responses">>> = Object.fromEntries(
	BEDROCK_MANTLE_STATIC_MODELS.map(model => [model.id, model]),
);

export function bedrockMantleModelManagerOptions(
	config: ModelManagerConfig = {},
): ModelManagerOptions<"openai-responses"> {
	const inferenceBaseUrl = config.baseUrl ?? BEDROCK_MANTLE_BASE_URL;
	const discoveryBaseUrl = inferenceBaseUrl.replace(/\/openai\/v1\/?$/, "/v1");
	return {
		providerId: "bedrock-mantle",
		staticModels: BEDROCK_MANTLE_STATIC_MODELS,
		// The bearer-scoped /v1/models response lists only the models enabled for
		// the account; a successful fetch replaces the static seed instead of
		// merging, so disabled models are not selectable.
		dynamicModelsAuthoritative: true,
		...(config.authenticated && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "bedrock-mantle",
					baseUrl: discoveryBaseUrl,
					fetch: config.fetch,
					mapModel: (entry, defaults) =>
						mapWithBundledReference(
							entry,
							{ ...defaults, baseUrl: BEDROCK_MANTLE_BASE_URL },
							BEDROCK_MANTLE_MODEL_BY_ID[defaults.id],
						),
				}),
		}),
	};
}

export interface MetaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function metaModelManagerOptions(config?: MetaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	return {
		...createOpenAICompatibleModelManagerOptions({
			api: "openai-responses",
			providerId: "meta",
			defaultBaseUrl: META_MODEL_API_BASE_URL,
			config,
			requireApiKey: true,
			mapModel: mapWithBundledReference,
		}),
		staticModels: META_MUSE_STATIC_MODELS,
	};
}

// ---------------------------------------------------------------------------
// 16. Moonshot
// ---------------------------------------------------------------------------

export interface MoonshotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Moonshot Kimi K3 discovery metadata. K3 is dynamically discovered but absent
 * from models.dev and the bundled catalog, so `mapWithBundledReference` would
 * otherwise assign zero cost, null limits, text-only input, and no reasoning —
 * mislabeling a paid model as "Free" (#5756). Pricing/limits from Moonshot's
 * official chat-k3 pricing and quickstart guide:
 *   https://platform.kimi.ai/docs/pricing/chat-k3.md
 *   https://platform.kimi.ai/docs/guide/kimi-k3-quickstart
 * K3 always reasons and supports only `reasoning_effort: "max"` — it does NOT
 * use the K2.x binary `thinking: { type }` block, so the wire path routes it
 * through OpenAI-style `reasoning_effort` (see `buildOpenAICompat`).
 */
const MOONSHOT_KIMI_K3_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } as const;
export function moonshotModelManagerOptions(
	config?: MoonshotModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "moonshot",
		// `MOONSHOT_BASE_URL` redirects discovery (and the streaming request that
		// inherits this baseUrl) at the Kimi China platform `api.moonshot.cn`; an
		// explicit `config.baseUrl` still wins. Mirrors LITELLM_BASE_URL/LM_STUDIO_BASE_URL. (#2883)
		defaultBaseUrl: Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1",
		config,
		requireApiKey: true,
		mapModel: (entry, defaults, reference) => {
			const model = mapWithBundledReference(entry, defaults, reference);
			const id = model.id.toLowerCase();
			// Kimi K3 is discovered but has no bundled/models.dev reference, so the
			// generic dynamic defaults would report it "Free" with no capabilities
			// (#5756). Modalities, limits, and the reasoning surface are rule-owned
			// (`providers/moonshot.kdl`, `runtime/behavior.kdl` model-limits) and
			// baked at build time; the mapper seeds only the official pricing when
			// the endpoint reports zero cost, plus the structured reasoning fact.
			const identity = classifyModel("moonshot", id, { lenient: true });
			if (!reference && identity.class === "kimi" && identity.family === "k3") {
				const isZeroCost = model.cost.input === 0 && model.cost.output === 0 && model.cost.cacheRead === 0;
				const limits = modelLimitsFor("moonshot", id) ?? modelLimitsFor("moonshot", "kimi-k3");
				return {
					...model,
					reasoning: true,
					cost: isZeroCost ? { ...MOONSHOT_KIMI_K3_COST } : model.cost,
					contextWindow: model.contextWindow ?? limits?.context ?? null,
					maxTokens: model.maxTokens ?? limits?.maxTokens ?? null,
				};
			}
			// Moonshot's K2.x generation and its thinking variants reason on the
			// native API (#2113); the effort ladder and modalities are rule-owned
			// and derived at build time from this flag.
			const isKimiK2Generation = identity.class === "kimi" && identity.family?.startsWith("k2") === true;
			return {
				...model,
				reasoning: identity.thinkingVariant === true || isKimiK2Generation || model.reasoning,
			};
		},
	});
}

// ---------------------------------------------------------------------------
// 16.5 Sakana AI
// ---------------------------------------------------------------------------

const SAKANA_DEFAULT_BASE_URL = "https://api.sakana.ai/v1";
const SAKANA_FREE_ROUTER_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const SAKANA_FUGU_ULTRA_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } as const;
const SAKANA_FUGU_ULTRA_CONTEXT_WINDOW = 1_000_000;
const SAKANA_FUGU_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.Max],
};
const SAKANA_RESPONSES_COMPAT: ModelSpec<"openai-responses">["compat"] = {
	includeEncryptedReasoning: false,
	streamIdleTimeoutMs: 0,
};

function normalizeSakanaBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim() || SAKANA_DEFAULT_BASE_URL;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function isSakanaFuguModelId(modelId: string): boolean {
	return /^fugu(?:$|-)/i.test(modelId);
}

function createSakanaFuguStaticModel(
	id: string,
	name: string,
	cost: ModelSpec<"openai-responses">["cost"],
	contextWindow: number | null,
): ModelSpec<"openai-responses"> {
	return {
		id,
		name,
		api: "openai-responses",
		provider: "sakana",
		baseUrl: SAKANA_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { ...cost },
		contextWindow,
		maxTokens: null,
		thinking: { ...SAKANA_FUGU_THINKING },
		compat: { ...SAKANA_RESPONSES_COMPAT },
	};
}

export const SAKANA_FUGU_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	createSakanaFuguStaticModel("fugu", "Fugu", SAKANA_FREE_ROUTER_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel("fugu-ultra", "Fugu Ultra", SAKANA_FUGU_ULTRA_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel(
		"fugu-ultra-20260615",
		"Fugu Ultra 20260615",
		SAKANA_FUGU_ULTRA_COST,
		SAKANA_FUGU_ULTRA_CONTEXT_WINDOW,
	),
];

const SAKANA_FUGU_STATIC_MODEL_BY_ID = new Map(SAKANA_FUGU_STATIC_MODELS.map(model => [model.id, model] as const));
const SAKANA_FUGU_STATIC_MODEL_IDS = SAKANA_FUGU_STATIC_MODELS.map(model => model.id);

export interface SakanaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function sakanaModelManagerOptions(config?: SakanaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeSakanaBaseUrl(config?.baseUrl ?? Bun.env.SAKANA_BASE_URL ?? Bun.env.FUGU_BASE_URL);
	const references = createBundledReferenceMap<"openai-responses">("sakana");
	return {
		providerId: "sakana",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: SAKANA_FUGU_STATIC_MODEL_IDS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "sakana",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id) ?? SAKANA_FUGU_STATIC_MODEL_BY_ID.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						if (!reference && isSakanaFuguModelId(model.id)) {
							return {
								...model,
								reasoning: true,
								thinking: { ...SAKANA_FUGU_THINKING },
								compat: { ...SAKANA_RESPONSES_COMPAT },
							};
						}
						return model;
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 16.6 ai& (aiand.com)
// ---------------------------------------------------------------------------

const AIAND_DEFAULT_BASE_URL = "https://api.aiand.com/v1";

/** `reasoning_efforts` wire values ai& reports, mapped onto pi effort levels. */
const AIAND_EFFORT_BY_WIRE_VALUE: Record<string, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

function normalizeAiandBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim() || AIAND_DEFAULT_BASE_URL;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function createAiandStaticModel(
	id: string,
	name: string,
	cost: { input: number; output: number },
	contextWindow: number,
	input: ModelSpec<"openai-completions">["input"],
): ModelSpec<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "aiand",
		baseUrl: AIAND_DEFAULT_BASE_URL,
		reasoning: true,
		input: [...input],
		cost: { input: cost.input, output: cost.output, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: null,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High], defaultLevel: Effort.Medium },
	};
}

/**
 * Documented ai& catalog (docs.aiand.com/models/catalog, 2026-08) bundled so
 * the provider is usable when generation and first boot have no live key.
 * The org-scoped `/v1/models` response is authoritative once discovery runs.
 */
export const AIAND_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	createAiandStaticModel("qwen/qwen3.6-27b", "Qwen3.6 27B", { input: 0, output: 0 }, 262_144, ["text"]),
	createAiandStaticModel(
		"deepseek-ai/deepseek-v4-flash",
		"DeepSeek V4 Flash",
		{ input: 0.15, output: 0.25 },
		1_000_000,
		["text"],
	),
	createAiandStaticModel("google/gemma-4-31b-it", "Gemma 4 31B IT", { input: 0.2, output: 0.5 }, 262_144, [
		"text",
		"image",
	]),
	createAiandStaticModel("openai/gpt-oss-120b", "GPT OSS 120B", { input: 0.15, output: 0.6 }, 131_072, ["text"]),
	createAiandStaticModel("deepseek-ai/deepseek-v4-pro", "DeepSeek V4 Pro", { input: 1, output: 2.5 }, 1_000_000, [
		"text",
	]),
	createAiandStaticModel("moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", { input: 0.75, output: 3.5 }, 262_144, [
		"text",
		"image",
	]),
	createAiandStaticModel("moonshotai/kimi-k2.6", "Kimi K2.6", { input: 0.85, output: 3.5 }, 262_144, [
		"text",
		"image",
	]),
	createAiandStaticModel("zai-org/glm-5.2", "GLM 5.2", { input: 1, output: 4 }, 1_000_000, ["text"]),
	createAiandStaticModel("zai-org/glm-5.1", "GLM 5.1", { input: 1.4, output: 4.4 }, 202_752, ["text"]),
];

const AIAND_STATIC_MODEL_IDS = AIAND_STATIC_MODELS.map(model => model.id);

function mapAiandThinking(entry: OpenAICompatibleModelRecord): ThinkingConfig | undefined {
	const efforts = Array.isArray(entry.reasoning_efforts)
		? entry.reasoning_efforts.flatMap(value =>
				typeof value === "string" && AIAND_EFFORT_BY_WIRE_VALUE[value] ? [AIAND_EFFORT_BY_WIRE_VALUE[value]] : [],
			)
		: [];
	if (efforts.length === 0) {
		return undefined;
	}
	const defaultLevel =
		typeof entry.reasoning_effort_default === "string"
			? AIAND_EFFORT_BY_WIRE_VALUE[entry.reasoning_effort_default]
			: undefined;
	return {
		mode: "effort",
		efforts,
		...(defaultLevel && efforts.includes(defaultLevel) && { defaultLevel }),
	};
}

/**
 * ai& reports prices as decimal strings per 1M tokens in the org's billing
 * currency (`usd` or `jpy`). Costs are only mapped for USD orgs — JPY figures
 * would corrupt the USD-denominated cost model, so they fall back to zero.
 */
function mapAiandCost(entry: OpenAICompatibleModelRecord): ModelSpec<"openai-completions">["cost"] {
	if (typeof entry.currency === "string" && entry.currency !== "usd") {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	return {
		input: toPositiveNumber(entry.input_per_1m, 0),
		output: toPositiveNumber(entry.output_per_1m, 0),
		cacheRead: 0,
		cacheWrite: 0,
	};
}

function mapAiandModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const capabilities: unknown[] = Array.isArray(entry.capabilities) ? entry.capabilities : [];
	const reasoning = capabilities.includes("reasoning");
	const thinking = reasoning ? mapAiandThinking(entry) : undefined;
	const description =
		typeof entry.description === "string" && entry.description.trim() ? entry.description : undefined;
	return {
		...defaults,
		name: description ?? toModelName(entry.name, defaults.name),
		reasoning,
		input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: mapAiandCost(entry),
		contextWindow: toPositiveNumber(entry.context_window, null),
		...(thinking && { thinking }),
	};
}

export interface AiandModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * ai& (aiand.com) model manager: OpenAI-compatible chat completions with an
 * org-scoped `/v1/models` catalog carrying context, capability, effort, and
 * pricing metadata, so discovery is authoritative over the bundled seed.
 */
export function aiandModelManagerOptions(config?: AiandModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAiandBaseUrl(config?.baseUrl ?? Bun.env.AIAND_BASE_URL);
	return {
		providerId: "aiand",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: AIAND_STATIC_MODEL_IDS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "aiand",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => mapAiandModel(entry, defaults),
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 16.7 Yolo-Auto (yolo-auto.com)
// ---------------------------------------------------------------------------

const YOLO_AUTO_BASE_URL = "https://yolo-auto.com/v1";

/**
 * Documented Yolo-Auto catalog (yolo-auto.com/docs, 2026-08) bundled so the
 * provider is usable when generation and first boot have no live key. The
 * flat-rate `/v1/models` response is authoritative once discovery runs.
 * The compat block mirrors the provider's documented wire surface: the API
 * speaks the generic chat template with `reasoning_effort` support and rejects
 * the `developer` role and `store` param.
 */
export const YOLO_AUTO_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "deepseek-flash-v4",
		name: "DeepSeek Flash V4",
		api: "openai-completions",
		provider: "yolo-auto",
		baseUrl: YOLO_AUTO_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortMap: {
				[Effort.Minimal]: "low",
				[Effort.Low]: "low",
				[Effort.Medium]: "high",
				[Effort.High]: "high",
				[Effort.XHigh]: "max",
				[Effort.Max]: "max",
			},
		},
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: null,
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
			thinkingFormat: "chat-template",
		},
	},
];

export interface YoloAutoModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Map a discovered entry onto its reference, then re-apply Yolo-Auto's
 * provider-wide wire constraints. A model that only exists in another
 * provider's bundle (e.g. `gpt-4o` served via the global reference index)
 * would otherwise inherit that provider's token pricing and `store`-capable
 * surface, which the flat-rate Yolo endpoint neither charges nor accepts.
 */
function mapYoloAutoModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	const model = mapWithBundledReference(entry, defaults, reference);
	return {
		...model,
		// Flat-rate and no-store are provider-wide: they must win whether the
		// reference came from the yolo bundle, the global index, or nowhere.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			...model.compat,
			supportsStore: false,
			supportsDeveloperRole: false,
		},
	};
}
/**
 * Yolo-Auto model manager: OpenAI-compatible chat completions at the
 * flat-rate `deepseek-flash-v4` endpoint. Live `/v1/models` discovery replaces the
 * bundled seed once a key is stored or present in `YOLO_AUTO_API_KEY`. Models
 * the provider adds later inherit metadata (reasoning, thinking, context)
 * from the global bundled reference index, so new ids work without a per-id
 * code change.
 */
export function yoloAutoModelManagerOptions(
	config?: YoloAutoModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	// Curated static models take precedence over the previously generated
	// bundle so later corrections to the curated metadata are honored; bundle
	// rows keep ids that earlier credentialed runs discovered, and the global
	// index covers everything else.
	const references = new Map<string, ModelSpec<"openai-completions">>();
	const bundled = createBundledReferenceMap<"openai-completions">("yolo-auto");
	for (const model of bundled.values()) {
		references.set(model.id, model);
	}
	for (const model of YOLO_AUTO_STATIC_MODELS) {
		const previous = references.get(model.id);
		references.set(model.id, {
			...previous,
			...model,
			// Generation-filled fields the curated seed leaves null: keep the
			// canonical values baked by the previous regen (max-output cap,
			// derived thinking) instead of dropping them.
			maxTokens: model.maxTokens ?? previous?.maxTokens ?? null,
			thinking: model.thinking ?? previous?.thinking,
		});
	}
	const resolveReference = createReferenceResolver(() => references);
	return {
		...createOpenAICompatibleModelManagerOptions({
			api: "openai-completions",
			providerId: "yolo-auto",
			defaultBaseUrl: YOLO_AUTO_BASE_URL,
			config,
			requireApiKey: true,
			mapModel: (entry, defaults, reference) =>
				mapYoloAutoModel(entry, defaults, resolveReference(defaults.id) ?? reference),
			dynamicModelsAuthoritative: true,
		}),
	};
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 17. Qwen Portal
// ---------------------------------------------------------------------------

export interface QwenPortalModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qwenPortalModelManagerOptions(
	config?: QwenPortalModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qwen-portal", "https://portal.qwen.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 18. Qianfan
// ---------------------------------------------------------------------------

export interface QianfanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qianfanModelManagerOptions(
	config?: QianfanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qianfan", "https://qianfan.baidubce.com/v2", config);
}

// ---------------------------------------------------------------------------
// 19. Cloudflare AI Gateway
// ---------------------------------------------------------------------------

export interface CloudflareAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cloudflareAiGatewayModelManagerOptions(
	config?: CloudflareAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	return createSimpleAnthropicProviderOptions(
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
		config,
	);
}

// ---------------------------------------------------------------------------
// 20. Xiaomi
// ---------------------------------------------------------------------------

/** Region codes for Xiaomi Token Plan clusters exposed as separate login providers. */
export type XiaomiTokenPlanRegion = "sgp" | "ams" | "cn";

/** Configures Xiaomi standard or regional Token Plan OpenAI-compatible model discovery. */
export interface XiaomiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	providerId?: Provider;
	tokenPlanRegion?: XiaomiTokenPlanRegion;
}

const XIAOMI_TOKEN_PLAN_BASE_URLS: Record<XiaomiTokenPlanRegion, string> = {
	sgp: "https://token-plan-sgp.xiaomimimo.com/v1",
	ams: "https://token-plan-ams.xiaomimimo.com/v1",
	cn: "https://token-plan-cn.xiaomimimo.com/v1",
};

const XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS = [
	XIAOMI_TOKEN_PLAN_BASE_URLS.sgp,
	XIAOMI_TOKEN_PLAN_BASE_URLS.ams,
	XIAOMI_TOKEN_PLAN_BASE_URLS.cn,
];

/** Builds a Xiaomi model manager, preserving Token Plan region provider ids during discovery. */
export function xiaomiModelManagerOptions(
	config?: XiaomiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const providerId = config?.providerId ?? "xiaomi";
	const tokenPlanBaseUrls = config?.tokenPlanRegion
		? [XIAOMI_TOKEN_PLAN_BASE_URLS[config.tokenPlanRegion]]
		: XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS;
	const XIAOMI_STANDARD_BASE_URL = "https://api.xiaomimimo.com/v1";
	const isTokenPlanProvider = config?.tokenPlanRegion !== undefined || providerId.startsWith("xiaomi-token-plan-");
	const isTokenPlanKey = isTokenPlanProvider || apiKey?.startsWith("tp-");
	// Token-plan keys always use a TP cluster; config?.baseUrl (from catalog)
	// would incorrectly pin to the standard endpoint (api.xiaomimimo.com).
	const baseUrl = isTokenPlanKey ? tokenPlanBaseUrls[0] : (config?.baseUrl ?? XIAOMI_STANDARD_BASE_URL);
	const references = createBundledReferenceMap<"openai-completions">("xiaomi");
	const fetchModels = (url: string) =>
		fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: providerId,
			baseUrl: url,
			apiKey,
			filterModel: (_entry, model) => !isExcludedModel(providerId, model.id),
			mapModel: (entry, defaults) => {
				const reference = references.get(defaults.id);
				const model = mapWithBundledReference(entry, defaults, reference);
				return {
					...model,
					api: "openai-completions",
					provider: providerId,
					baseUrl: defaults.baseUrl,
					name: toModelName(entry.display_name, model.name),
				};
			},
			fetch: config?.fetch,
		});
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: async () => {
				if (!isTokenPlanKey) {
					return fetchModels(baseUrl);
				}
				for (const url of tokenPlanBaseUrls) {
					const result = await fetchModels(url);
					if (result) return result;
				}
				return null;
			},
		}),
	};
}
// ---------------------------------------------------------------------------
// 21. LiteLLM
// ---------------------------------------------------------------------------

export interface LiteLLMModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export interface FetchLiteLLMRichModelsOptions<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	referenceResolver?: (modelId: string) => ModelSpec<TApi> | undefined;
	resolveApi?: (entry: Record<string, unknown>, modelId: string) => TApi;
}

type LiteLLMRichModelEntry = Record<string, unknown>;
type LiteLLMApiRoute = "openai" | "other" | "unknown";
type LiteLLMRichEndpointModel<TApi extends Api> = {
	model: ModelSpec<TApi>;
	apiRoute: LiteLLMApiRoute;
	supportsVision: unknown;
	supportsReasoning: unknown;
	hasContextWindow: boolean;
	hasMaxTokens: boolean;
	hasToolMetadata: boolean;
	hasSupportedOpenAIParams: boolean;
	hasCost: boolean;
	reportedCost: Partial<ModelSpec<Api>["cost"]>;
};
type LiteLLMRichEndpointFailure = {
	endpoint: string;
	reason: "http-status" | "invalid-json" | "network-error";
	status?: number;
	error?: unknown;
};
type LiteLLMRichEndpointResult<TApi extends Api> =
	| { models: LiteLLMRichEndpointModel<TApi>[]; incompleteVisionMetadata: boolean }
	| { failure: LiteLLMRichEndpointFailure };

const LITELLM_RICH_ENDPOINTS = ["/model_group/info", "/v2/model/info", "/model/info", "/v1/model/info"] as const;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;
const UNKNOWN_PROXY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const warnedLiteLLMMetadataBases = new Set<string>();
const LITELLM_UNUSABLE_SENTINEL_IDS: Record<string, true> = {
	"all-team-models": true,
	"all-proxy-models": true,
	"no-default-models": true,
};
function warnLiteLLMMetadataFallback(managementBaseUrl: string, failure: LiteLLMRichEndpointFailure): void {
	if (warnedLiteLLMMetadataBases.has(managementBaseUrl)) {
		return;
	}
	warnedLiteLLMMetadataBases.add(managementBaseUrl);
	logger.warn("LiteLLM rich model metadata unavailable; falling back to /v1/models", {
		endpoint: `${managementBaseUrl}${failure.endpoint}`,
		status: failure.status ?? "unavailable",
		reason: failure.reason,
		...(failure.status === 403
			? { requiredPermission: "Grant this LiteLLM key access to the model metadata endpoints" }
			: {}),
		...(failure.error !== undefined ? { error: failure.error } : {}),
	});
}

export function normalizeLiteLLMManagementBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/g, "");
	if (!trimmed) {
		return "";
	}
	try {
		const parsed = new URL(trimmed);
		const path = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return trimmed.replace(/\/v1$/, "");
	}
}

function normalizeLiteLLMRuntimeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

const LITELLM_RESELLER_USAGE_SUFFIX = /\s+\(\d+(?:\.\d+)?[x×] usage\)$/i;

function stripLiteLLMResellerUsageSuffix(name: string): string {
	const cleaned = name.replace(LITELLM_RESELLER_USAGE_SUFFIX, "").trim();
	return cleaned.length > 0 ? cleaned : name;
}

function toLiteLLMDisplayName(modelName: string | undefined, referenceName: string | undefined, id: string): string {
	const cleanedModelName = modelName ? stripLiteLLMResellerUsageSuffix(modelName) : undefined;
	if (cleanedModelName && cleanedModelName !== id) {
		return cleanedModelName;
	}
	return referenceName ? stripLiteLLMResellerUsageSuffix(referenceName) : id;
}

function mapLiteLLMOpenAICompatibleModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<Api>,
	reference: ModelSpec<Api> | undefined,
): ModelSpec<Api> {
	const model = mapWithBundledReference(entry, defaults, reference);
	return {
		...model,
		api: resolveLiteLLMApi(undefined, model.id),
		name: stripLiteLLMResellerUsageSuffix(model.name),
	};
}

function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function extractLiteLLMRichEntries(payload: unknown): LiteLLMRichModelEntry[] | null {
	if (Array.isArray(payload)) {
		return payload.flatMap(entry => (isRecord(entry) ? [entry] : []));
	}
	if (!isRecord(payload)) {
		return null;
	}
	for (const candidate of [payload.data, payload.models, payload.result, payload.items]) {
		if (candidate === undefined) {
			continue;
		}
		const entries = extractLiteLLMRichEntries(candidate);
		if (entries !== null) {
			return entries;
		}
	}
	return null;
}

function getLiteLLMModelInfo(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.model_info) ? entry.model_info : undefined;
}

function getLiteLLMParams(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.litellm_params) ? entry.litellm_params : undefined;
}

function getLiteLLMMetadataValue(entry: LiteLLMRichModelEntry, key: string): unknown {
	return entry[key] ?? getLiteLLMModelInfo(entry)?.[key];
}
/** Per-million USD cost from a positive `*_per_token` LiteLLM field. */
function getLiteLLMPerMillionCost(entry: LiteLLMRichModelEntry, key: string): number | undefined {
	const perToken = toNumber(getLiteLLMMetadataValue(entry, key));
	return perToken !== undefined && perToken > 0 ? perToken * 1_000_000 : undefined;
}

/** Map positive LiteLLM per-token prices onto their per-million cost fields. */
function getLiteLLMReportedCost(entry: LiteLLMRichModelEntry): Partial<ModelSpec<Api>["cost"]> {
	const input = getLiteLLMPerMillionCost(entry, "input_cost_per_token");
	const output = getLiteLLMPerMillionCost(entry, "output_cost_per_token");
	const cacheRead = getLiteLLMPerMillionCost(entry, "cache_read_input_token_cost");
	const cacheWrite = getLiteLLMPerMillionCost(entry, "cache_creation_input_token_cost");
	return {
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cacheRead !== undefined ? { cacheRead } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
	};
}

function getLiteLLMCost(entry: LiteLLMRichModelEntry): ModelSpec<Api>["cost"] | undefined {
	const cost = getLiteLLMReportedCost(entry);
	if (cost.input === undefined && cost.output === undefined) {
		return undefined;
	}
	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
	};
}

function getLiteLLMRichModelId(entry: LiteLLMRichModelEntry): string | undefined {
	return (
		toNonEmptyString(entry.model_group) ??
		toNonEmptyString(entry.model_name) ??
		toNonEmptyString(entry.id) ??
		toNonEmptyString(getLiteLLMParams(entry)?.model)
	);
}

function getSupportedOpenAIParams(entry: LiteLLMRichModelEntry): string[] | undefined {
	const value = getLiteLLMMetadataValue(entry, "supported_openai_params");
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.flatMap(item => (typeof item === "string" ? [item] : []));
}

function getLiteLLMProviders(entry: LiteLLMRichModelEntry): string[] | undefined {
	if (!Array.isArray(entry.providers)) {
		return undefined;
	}
	const providers = entry.providers.flatMap(provider => {
		const normalized = toNonEmptyString(provider)?.toLowerCase();
		return normalized ? [normalized] : [];
	});
	return providers.length > 0 ? providers : undefined;
}

function classifyLiteLLMApiRoute(entry: LiteLLMRichModelEntry | undefined, id: string): LiteLLMApiRoute {
	if (entry) {
		const providers = getLiteLLMProviders(entry);
		if (providers) {
			return providers.every(provider => provider === "openai") ? "openai" : "other";
		}

		const params = getLiteLLMParams(entry);
		const configuredProvider = toNonEmptyString(params?.custom_llm_provider)?.toLowerCase();
		if (configuredProvider) {
			return configuredProvider === "openai" ? "openai" : "other";
		}

		const backendModel = toNonEmptyString(params?.model);
		const backendSeparator = backendModel?.indexOf("/") ?? -1;
		if (backendModel && backendSeparator > 0) {
			return backendModel.slice(0, backendSeparator).toLowerCase() === "openai" ? "openai" : "other";
		}

		const baseModel = toNonEmptyString(getLiteLLMMetadataValue(entry, "base_model"));
		const baseSeparator = baseModel?.indexOf("/") ?? -1;
		if (baseModel && baseSeparator > 0) {
			return baseModel.slice(0, baseSeparator).toLowerCase() === "openai" ? "openai" : "other";
		}
	}

	const modelId = id.toLowerCase().startsWith("openai/") ? id.slice("openai/".length) : id;
	return isLikelyOpenAIResponsesModelId(modelId) ? "openai" : "unknown";
}

export function resolveLiteLLMApi(
	entry: Record<string, unknown> | undefined,
	id: string,
	fallbackApi: Api = "openai-completions",
): Api {
	return classifyLiteLLMApiRoute(entry, id) === "openai" ? "openai-responses" : fallbackApi;
}

function isLiteLLMUnusableSentinelPlaceholder(entry: LiteLLMRichModelEntry): boolean {
	const modelGroup = toNonEmptyString(entry.model_group);
	const id = toNonEmptyString(entry.id);
	if (
		(modelGroup === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[modelGroup] !== true) &&
		(id === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true)
	) {
		return false;
	}
	const providers = entry.providers;
	if (providers !== undefined && (!Array.isArray(providers) || providers.length > 0)) {
		return false;
	}
	const modelName = toNonEmptyString(entry.model_name);
	if (modelName && LITELLM_UNUSABLE_SENTINEL_IDS[modelName] !== true) {
		return false;
	}
	if (id && LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true) {
		return false;
	}
	const backendModel = toNonEmptyString(getLiteLLMParams(entry)?.model);
	if (backendModel && LITELLM_UNUSABLE_SENTINEL_IDS[backendModel] !== true) {
		return false;
	}
	if (
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null ||
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null
	) {
		return false;
	}
	if (
		getLiteLLMMetadataValue(entry, "supports_vision") === true ||
		getLiteLLMMetadataValue(entry, "supports_reasoning") === true ||
		getLiteLLMMetadataValue(entry, "supports_function_calling") === true ||
		getLiteLLMMetadataValue(entry, "supports_tools") === true
	) {
		return false;
	}
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	if (supportedOpenAIParams && supportedOpenAIParams.length > 0) {
		return false;
	}
	return true;
}

function mapLiteLLMRichEntry<TApi extends Api>(
	entry: LiteLLMRichModelEntry,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	runtimeBaseUrl: string,
): ModelSpec<TApi> | null {
	if (isLiteLLMUnusableSentinelPlaceholder(entry)) {
		return null;
	}
	const id = getLiteLLMRichModelId(entry);
	if (!id) {
		return null;
	}
	const reference = options.referenceResolver?.(id);
	const modelName = toNonEmptyString(entry.model_name);
	const contextWindow = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_input_tokens"),
		reference?.contextWindow ?? OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_output_tokens"),
		reference?.maxTokens ?? Math.min(contextWindow, OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS),
	);
	const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
	const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
	const supportsTools =
		supportsFunctionCalling === true
			? true
			: supportsFunctionCalling === false
				? false
				: supportedOpenAIParams !== undefined
					? supportedOpenAIParams.some(param =>
							["tools", "tool_choice", "functions", "function_call"].includes(param),
						)
					: reference?.supportsTools;
	// Enrich from the bundled reference with provider-INDEPENDENT reasoning
	// hints only. The reference is resolved against the global bundled catalog,
	// so a custom endpoint exposing an alias that collides with a bundled model
	// (a LiteLLM proxy serving `kimi-k3`, which matches Fireworks' bundled
	// `kimi-k3`) must not inherit that provider's transport compat. Spreading
	// the resolved `reference.compat` wholesale leaked `wireModelIdMode`,
	// `toolSchemaFlavor`, `thinkingFormat`, etc. across the provider boundary —
	// rewriting the wire id to `accounts/fireworks/models/kimi-k3` for a
	// non-Fireworks endpoint (issue #9938). `buildModel` re-derives every
	// transport field from the discovered provider and model id, so only the
	// effort vocabulary flows through here. Mirrors `discoverOpenAIModelsList`.
	const referenceCompat = reference?.compat as OpenAICompat | undefined;
	const compat: OpenAICompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		...(supportedOpenAIParams !== undefined
			? { supportsReasoningEffort: supportedOpenAIParams.includes("reasoning_effort") }
			: referenceCompat?.supportsReasoningEffort !== undefined
				? { supportsReasoningEffort: referenceCompat.supportsReasoningEffort }
				: {}),
		...(referenceCompat?.reasoningEffortMap ? { reasoningEffortMap: referenceCompat.reasoningEffortMap } : {}),
		...(referenceCompat?.omitReasoningEffort !== undefined
			? { omitReasoningEffort: referenceCompat.omitReasoningEffort }
			: {}),
	};
	return {
		id,
		name: toLiteLLMDisplayName(modelName, reference?.name, id),
		api: options.resolveApi?.(entry, id) ?? options.api,
		provider: options.provider,
		baseUrl: runtimeBaseUrl,
		contextWindow,
		maxTokens,
		input:
			supportsVision === true
				? ["text", "image"]
				: supportsVision === false
					? ["text"]
					: (reference?.input ?? ["text"]),
		reasoning: typeof supportsReasoning === "boolean" ? supportsReasoning : (reference?.reasoning ?? false),
		thinking: reference?.thinking,
		cost: getLiteLLMCost(entry) ?? reference?.cost ?? UNKNOWN_PROXY_COST,
		...(supportsTools !== undefined ? { supportsTools } : {}),
		compat: compat as ModelSpec<TApi>["compat"],
	};
}

function mergeLiteLLMRichEndpointModels<TApi extends Api>(
	existing: LiteLLMRichEndpointModel<TApi>,
	next: LiteLLMRichEndpointModel<TApi>,
): LiteLLMRichEndpointModel<TApi> {
	const apiRoute =
		existing.apiRoute === "other" || next.apiRoute === "other"
			? "other"
			: existing.apiRoute === "openai" || next.apiRoute === "openai"
				? "openai"
				: "unknown";
	const api = next.apiRoute === apiRoute ? next.model.api : existing.model.api;
	const model: ModelSpec<TApi> = {
		...existing.model,
		api,
		name: next.model.name === next.model.id ? existing.model.name : next.model.name,
		contextWindow: next.hasContextWindow ? next.model.contextWindow : existing.model.contextWindow,
		maxTokens: next.hasMaxTokens ? next.model.maxTokens : existing.model.maxTokens,
		input: next.supportsVision === true || next.supportsVision === false ? next.model.input : existing.model.input,
		reasoning: typeof next.supportsReasoning === "boolean" ? next.model.reasoning : existing.model.reasoning,
		cost: { ...existing.model.cost, ...existing.reportedCost, ...next.reportedCost },
		compat: next.hasSupportedOpenAIParams ? next.model.compat : existing.model.compat,
	};
	if (next.hasToolMetadata) {
		model.supportsTools = next.model.supportsTools;
	}
	return {
		...next,
		apiRoute,
		model,
		reportedCost: { ...existing.reportedCost, ...next.reportedCost },
		hasContextWindow: existing.hasContextWindow || next.hasContextWindow,
		hasMaxTokens: existing.hasMaxTokens || next.hasMaxTokens,
		hasToolMetadata: existing.hasToolMetadata || next.hasToolMetadata,
		hasSupportedOpenAIParams: existing.hasSupportedOpenAIParams || next.hasSupportedOpenAIParams,
		hasCost: existing.hasCost || next.hasCost,
	};
}

async function fetchLiteLLMRichEndpoint<TApi extends Api>(
	endpoint: string,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	managementBaseUrl: string,
	runtimeBaseUrl: string,
	signal?: AbortSignal,
): Promise<LiteLLMRichEndpointResult<TApi> | null> {
	const fetchImpl = discoveryFetch(options.fetch);
	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}
	let response: Response;
	try {
		response = await fetchImpl(`${managementBaseUrl}${endpoint}`, {
			method: "GET",
			headers: requestHeaders,
			signal,
		});
	} catch (error) {
		return { failure: { endpoint, reason: "network-error", error } };
	}
	if (!response.ok) {
		return response.status === 404 ? null : { failure: { endpoint, reason: "http-status", status: response.status } };
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		return { failure: { endpoint, reason: "invalid-json", status: response.status, error } };
	}
	const entries = extractLiteLLMRichEntries(payload);
	if (!entries || entries.length === 0) {
		return null;
	}
	const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
	for (const entry of entries) {
		const model = mapLiteLLMRichEntry(entry, options, runtimeBaseUrl);
		if (model) {
			const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
			const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
			const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
			const supportedOpenAIParams = getSupportedOpenAIParams(entry);
			const next: LiteLLMRichEndpointModel<TApi> = {
				model,
				apiRoute: classifyLiteLLMApiRoute(entry, model.id),
				supportsVision,
				supportsReasoning,
				hasContextWindow: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null,
				hasMaxTokens: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null,
				hasToolMetadata:
					supportsFunctionCalling === true ||
					supportsFunctionCalling === false ||
					supportedOpenAIParams !== undefined,
				hasSupportedOpenAIParams: supportedOpenAIParams !== undefined,
				hasCost: getLiteLLMCost(entry) !== undefined,
				reportedCost: getLiteLLMReportedCost(entry),
			};
			const existing = deduped.get(model.id);
			deduped.set(model.id, existing ? mergeLiteLLMRichEndpointModels(existing, next) : next);
		}
	}
	if (deduped.size === 0) {
		return null;
	}
	const models = Array.from(deduped.values()).sort((left, right) => left.model.id.localeCompare(right.model.id));
	return {
		models,
		incompleteVisionMetadata: models.some(entry => entry.supportsVision !== true && entry.supportsVision !== false),
	};
}

async function fetchLiteLLMRichModelsInternal<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const managementBaseUrl = normalizeLiteLLMManagementBaseUrl(options.baseUrl);
	const runtimeBaseUrl = normalizeLiteLLMRuntimeBaseUrl(options.baseUrl);
	if (!managementBaseUrl || !runtimeBaseUrl) {
		return null;
	}
	const fetchModels = async (signal?: AbortSignal): Promise<ModelSpec<TApi>[] | null> => {
		const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
		let metadataFailure: LiteLLMRichEndpointFailure | undefined;
		for (const endpoint of LITELLM_RICH_ENDPOINTS) {
			const result = await fetchLiteLLMRichEndpoint(endpoint, options, managementBaseUrl, runtimeBaseUrl, signal);
			if (!result) {
				continue;
			}
			if ("failure" in result) {
				// A 401 is a retryable auth failure owned by the caller's auth-retry
				// path (withAuth refresh/sibling rotation in discoverLiteLLMModels);
				// recording it here would log a fallback warning on a stale first
				// credential before the refreshed retry ultimately serves rich
				// metadata. Forbidden (403) and other failures are never retried, so
				// they remain warn-worthy and keep priority.
				if (
					result.failure.status !== 401 &&
					(!metadataFailure || (metadataFailure.status !== 403 && result.failure.status === 403))
				) {
					metadataFailure = result.failure;
				}
				continue;
			}
			const hadPriorModels = deduped.size > 0;
			for (const next of result.models) {
				const existing = deduped.get(next.model.id);
				if (!existing) {
					if (!hadPriorModels) {
						deduped.set(next.model.id, next);
					}
					continue;
				}
				deduped.set(next.model.id, mergeLiteLLMRichEndpointModels(existing, next));
			}
			let needsMoreMetadata = false;
			for (const entry of deduped.values()) {
				if (
					(entry.supportsVision !== true && entry.supportsVision !== false) ||
					(options.resolveApi !== undefined && entry.apiRoute === "unknown") ||
					(Object.keys(entry.reportedCost).length > 0 &&
						(entry.reportedCost.input === undefined ||
							entry.reportedCost.output === undefined ||
							entry.reportedCost.cacheRead === undefined ||
							entry.reportedCost.cacheWrite === undefined))
				) {
					needsMoreMetadata = true;
					break;
				}
			}
			if (!needsMoreMetadata) {
				break;
			}
		}
		if (deduped.size === 0) {
			if (metadataFailure) {
				warnLiteLLMMetadataFallback(managementBaseUrl, metadataFailure);
			}
			return null;
		}
		return Array.from(deduped.values())
			.map(entry => entry.model)
			.sort((left, right) => left.id.localeCompare(right.id));
	};
	if (options.signal !== undefined) {
		return fetchModels(options.signal);
	}
	return options.timeoutMs !== undefined ? withCatalogDiscoveryTimeout(options.timeoutMs, fetchModels) : fetchModels();
}

export async function fetchLiteLLMRichModels<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	return fetchLiteLLMRichModelsInternal(options);
}

export function litellmModelManagerOptions(config?: LiteLLMModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("litellm")!;
	return {
		providerId: "litellm",
		// rich-v8 invalidates rows whose `compatConfig` retained a colliding
		// bundled model's provider-specific transport (e.g. Fireworks
		// `wireModelIdMode`) before that leak was fixed. Earlier versions added
		// bundled reference fallback, moved OpenAI models to Responses, continued
		// past incomplete vision/API metadata and endpoints omitting cache
		// pricing, stripped reseller usage suffixes, filtered placeholder rows,
		// and mapped rich pricing. Bump the version whenever these mappers change,
		// or warm authoritative caches keep serving pre-change rows for the full TTL.
		cacheProviderId: resolveModelCacheProviderId("litellm", { baseUrl }),
		// litellm is a local-only proxy and is never bundled in models.json (that
		// would leak the machine's localhost catalog). Prefer the proxy's richer
		// management metadata, then enrich ids against models.dev with the bundled
		// catalog as a fallback before using /v1/models.
		fetchDynamicModels: async () => {
			const modelsDevReferences = await loadModelsDevReferences<Api>(config?.fetch);
			const resolveReference = createReferenceResolver(modelsDevReferences);
			const richModels = await fetchLiteLLMRichModels<Api>({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
				referenceResolver: resolveReference,
				resolveApi: resolveLiteLLMApi,
				timeoutMs: 10_000,
			});
			if (richModels && richModels.length > 0) {
				return richModels;
			}
			return fetchOpenAICompatibleModels<Api>({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) =>
					mapLiteLLMOpenAICompatibleModel(entry, defaults, resolveReference(defaults.id)),
				fetch: config?.fetch,
			});
		},
	};
}

// ---------------------------------------------------------------------------
// 22. vLLM
// ---------------------------------------------------------------------------

const VLLM_DISCOVERY_TIMEOUT_MS = 10_000;

export interface VllmModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!;
	const references = createBundledReferenceMap<"openai-completions">("vllm" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "vllm",
		cacheProviderId: resolveModelCacheProviderId("vllm", { baseUrl }),
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "vllm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const model = mapWithBundledReference(entry, defaults, references.get(defaults.id));
					const identity = classifyModel("vllm", model.id, { lenient: true });
					return {
						...model,
						contextWindow: toPositiveNumber(entry.max_model_len, model.contextWindow),
						// vLLM's /v1/models reports no reasoning capability. Qwen 3.8+
						// open weights always think (the template cannot disable it), so
						// light up the effort dial; buildModel derives the template
						// ladder from the id + local-backend compat.
						reasoning:
							model.reasoning || (identity.class === "qwen" && revisionAtLeast(identity.revision, "3.8")),
					};
				},
				fetch: config?.fetch,
				timeoutMs: VLLM_DISCOVERY_TIMEOUT_MS,
			}),
	};
}

// ---------------------------------------------------------------------------
// 23. NanoGPT
// ---------------------------------------------------------------------------

export interface NanoGptModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nanoGptModelManagerOptions(
	config?: NanoGptModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://nano-gpt.com/api/v1";
	const resolveReference = createReferenceResolver(() =>
		createBundledReferenceMap<"openai-completions">("nanogpt" as Parameters<typeof getBundledModels>[0]),
	);
	return {
		providerId: "nanogpt",
		...(apiKey && {
			fetchDynamicModels: async () => {
				// Track base IDs that have :thinking variants so we can mark them reasoning-capable.
				const thinkingBaseIds = new Set<string>();
				const models = await fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "nanogpt",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = resolveReference(defaults.id);
						const mapped = mapWithBundledReference(entry, defaults, reference);
						return { ...mapped, api: "openai-completions", provider: "nanogpt" };
					},
					filterModel: (_entry, model) => {
						const match = NANO_GPT_THINKING_SUFFIX_RE.exec(model.id);
						if (match) {
							thinkingBaseIds.add(model.id.slice(0, match.index));
							return false;
						}
						return isLikelyNanoGptTextModelId(model.id);
					},
					fetch: config?.fetch,
				});
				if (!models) return null;
				// Mark base models as reasoning-capable when a :thinking variant existed.
				for (const model of models) {
					if (!model.reasoning && thinkingBaseIds.has(model.id)) {
						(model as { reasoning: boolean }).reasoning = true;
					}
				}
				return models;
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 24. GitHub Copilot
// ---------------------------------------------------------------------------

export interface GithubCopilotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const COPILOT_CACHE_INVALIDATED_MODEL_IDS = [
	"grok-4.5",
	"grok-4.5-1m",
	"grok-4.6",
	"grok-4.6-1m",
	"mai-code-1-flash-picker",
];

function inferCopilotApi(modelId: string): Api {
	const route = apiRouteFor("github-copilot", modelId);
	if (route?.api === "anthropic-messages" || route?.api === "openai-responses") return route.api;
	return "openai-completions";
}

function extractCopilotLimits(entry: OpenAICompatibleModelRecord): {
	maxPromptTokens?: number;
	maxContextWindowTokens?: number;
	maxOutputTokens?: number;
	maxNonStreamingOutputTokens?: number;
} {
	if (!isRecord(entry.capabilities)) {
		return {};
	}
	const limitsValue = entry.capabilities.limits;
	if (!isRecord(limitsValue)) {
		return {};
	}
	return {
		maxPromptTokens: toNumber(limitsValue.max_prompt_tokens),
		maxContextWindowTokens: toNumber(limitsValue.max_context_window_tokens),
		maxOutputTokens: toNumber(limitsValue.max_output_tokens),
		maxNonStreamingOutputTokens: toNumber(limitsValue.max_non_streaming_output_tokens),
	};
}

/** Local id/name suffixes for synthesized Copilot long-context variants. */
export const COPILOT_LONG_CONTEXT_ID_SUFFIX = "-1m";
const COPILOT_LONG_CONTEXT_NAME_SUFFIX = " (1M)";

/** One tier of Copilot token pricing (`billing.token_prices.{default,long_context}`). Prices are hundredths of a dollar per 1M tokens. */
interface CopilotTokenPriceTier {
	contextMax?: number;
	inputPrice?: number;
	outputPrice?: number;
	cachePrice?: number;
}

function parseCopilotTokenPriceTier(value: unknown): CopilotTokenPriceTier | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		contextMax: toNumber(value.context_max),
		inputPrice: toNumber(value.input_price),
		outputPrice: toNumber(value.output_price),
		cachePrice: toNumber(value.cache_price),
	};
}

/**
 * Tiered context boundaries/prices from `billing.token_prices`. Served only
 * when discovery requests `X-GitHub-Api-Version` ≥ 2026-06-01; absent on the
 * legacy response shape (where `capabilities.limits` is already tier-capped).
 */
function extractCopilotTokenPrices(entry: OpenAICompatibleModelRecord): {
	defaultTier?: CopilotTokenPriceTier;
	longContext?: CopilotTokenPriceTier;
} {
	if (!isRecord(entry.billing)) {
		return {};
	}
	const tokenPrices = entry.billing.token_prices;
	if (!isRecord(tokenPrices)) {
		return {};
	}
	return {
		defaultTier: parseCopilotTokenPriceTier(tokenPrices.default),
		longContext: parseCopilotTokenPriceTier(tokenPrices.long_context),
	};
}

function extractCopilotSupportsVision(entry: OpenAICompatibleModelRecord): boolean | undefined {
	if (!isRecord(entry.capabilities)) {
		return undefined;
	}
	const supports = entry.capabilities.supports;
	if (!isRecord(supports)) {
		return undefined;
	}
	return toBoolean(supports.vision);
}

/** Copilot's `/models` mixes chat and embedding models; only `type: "chat"` entries are usable here. */
function isCopilotChatModel(entry: OpenAICompatibleModelRecord): boolean {
	if (!isRecord(entry.capabilities)) {
		return true;
	}
	const type = entry.capabilities.type;
	return typeof type !== "string" || type === "chat";
}

function copilotTierCost(
	tier: CopilotTokenPriceTier | undefined,
): Omit<ModelSpec<Api>["cost"], "cacheWrite"> | undefined {
	if (tier?.inputPrice === undefined || tier.outputPrice === undefined) {
		return undefined;
	}
	return {
		input: tier.inputPrice / 100,
		output: tier.outputPrice / 100,
		cacheRead: (tier.cachePrice ?? 0) / 100,
	};
}

/**
 * Synthesize the opt-in long-context sibling for a Copilot model that reports
 * a `billing.token_prices.long_context` tier (e.g. Claude Opus 200k → 1M, as
 * selectable in copilot-cli). The variant is a local catalog entry: it keeps
 * the upstream model id on the wire via `requestModelId` — the tier is purely
 * a client-side context budget with its own pricing, not a served model id.
 * The base entry stays on the default tier so nobody silently pays
 * long-context rates.
 */
function createCopilotLongContextVariant(
	base: ModelSpec<Api>,
	fullContextWindow: number | null,
	maxTokens: number | null,
	longContext: CopilotTokenPriceTier | undefined,
): ModelSpec<Api> | undefined {
	const longContextMax = longContext?.contextMax;
	if (longContextMax === undefined || longContextMax <= 0 || fullContextWindow === null || maxTokens === null) {
		return undefined;
	}
	const variantWindow = Math.min(fullContextWindow, longContextMax + maxTokens);
	if (base.contextWindow === null || variantWindow <= base.contextWindow) {
		return undefined;
	}
	const longCost = copilotTierCost(longContext);
	return {
		...base,
		id: `${base.id}${COPILOT_LONG_CONTEXT_ID_SUFFIX}`,
		requestModelId: base.id,
		name: `${base.name}${COPILOT_LONG_CONTEXT_NAME_SUFFIX}`,
		contextWindow: variantWindow,
		// Long-context tier has its own token prices (Gemini/GPT bill ~2x above
		// the default boundary). cacheWrite is not reported per tier; inherit.
		...(longCost && { cost: { ...longCost, cacheWrite: base.cost.cacheWrite } }),
		contextPromotionTarget: undefined,
	};
}

export function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api> {
	const rawApiKey = config?.apiKey;
	const configuredBaseUrl = config?.baseUrl ?? "https://api.githubcopilot.com";
	const parsedApiKey = rawApiKey ? parseGitHubCopilotApiKey(rawApiKey) : undefined;
	const apiKey = parsedApiKey?.accessToken;
	const baseUrl =
		parsedApiKey?.apiEndpoint && configuredBaseUrl.includes("githubcopilot.com")
			? parsedApiKey.apiEndpoint
			: parsedApiKey?.enterpriseUrl && configuredBaseUrl.includes("githubcopilot.com")
				? getGitHubCopilotBaseUrl(parsedApiKey.enterpriseUrl)
				: configuredBaseUrl;
	let providerReferences: Map<string, ModelSpec<Api>> | undefined;
	const getProviderReferences = () => (providerReferences ??= createBundledReferenceMap<Api>("github-copilot"));
	const resolveReference = createReferenceResolver(getProviderReferences);
	return {
		providerId: "github-copilot",
		cacheProviderId: resolveModelCacheProviderId("github-copilot", { apiKey: rawApiKey, baseUrl }),
		dropCachedModelIdsOnStaticMismatch: COPILOT_CACHE_INVALIDATED_MODEL_IDS,
		// COPILOT_API_HEADERS are compile-time wire identity constants, not
		// credentials. The cache omits all request headers for
		// safety and can only restore them from a bundled static entry — so a
		// Copilot model with no bundled reference (e.g. a freshly served
		// claude-opus-5 and its synthesized -1m sibling) is dropped on offline
		// reads. Declaring the constant lets the cache restore it by value.
		restorableHeaderFallback: { ...COPILOT_API_HEADERS },
		...(apiKey && {
			fetchDynamicModels: async () => {
				const fetchImpl = discoveryFetch(config?.fetch);
				const requestBaseUrl = isPersonalGitHubCopilotBaseUrl(baseUrl)
					? ((await withCatalogDiscoveryTimeout(DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS, signal =>
							discoverGitHubCopilotApiEndpoint(apiKey, fetchImpl, signal),
						)) ?? baseUrl)
					: baseUrl;
				const longContextVariants: ModelSpec<Api>[] = [];
				const models = await fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl: requestBaseUrl,
					apiKey,
					headers: COPILOT_DISCOVERY_HEADERS,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<Api>,
						_context: OpenAICompatibleModelMapperContext<Api>,
					): ModelSpec<Api> | null => {
						if (!isCopilotChatModel(entry)) {
							return null;
						}
						const reference = resolveReference(defaults.id);
						const copilotLimits = extractCopilotLimits(entry);
						// Copilot exposes token limits under capabilities.limits.*.
						// max_context_window_tokens is the model's total usable window;
						// max_prompt_tokens is Copilot's prompt/summarization budget and
						// must only be a fallback when total-window fields are absent.
						const contextWindow = toPositiveNumber(
							copilotLimits.maxContextWindowTokens,
							toPositiveNumber(
								entry.context_length,
								toPositiveNumber(
									copilotLimits.maxPromptTokens,
									reference?.contextWindow ?? defaults.contextWindow,
								),
							),
						);
						const maxTokens = toPositiveNumber(
							copilotLimits.maxOutputTokens,
							toPositiveNumber(
								entry.max_completion_tokens,
								toPositiveNumber(
									copilotLimits.maxNonStreamingOutputTokens,
									reference?.maxTokens ?? defaults.maxTokens,
								),
							),
						);
						const name =
							typeof entry.name === "string" && entry.name.trim().length > 0
								? entry.name
								: (reference?.name ?? defaults.name);
						const api = inferCopilotApi(defaults.id);
						const supportsVision = extractCopilotSupportsVision(entry);
						const input: ModelSpec<Api>["input"] =
							supportsVision === true
								? ["text", "image"]
								: supportsVision === false || !isPersonalGitHubCopilotBaseUrl(requestBaseUrl)
									? ["text"]
									: (reference?.input ?? defaults.input);
						// With COPILOT_API_HEADERS the served window is the long-context
						// ceiling; the default tier ends at token_prices.default.context_max
						// prompt tokens. Cap the base entry to the default tier — the long
						// tier is the opt-in `-1m` sibling below.
						const tokenPrices = extractCopilotTokenPrices(entry);
						const defaultContextMax = tokenPrices.defaultTier?.contextMax;
						const defaultTierWindow =
							defaultContextMax !== undefined &&
							defaultContextMax > 0 &&
							contextWindow !== null &&
							maxTokens !== null
								? Math.min(contextWindow, defaultContextMax + maxTokens)
								: contextWindow;
						const unreferencedIdentity =
							reference === undefined && api === "anthropic-messages"
								? classifyModel("github-copilot", defaults.id, { lenient: true })
								: undefined;
						const base: ModelSpec<Api> = reference
							? {
									...reference,
									api,
									provider: "github-copilot",
									baseUrl: requestBaseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: mergeCopilotApiHeaders(getProviderReferences().get(defaults.id)?.headers),
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								}
							: {
									...defaults,
									api,
									baseUrl: requestBaseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: mergeCopilotApiHeaders(),
									// Copilot's `/models` advertises no reasoning bit, so a
									// thinking-capable Claude with no bundled reference would
									// fall back to `reasoning: false` and lose its effort dial.
									// Gate on the id classifier (not the transport alone) so a
									// lagging enterprise catalog serving a pre-thinking Claude
									// (<= 3.5) over the Messages proxy is not handed a fabricated
									// dial it would reject; a modern reference-less model (e.g.
									// claude-opus-5) is marked so `buildModel` derives the ladder.
									...(unreferencedIdentity?.class === "anthropic" &&
									revisionAtLeast(unreferencedIdentity.revision, "3.7")
										? { reasoning: true }
										: {}),
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								};
						const defaultCost = copilotTierCost(tokenPrices.defaultTier);
						if (defaultCost) {
							// Cache writes are not reported per tier; retain the bundled provider rate.
							base.cost = { ...defaultCost, cacheWrite: base.cost.cacheWrite };
						}
						const variant = createCopilotLongContextVariant(
							base,
							contextWindow,
							maxTokens,
							tokenPrices.longContext,
						);
						if (variant) {
							longContextVariants.push(variant);
							// Overflowing the default tier promotes into the 1M sibling
							// unless the reference already pins a target.
							base.contextPromotionTarget ??= `github-copilot/${variant.id}`;
						}
						return base;
					},
					fetch: fetchImpl,
				});
				if (models === null) {
					return null;
				}
				// Append synthesized tiers; a real upstream id always wins over a
				// local variant with the same id.
				const takenIds = new Set(models.map(model => model.id));
				for (const variant of longContextVariants) {
					if (takenIds.has(variant.id)) {
						continue;
					}
					takenIds.add(variant.id);
					models.push(variant);
				}
				return models.sort((left, right) => left.id.localeCompare(right.id));
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 24. Anthropic
// ---------------------------------------------------------------------------

export interface AnthropicModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function anthropicModelManagerOptions(
	config?: AnthropicModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	// The registry derives `config.baseUrl` from an existing bundled model, and
	// bundled Anthropic rows use both `https://api.anthropic.com` and `.../v1`.
	// Discovery must always hit `/v1/models`, so the `/v1` suffix is enforced on
	// the discovery URL while model rows keep the provider base (#6563).
	const baseUrl = normalizeAnthropicBaseUrl(config?.baseUrl, ANTHROPIC_BASE_URL);
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	return {
		providerId: "anthropic",
		modelsDev: {
			fetch: () => fetchRevalidatedWellKnownModelsWithTimeout(config?.fetch),
			map: payload => mapAnthropicModelsDev(payload, baseUrl),
		},
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevModels = await fetchWellKnownModels(config?.fetch)
					.then(payload => mapAnthropicModelsDev(payload, baseUrl))
					.catch(() => []);
				const references = buildAnthropicReferenceMap(modelsDevModels);
				return (
					fetchOpenAICompatibleModels({
						api: "anthropic-messages",
						provider: "anthropic",
						baseUrl: discoveryBaseUrl,
						headers: buildAnthropicDiscoveryHeaders(apiKey),
						mapModel: (
							entry: OpenAICompatibleModelRecord,
							defaults: ModelSpec<"anthropic-messages">,
							_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
						): ModelSpec<"anthropic-messages"> => {
							const discoveredName = typeof entry.display_name === "string" ? entry.display_name : defaults.name;
							const reference = references.get(defaults.id);
							if (!reference) {
								return {
									...defaults,
									name: discoveredName,
									baseUrl,
								};
							}
							return {
								...reference,
								id: defaults.id,
								name: discoveredName,
								api: "anthropic-messages",
								provider: "anthropic",
								baseUrl,
							};
						},
						fetch: config?.fetch,
					}) ?? null
				);
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// Models.dev provider descriptors for generate-models.ts
// ---------------------------------------------------------------------------

/** Describes how to map models.dev API data for a single provider. */
export interface ModelsDevProviderDescriptor {
	/** Key in the models.dev API response JSON (e.g., "anthropic", "amazon-bedrock") */
	modelsDevKey: string;
	/** Provider ID in our system */
	providerId: string;
	/** Default API type for this provider's models */
	api: Api;
	/** Default base URL */
	baseUrl: string;
	/** Default context window fallback (default: UNKNNOWN_CONTEXT_WINDOW) */
	defaultContextWindow?: number;
	/** Default max tokens fallback (default: UNKNNOWN_MAX_TOKENS) */
	defaultMaxTokens?: number;
	/** Optional compat overrides applied to every model from this provider */
	compat?: ModelSpec<Api>["compat"];
	/** Optional static headers applied to every model */
	headers?: Record<string, string>;
	/**
	 * Optional filter: return false to skip a model.
	 * Called with (modelId, rawModel). Default: skip if tool_call !== true.
	 */
	filterModel?: (modelId: string, model: ModelsDevModel) => boolean;
	/**
	 * Optional transform: modify the mapped model before it's added.
	 * Can return null to skip the model, or an array to emit multiple models.
	 */
	transformModel?: (
		model: ModelSpec<Api>,
		modelId: string,
		raw: ModelsDevModel,
	) => ModelSpec<Api> | ModelSpec<Api>[] | null;
	/**
	 * Optional: override the API type per-model.
	 * Called with (modelId, raw). Return the API type to use.
	 * If not provided, uses the `api` field.
	 */
	resolveApi?: (modelId: string, raw: ModelsDevModel) => { api: Api; baseUrl: string } | null;
}

/** Generic mapper that converts models.dev data using provider descriptors. */
export function mapModelsDevToModels(
	data: Record<string, unknown>,
	descriptors: readonly ModelsDevProviderDescriptor[],
): ModelSpec<Api>[] {
	const models: ModelSpec<Api>[] = [];
	for (const desc of descriptors) {
		const providerData = (data as Record<string, Record<string, unknown>>)[desc.modelsDevKey];
		if (!isRecord(providerData) || !isRecord(providerData.models)) continue;

		for (const [modelId, rawModel] of Object.entries(providerData.models)) {
			if (!isRecord(rawModel)) continue;
			const m = rawModel as ModelsDevModel;

			// Default filter: tool_call must be true
			if (desc.filterModel) {
				if (!desc.filterModel(modelId, m)) continue;
			} else {
				if (m.tool_call !== true) continue;
			}

			// Resolve API and baseUrl (may be per-model for providers like OpenCode)
			const resolved = desc.resolveApi?.(modelId, m) ?? { api: desc.api, baseUrl: desc.baseUrl };
			if (!resolved) continue;

			const mapped: ModelSpec<Api> = {
				id: modelId,
				name: toModelName(m.name, modelId),
				api: resolved.api,
				provider: desc.providerId as ModelSpec<Api>["provider"],
				baseUrl: resolved.baseUrl,
				reasoning: m.reasoning === true,
				input: toInputCapabilities(m.modalities?.input),
				cost: {
					input: toNumber(m.cost?.input) ?? 0,
					output: toNumber(m.cost?.output) ?? 0,
					cacheRead: toNumber(m.cost?.cache_read) ?? 0,
					cacheWrite: toNumber(m.cost?.cache_write) ?? 0,
				},
				contextWindow: toPositiveNumber(m.limit?.context, desc.defaultContextWindow ?? null),
				maxTokens: toPositiveNumber(m.limit?.output, desc.defaultMaxTokens ?? null),
				...(m.tool_call === false ? { supportsTools: false } : {}),
				...(desc.compat && { compat: desc.compat }),
				...(desc.headers && { headers: { ...desc.headers } }),
			};

			// Apply per-model transform
			if (desc.transformModel) {
				const result = desc.transformModel(mapped, modelId, m);
				if (result === null) continue;
				if (Array.isArray(result)) {
					models.push(...result);
				} else {
					models.push(result);
				}
			} else {
				models.push(mapped);
			}
		}
	}
	return models;
}

// Bedrock cross-region prefix helpers
const BEDROCK_GLOBAL_PREFIXES = [
	"anthropic.claude-fable-5",
	"anthropic.claude-mythos-5",
	"anthropic.claude-haiku-4-5",
	"anthropic.claude-sonnet-4",
	"anthropic.claude-opus-4-5",
	"amazon.nova-2-lite",
	"cohere.embed-v4",
	"twelvelabs.pegasus-1-2",
];

const BEDROCK_US_PREFIXES = [
	"amazon.nova-lite",
	"amazon.nova-micro",
	"amazon.nova-premier",
	"amazon.nova-pro",
	"anthropic.claude-3-7-sonnet",
	"anthropic.claude-opus-4-1",
	"anthropic.claude-opus-4-20250514",
	"deepseek.r1",
	"meta.llama3-2",
	"meta.llama3-3",
	"meta.llama4",
];

function bedrockCrossRegionId(id: string): string {
	if (BEDROCK_GLOBAL_PREFIXES.some(p => id.startsWith(p))) return `global.${id}`;
	if (BEDROCK_US_PREFIXES.some(p => id.startsWith(p))) return `us.${id}`;
	return id;
}

interface ApiResolutionRule {
	matches: (modelId: string, raw: ModelsDevModel) => boolean;
	resolved: { api: Api; baseUrl: string };
}

function resolveApiByRules(
	modelId: string,
	raw: ModelsDevModel,
	rules: readonly ApiResolutionRule[],
	fallback: { api: Api; baseUrl: string },
): { api: Api; baseUrl: string } {
	for (const rule of rules) {
		if (rule.matches(modelId, raw)) return rule.resolved;
	}
	return fallback;
}

function createOpenCodeApiResolution(
	basePath: string,
	providerId: "opencode-zen" | "opencode-go",
): {
	defaultResolution: { api: Api; baseUrl: string };
	rules: ApiResolutionRule[];
} {
	const completionsBaseUrl = `${basePath}/v1`;
	// Per-API base URLs on the OpenCode-style endpoint:
	// - openai-completions / openai-responses / google-generative-ai → /v1
	// - anthropic-messages → bare basePath (the Anthropic client appends /v1/messages)
	const baseUrlForApi = (api: Api): string => (api === "anthropic-messages" ? basePath : completionsBaseUrl);
	// Per-id route pins live in the `api-routes` behavior rules.
	const overrideRules: ApiResolutionRule[] = (
		["openai-completions", "openai-responses", "anthropic-messages"] as const
	).map(api => ({
		matches: modelId => apiRouteFor(providerId, modelId)?.api === api,
		resolved: { api, baseUrl: baseUrlForApi(api) },
	}));
	return {
		defaultResolution: { api: "openai-completions", baseUrl: completionsBaseUrl },
		rules: [
			// Per-id overrides take precedence over npm-based heuristics so we can
			// correct upstream metadata mismatches (see OPENCODE_GO_API_RESOLUTION).
			...overrideRules,
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/openai",
				resolved: { api: "openai-responses", baseUrl: completionsBaseUrl },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/anthropic",
				resolved: { api: "anthropic-messages", baseUrl: basePath },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/google",
				resolved: { api: "google-generative-ai", baseUrl: completionsBaseUrl },
			},
		],
	};
}

// Resolver rules for the models.dev descriptor path; the per-id pins live in
// the `api-routes` behavior rules, which also drive the live-discovery mapper.
const OPENCODE_ZEN_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen", "opencode-zen");
const OPENCODE_GO_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen/go", "opencode-go");

const COPILOT_BASE_URL = "https://api.githubcopilot.com";

const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
// The `zai` catalog provider is the GLM Coding Plan: `/login zai` validates and
// stores credentials against the coding-plan endpoint (see registry/zai.ts), so
// the native OpenAI transport must ride the coding-plan base rather than the
// general PAYG `/api/paas/v4`, which would bypass plan quota or fail auth.
const ZAI_OPENAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/** Resolves the transport and endpoint for one Z.AI model catalog entry. */
export function resolveZaiApi(modelId: string): { api: "anthropic-messages" | "openai-completions"; baseUrl: string } {
	const api = apiRouteFor("zai", modelId)?.api ?? "anthropic-messages";
	switch (api) {
		case "anthropic-messages":
			return { api, baseUrl: ZAI_ANTHROPIC_BASE_URL };
		case "openai-completions":
			return { api, baseUrl: ZAI_OPENAI_BASE_URL };
		default:
			throw new Error(`Unsupported Z.AI API route: ${api}`);
	}
}

const COPILOT_DEFAULT_RESOLUTION = {
	api: "openai-completions",
	baseUrl: COPILOT_BASE_URL,
} as const satisfies { api: Api; baseUrl: string };

const COPILOT_API_RESOLUTION_RULES: readonly ApiResolutionRule[] = [
	{
		matches: modelId => apiRouteFor("github-copilot", modelId)?.api === "anthropic-messages",
		resolved: { api: "anthropic-messages", baseUrl: COPILOT_BASE_URL },
	},
	{
		matches: modelId => apiRouteFor("github-copilot", modelId)?.api === "openai-responses",
		resolved: { api: "openai-responses", baseUrl: COPILOT_BASE_URL },
	},
];

function simpleModelsDevDescriptor(
	modelsDevKey: string,
	providerId: string,
	api: Api,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return {
		modelsDevKey,
		providerId,
		api,
		baseUrl,
		...options,
	};
}

function openAiCompletionsDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-completions", baseUrl, options);
}

function openAiResponsesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-responses", baseUrl, options);
}

function anthropicMessagesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "anthropic-messages", baseUrl, options);
}

const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_VERTEX_OPENAI_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi";
const GOOGLE_VERTEX_ANTHROPIC_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict";

function resolveGoogleVertexApi(modelId: string, raw: ModelsDevModel): { api: Api; baseUrl: string } {
	if (raw.provider?.npm === "@ai-sdk/google-vertex/anthropic") {
		return {
			api: "anthropic-messages",
			baseUrl: GOOGLE_VERTEX_ANTHROPIC_BASE_URL.replace("{model}", modelId),
		};
	}
	if (modelId.includes("/") || raw.provider?.npm === "@ai-sdk/openai-compatible") {
		return { api: "openai-completions", baseUrl: GOOGLE_VERTEX_OPENAI_BASE_URL };
	}
	return { api: "google-vertex", baseUrl: GOOGLE_VERTEX_BASE_URL };
}

const MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK: readonly ModelsDevProviderDescriptor[] = [
	// --- Amazon Bedrock ---
	{
		modelsDevKey: "amazon-bedrock",
		providerId: "amazon-bedrock",
		api: "bedrock-converse-stream",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		filterModel: (id, m) => {
			// Undrivable SKUs are rule-owned (`runtime/behavior.kdl` exclude-models).
			return m.tool_call === true && !isExcludedModel("amazon-bedrock", id);
		},
		transformModel: (model, modelId, m) => {
			const crossRegionId = bedrockCrossRegionId(modelId);
			const bedrockModel: ModelSpec<Api> = {
				...model,
				id: crossRegionId,
				name: toModelName(m.name, crossRegionId),
			};
			// Also emit EU and AWS GovCloud (`us-gov.`) geo inference-profile
			// variants for Claude models. GovCloud accounts list system profiles
			// under the `us-gov.` prefix (e.g. us-gov.anthropic.claude-sonnet-4-5-…);
			// without these rows the catalog only has commercial geos (`us.`/`eu.`/…)
			// and model resolution rejects the GovCloud id (or misroutes commercial
			// geos onto us-east-1 with GovCloud credentials → 403).
			// Fan out only bare vendor-namespaced source ids (`anthropic.<model>`);
			// ids already carrying a geo prefix (`us.`/`eu.`/`global.`/`au.`…)
			// are this fan-out's own output shape.
			if (modelId.split(".", 1)[0] === "anthropic") {
				const displayName = toModelName(m.name, modelId);
				return [
					bedrockModel,
					{
						...bedrockModel,
						id: `eu.${modelId}`,
						name: `${displayName} (EU)`,
					},
					{
						...bedrockModel,
						id: `us-gov.${modelId}`,
						name: `${displayName} (GovCloud)`,
					},
				];
			}
			return bedrockModel;
		},
	},
];

const CLINEPASS_REASONING_BUDGET_RATIOS: Readonly<Record<Effort, number>> = {
	[Effort.Minimal]: 0.1,
	[Effort.Low]: 0.2,
	[Effort.Medium]: 0.5,
	[Effort.High]: 0.8,
	[Effort.XHigh]: 0.95,
	[Effort.Max]: 1,
};

function buildClinePassThinking(raw: ModelsDevModel, model: ModelSpec<Api>): ThinkingConfig | undefined {
	const effortValues = raw.reasoning_options?.find(option => option.type === "effort")?.values;
	if (effortValues) {
		const efforts = THINKING_EFFORTS.filter(effort => effortValues.includes(effort));
		return efforts.length > 0 ? { mode: "effort", efforts } : undefined;
	}

	const budget = raw.reasoning_options?.find(option => option.type === "budget_tokens");
	if (!budget) return undefined;
	const modelMaxTokens = model.maxTokens ?? CLINEPASS_FALLBACK_MAX_TOKENS;
	const maximum = toPositiveNumber(budget.max, modelMaxTokens) ?? modelMaxTokens;
	const minimum = toPositiveNumber(budget.min, 1) ?? 1;
	const scale = Math.min(modelMaxTokens, maximum);
	return {
		mode: "budget",
		efforts: THINKING_EFFORTS,
		effortBudgets: Object.fromEntries(
			THINKING_EFFORTS.map(effort => [
				effort,
				Math.min(Math.max(Math.floor(scale * CLINEPASS_REASONING_BUDGET_RATIOS[effort]), minimum), maximum),
			]),
		),
	};
}

/**
 * DeepSeek's V4-generation lineage (`v4`, `v4-flash`, `v4.1-pro`) by
 * structured family. The native roster serves only V4-era SKUs today; the
 * `tool_call` gate on the descriptor filters the rest.
 */
function isDeepseekV4Generation(providerId: string, modelId: string): boolean {
	const identity = classifyModel(providerId, modelId, { lenient: true });
	if (identity.class !== "deepseek") return false;
	return identity.family === "v4" || identity.family === "flash" || identity.family === "pro";
}

const MODELS_DEV_PROVIDER_DESCRIPTORS_CORE: readonly ModelsDevProviderDescriptor[] = [
	// --- Anthropic ---
	anthropicMessagesDescriptor("anthropic", "anthropic", "https://api.anthropic.com", {
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			return !isExcludedModel("anthropic", id);
		},
	}),
	// --- Google ---
	simpleModelsDevDescriptor(
		"google",
		"google",
		"google-generative-ai",
		"https://generativelanguage.googleapis.com/v1beta",
	),
	// --- OpenAI ---
	simpleModelsDevDescriptor("openai", "openai", "openai-responses", "https://api.openai.com/v1"),
	// --- Groq ---
	openAiCompletionsDescriptor("groq", "groq", "https://api.groq.com/openai/v1"),
	// --- Cerebras ---
	openAiCompletionsDescriptor("cerebras", "cerebras", "https://api.cerebras.ai/v1"),
	// --- ClinePass ---
	// The live roster owns membership; this snapshot pins Cline's exact limits,
	// pricing, modalities, and per-model reasoning controls for known ids.
	openAiCompletionsDescriptor("cline-pass", "cline-pass", "https://api.cline.bot/api/v1", {
		transformModel: (model, modelId, raw) => {
			const id = toClinePassPublicModelId(modelId);
			const metadata = getClinePassModelMetadata(id);
			if (metadata) {
				return {
					...model,
					id,
					name: metadata.name,
					contextWindow: metadata.contextWindow,
					maxTokens: metadata.maxTokens,
					input: metadata.input,
					cost: metadata.cost,
					reasoning: metadata.reasoning,
					thinking: metadata.thinking,
					compat:
						metadata.thinking === undefined ? { ...model.compat, supportsReasoningEffort: false } : model.compat,
				};
			}
			return {
				...model,
				id,
				thinking: model.reasoning ? buildClinePassThinking(raw, model) : undefined,
			};
		},
	}),
	// --- Together ---
	openAiCompletionsDescriptor("togetherai", "together", "https://api.together.xyz/v1"),
	// --- CoreWeave Serverless Inference ---
	openAiCompletionsDescriptor("wandb", "coreweave", "https://api.inference.wandb.ai/v1", {
		transformModel: model => {
			// CoreWeave's roster omits the reasoning bit for gpt-oss; flag it and
			// let the class rules own the effort ladder.
			if (classifyModel("coreweave", model.id, { lenient: true }).class !== "gpt-oss") {
				return model;
			}
			return { ...model, reasoning: true };
		},
	}),
	// --- NVIDIA ---
	openAiCompletionsDescriptor("nvidia", "nvidia", "https://integrate.api.nvidia.com/v1", {
		defaultContextWindow: 131072,
	}),
	// --- xAI ---
	openAiResponsesDescriptor("xai", "xai", "https://api.x.ai/v1", {
		transformModel: model => applyXaiResponsesThinkingPolicy(model as ModelSpec<"openai-responses">),
	}),
	// --- DeepSeek ---
	openAiCompletionsDescriptor("deepseek", "deepseek", "https://api.deepseek.com", {
		// Only ship the v4 family as built-ins; older deepseek-chat / deepseek-reasoner
		// ids are kept off the catalog until the issue thread asks for them.
		filterModel: (id, m) => m.tool_call === true && isDeepseekV4Generation("deepseek", id),
		compat: {
			// DeepSeek V4 effort remapping is derived in model-thinking metadata; this
			// descriptor keeps only transport-shape compat.
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			// DeepSeek V4 thinking mode rejects the `tool_choice` control parameter.
			// Tool calls still work without it; the API defaults to auto when tools exist.
			supportsToolChoice: false,
			// DeepSeek V4's OpenAI format docs enable thinking with both the toggle and
			// reasoning_effort. Keep the toggle explicit for built-in models.
			extraBody: { thinking: { type: "enabled" } },
			// DeepSeek emits chain-of-thought via `reasoning_content` and requires it
			// to round-trip on assistant tool-call messages so the model can resume
			// from prior thinking (interleaved.field=reasoning_content on models.dev,
			// matches the kimi/openrouter handling already in detectCompat).
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			requiresAssistantContentForToolCalls: true,
		},
	}),
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS: readonly ModelsDevProviderDescriptor[] = [
	// --- zAI ---
	// Source the models.dev `zai` (pay-as-you-go) key rather than `zai-coding-plan`:
	// the coding-plan key reports all-$0 subscription rates, which surface every GLM
	// SKU as "Free" in `/models`. The PAYG key carries the real per-token rates for
	// the identical model ids, so the enumerated token costs line up with the other
	// subscription providers for comparison (issue #5598).
	anthropicMessagesDescriptor("zai", "zai", ZAI_ANTHROPIC_BASE_URL, {
		resolveApi: modelId => resolveZaiApi(modelId),
	}),
	// --- Umans AI ---
	// Source the pay-as-you-go catalog: the coding-plan key publishes subscription
	// costs as zero, while `/models/info` omits pricing entirely. The generator
	// overlays these rates onto the authoritative endpoint discovery (issue #5733).
	anthropicMessagesDescriptor("umans-ai", "umans", UMANS_BASE_URL),
	// --- Xiaomi ---
	openAiCompletionsDescriptor("xiaomi", "xiaomi", "https://api.xiaomimimo.com/v1", {
		defaultContextWindow: 262144,
		defaultMaxTokens: 8192,
		compat: {
			supportsStore: false,
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			allowsSyntheticReasoningContentForToolCalls: false,
		},
	}),
	// --- MiniMax Coding Plan ---
	openAiCompletionsDescriptor("minimax-coding-plan", "minimax-code", "https://api.minimax.io/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	openAiCompletionsDescriptor("minimax-cn-coding-plan", "minimax-code-cn", "https://api.minimaxi.com/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	// --- Alibaba Coding Plan ---
	openAiCompletionsDescriptor(
		"alibaba-coding-plan",
		"alibaba-coding-plan",
		"https://coding-intl.dashscope.aliyuncs.com/v1",
		{
			compat: {
				supportsDeveloperRole: false,
			},
		},
	),
	// --- Zhipu Coding Plan ---
	openAiCompletionsDescriptor(
		"zhipuai-coding-plan",
		"zhipu-coding-plan",
		"https://open.bigmodel.cn/api/coding/paas/v4",
		{
			compat: {
				thinkingFormat: "zai",
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		},
	),
];

const filterActiveToolCallModels = (_id: string, m: ModelsDevModel): boolean => {
	if (m.tool_call !== true) return false;
	if (m.status === "deprecated") return false;
	return true;
};

const MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX: readonly ModelsDevProviderDescriptor[] = [
	simpleModelsDevDescriptor("google-vertex", "google-vertex", "google-vertex", GOOGLE_VERTEX_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: resolveGoogleVertexApi,
	}),
];

const OPENCODE_MODELS_DEV_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	openAiCompletionsDescriptor("opencode", "opencode-zen", "https://opencode.ai/zen/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_ZEN_API_RESOLUTION.rules,
				OPENCODE_ZEN_API_RESOLUTION.defaultResolution,
			),
	}),
	openAiCompletionsDescriptor("opencode-go", "opencode-go", "https://opencode.ai/zen/go/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_GO_API_RESOLUTION.rules,
				OPENCODE_GO_API_RESOLUTION.defaultResolution,
			),
	}),
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED: readonly ModelsDevProviderDescriptor[] = [
	// --- Azure OpenAI ---
	// OpenAI-family models hosted on Azure, served via the Responses API. baseUrl
	// is empty: the deployment host is per-resource and resolved at runtime from
	// AZURE_OPENAI_BASE_URL / AZURE_OPENAI_RESOURCE_NAME (see resolveAzureConfig).
	simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", {
		filterModel: (modelId, m) => {
			if (m.tool_call !== true) return false;
			// OpenAI-family only (not Foundry/DeepSeek/Claude/Llama/Mistral/Phi, which
			// Azure serves via non-Responses APIs under a per-model provider override).
			return /^(gpt-|o1|o3|o4|codex|chatgpt)/.test(modelId);
		},
	}),
	// --- Cloudflare AI Gateway ---
	anthropicMessagesDescriptor(
		"cloudflare-ai-gateway",
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
	),
	openAiCompletionsDescriptor(
		"cloudflare-workers-ai",
		"cloudflare-ai-gateway",
		CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
		{
			filterModel: filterActiveToolCallModels,
			transformModel: model => ({ ...model, id: `workers-ai/${model.id}` }),
		},
	),
	// --- Mistral ---
	openAiCompletionsDescriptor("mistral", "mistral", "https://api.mistral.ai/v1"),
	// --- OpenCode Zen / Go ---
	...OPENCODE_MODELS_DEV_DESCRIPTORS,
	// --- GitHub Copilot ---
	openAiCompletionsDescriptor("github-copilot", "github-copilot", COPILOT_BASE_URL, {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
		headers: { ...COPILOT_API_HEADERS },
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(modelId, raw, COPILOT_API_RESOLUTION_RULES, COPILOT_DEFAULT_RESOLUTION),
		transformModel: model => {
			// compat only applies to openai-completions models
			if (model.api === "openai-completions") {
				return {
					...model,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				};
			}
			return model;
		},
	}),
	// --- MiniMax (Anthropic) ---
	anthropicMessagesDescriptor("minimax", "minimax", "https://api.minimax.io/anthropic"),
	anthropicMessagesDescriptor("minimax-cn", "minimax-cn", "https://api.minimaxi.com/anthropic"),
	// --- Hugging Face ---
	openAiCompletionsDescriptor("huggingface", "huggingface", "https://router.huggingface.co/v1"),
	// --- Kilo Gateway ---
	openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway"),
	// --- Moonshot AI ---
	openAiCompletionsDescriptor("moonshotai", "moonshot", "https://api.moonshot.ai/v1"),
	// --- NanoGPT ---
	openAiCompletionsDescriptor("nano-gpt", "nanogpt", "https://nano-gpt.com/api/v1"),
	// --- Synthetic ---
	openAiCompletionsDescriptor("synthetic", "synthetic", "https://api.synthetic.new/openai/v1"),
	// --- Venice AI ---
	openAiCompletionsDescriptor("venice", "venice", "https://api.venice.ai/api/v1", {
		transformModel: model => {
			const maxTokens = clampKimiK27CodeMaxTokens(model.id, model.maxTokens);
			return maxTokens === model.maxTokens ? model : { ...model, maxTokens };
		},
	}),
	// --- Ollama Cloud ---
	simpleModelsDevDescriptor("ollama-cloud", "ollama-cloud", "ollama-chat", "https://ollama.com"),
	// --- Xiaomi Token Plan ---
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-ams",
		"xiaomi-token-plan-ams",
		"https://token-plan-ams.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-cn",
		"xiaomi-token-plan-cn",
		"https://token-plan-cn.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-sgp",
		"xiaomi-token-plan-sgp",
		"https://token-plan-sgp.xiaomimimo.com/v1",
	),
	// --- Qwen Portal ---
	openAiCompletionsDescriptor("qwen-portal", "qwen-portal", "https://portal.qwen.ai/v1", {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
	}),

	// --- ZenMux ---
	openAiCompletionsDescriptor("zenmux", "zenmux", ZENMUX_OPENAI_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: modelId => {
			if (apiRouteFor("zenmux", modelId)?.api === "anthropic-messages") {
				return { api: "anthropic-messages" as const, baseUrl: ZENMUX_ANTHROPIC_BASE_URL };
			}
			return { api: "openai-completions" as const, baseUrl: ZENMUX_OPENAI_BASE_URL };
		},
	}),
];
/** All provider descriptors for models.dev data mapping in generate-models.ts. */
export const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	...MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CORE,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED,
];

const MODELS_DEV_DESCRIPTORS_BY_PROVIDER: Record<string, ModelsDevProviderDescriptor[]> = Object.create(null);
for (const descriptor of MODELS_DEV_PROVIDER_DESCRIPTORS) {
	const providerDescriptors = MODELS_DEV_DESCRIPTORS_BY_PROVIDER[descriptor.providerId];
	if (providerDescriptors) {
		providerDescriptors.push(descriptor);
	} else {
		MODELS_DEV_DESCRIPTORS_BY_PROVIDER[descriptor.providerId] = [descriptor];
	}
}

/** Providers whose bundled catalog can receive additive models.dev updates at runtime. */
export const MODELS_DEV_CATALOG_PROVIDER_IDS: readonly string[] = Object.freeze(
	Object.keys(MODELS_DEV_DESCRIPTORS_BY_PROVIDER),
);

/**
 * Build the shared models.dev fallback for one known provider.
 *
 * Provider managers sharing one fetch implementation reuse its conditional
 * catalog session. Each mapped provider slice is persisted independently so
 * startup can restore it without parsing the full catalog.
 *
 * `timeoutMs` bounds the catalog request. It is configurable for callers with a
 * stricter startup budget and for deterministic timeout tests.
 */
export function modelsDevCatalogFallback(
	providerId: string,
	fetchImpl?: FetchImpl,
	timeoutMs = DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
): ModelsDevFallback<Api> | undefined {
	const descriptors = MODELS_DEV_DESCRIPTORS_BY_PROVIDER[providerId];
	if (!descriptors) return undefined;
	return {
		additiveOnly: true,
		fetch: () => fetchRevalidatedWellKnownModelsWithTimeout(fetchImpl, timeoutMs),
		map: payload => (isRecord(payload) ? filterModelsDevCatalogRows(mapModelsDevToModels(payload, descriptors)) : []),
	};
}
